import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Queue } from 'bullmq';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { DOCUMENT_INGESTION_QUEUE } from './ingestion-queue.constants';
import type { CollectIngestionJobData, UploadIngestionJobData } from './ingestion-job.types';
import { withMongoRetry, BULK_INSERT_BATCH_SIZE } from '../common/mongo-bulk.util';
import { DocumentUpload, DocumentUploadStatus } from '../database/schemas/document-upload.schema';
import { DocumentLineItem } from '../database/schemas/document-line-item.schema';
import { UnifiedBilling } from '../database/schemas/unified-billing.schema';
import { OciCostModeling } from '../database/schemas/oci-cost-modeling.schema';
import { CloudProviderDetected, DocumentUploadResult, NormalizedLineItem } from './documents.types';
import { IngestionStatus } from './ingestion.types';
import { CostSummaryService } from './cost-summary.service';
import { ParserFactory, ParseOptions, PdfExtractor } from './parser-factory.service';
import { NormalizationService } from './normalization.service';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { CollectorService, RemoteBillingFile } from './collector.service';
import { CollectBillingDto } from './dto/collect-billing.dto';
import { OciSkuResolutionService } from './oci-sku-resolution.service';

export interface CollectionResult {
  source: string;
  bucket: string;
  objectKey: string;
  lastModified: Date;
  sizeBytes: number;
  uploadResult: DocumentUploadResult;
}

export interface DryRunResult {
  source: string;
  files: RemoteBillingFile[];
}

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

/**
 * Returns true if the line item has none of Quantity, Unit, or Region — i.e. it is tax-related.
 * Such items are excluded from MongoDB, Grand total, and the Extracted Data table.
 * If an item has at least one of (quantity, unitOfMeasure, regionName), it is a real line item.
 */
/** Row shape after NormalizationService (extra fields not listed on NormalizedLineItem). */
type PersistableLineItem = NormalizedLineItem & {
  ociEquivalentQuantity?: number | null;
  isPaidSku?: boolean;
  brlTaxAmount?: number | null;
  costAfterTax?: number | null;
  isGenerativeAI?: boolean;
  isWindowsLicensed?: boolean;
  windowsSkuCode?: string | null;
};

function isTaxOnlyLineItem(item: NormalizedLineItem): boolean {
  const hasQuantity = item.usageQuantity != null && (typeof item.usageQuantity !== 'number' || !Number.isNaN(item.usageQuantity));
  const hasUnit = item.unitOfMeasure != null && String(item.unitOfMeasure).trim() !== '';
  const hasRegion = item.regionName != null && String(item.regionName).trim() !== '';
  return !hasQuantity && !hasUnit && !hasRegion;
}

/**
 * DocumentIngestionService is the single orchestrator for the ingestion pipeline.
 * The controller calls only this service; all other services are internal details.
 *
 * Pipeline:
 *   File → persisted to disk → (optional Redis queue) → ParserFactory → NormalizationService
 *        → MongoDB (batched inserts): DocumentUpload + UnifiedBilling + DocumentLineItem
 *
 * When REDIS_URL is set, BullMQ runs ingestion with retries (concurrency 1). Otherwise the same
 * pipeline runs in-process after the HTTP response, as before.
 */
@Injectable()
export class DocumentIngestionService {
  private readonly logger = new Logger(DocumentIngestionService.name);

  constructor(
    @InjectModel(DocumentUpload.name)
    private readonly uploadModel: Model<DocumentUpload>,
    @InjectModel(DocumentLineItem.name)
    private readonly lineItemModel: Model<DocumentLineItem>,
    @InjectModel(UnifiedBilling.name)
    private readonly unifiedBillingModel: Model<UnifiedBilling>,
    @InjectModel(OciCostModeling.name)
    private readonly ociCostModelingModel: Model<OciCostModeling>,
    private readonly parserFactory: ParserFactory,
    private readonly normalizationService: NormalizationService,
    private readonly costSummaryService: CostSummaryService,
    private readonly collectorService: CollectorService,
    private readonly ociSkuResolutionService: OciSkuResolutionService,
    @Optional() @InjectQueue(DOCUMENT_INGESTION_QUEUE) private readonly ingestionQueue?: Queue,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API – called only by DocumentsController
  // ---------------------------------------------------------------------------

  async processFile(
    file: Express.Multer.File,
    dto: UploadDocumentDto = {},
    extractor: PdfExtractor = 'auto',
  ): Promise<DocumentUploadResult> {
    if (!file) throw new BadRequestException('No file provided');

    const buffer = Buffer.isBuffer(file.buffer)
      ? file.buffer
      : Buffer.from(file.buffer as unknown as ArrayBuffer);

    if (buffer.length > MAX_FILE_SIZE) {
      throw new BadRequestException('File exceeds the 50 MB limit');
    }

    // 1. Create upload record with processing status and progress 0
    const uploadDoc = await this.uploadModel.create({
      originalName: file.originalname ?? 'unknown',
      mimeType: file.mimetype ?? 'application/octet-stream',
      size: buffer.length,
      storagePath: null,
      providerDetected: dto.providerHint ?? 'unknown',
      billingPeriodStart: null,
      billingPeriodEnd: null,
      uploadedAt: new Date(),
      status: 'processing' as DocumentUploadStatus,
      errorMessage: null,
      progressPercent: 0,
      totalPages: null,
      processedPages: null,
    });

    const uploadId = String(uploadDoc._id);
    this.logger.log(`[${uploadId}] Ingestion started for "${file.originalname}"`);

    const originalName = file.originalname ?? 'unknown';
    const mimeType = file.mimetype ?? 'application/octet-stream';

    const { absolutePath, storagePath } = await this.persistUploadBuffer(buffer, uploadId, originalName);
    await this.uploadModel.updateOne({ _id: uploadId }, { storagePath });

    const jobPayload: UploadIngestionJobData = {
      uploadId,
      absolutePath,
      originalName,
      mimeType,
      dto: { providerHint: dto.providerHint, label: dto.label },
      extractor,
    };

    if (this.ingestionQueue) {
      try {
        await this.ingestionQueue.add('upload', jobPayload, {
          jobId: `upload-${uploadId}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 10_000 },
        });
        this.logger.log(`[${uploadId}] Ingestion job queued (Redis)`);
      } catch (err) {
        this.logger.error(
          `[${uploadId}] Failed to enqueue upload job: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.uploadModel.updateOne(
          { _id: uploadId },
          {
            status: 'failed' as DocumentUploadStatus,
            errorMessage: 'Failed to queue ingestion job. Check Redis connectivity.',
          },
        );
      }
    } else {
      void this.runIngestionCore(uploadId, buffer, originalName, mimeType, dto, extractor).catch((err) => {
        this.logger.error(`[${uploadId}] Background pipeline error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    return {
      uploadId,
      fileName: originalName,
      status: 'processing',
      progressPercent: 0,
      totalPages: null,
      processedPages: null,
    };
  }

  /**
   * Called by BullMQ worker: read file from disk and run parse → normalize → persist.
   */
  async processQueuedUpload(data: UploadIngestionJobData): Promise<void> {
    const buffer = await readFile(data.absolutePath);
    const dto: UploadDocumentDto = {
      providerHint: data.dto.providerHint as UploadDocumentDto['providerHint'],
      label: data.dto.label,
    };
    await this.runIngestionCore(data.uploadId, buffer, data.originalName, data.mimeType, dto, data.extractor);
  }

  /** Worker entry for automated collect jobs. */
  async processQueuedCollect(data: CollectIngestionJobData): Promise<void> {
    const dto: CollectBillingDto = {
      backend: data.dto.backend as CollectBillingDto['backend'],
      providerHint: data.dto.providerHint as CollectBillingDto['providerHint'],
      prefix: data.dto.prefix,
      dryRun: data.dto.dryRun,
    };
    await this.runCollectPipeline(data.uploadId, dto);
  }

  /**
   * Parse with progress callback, normalize, batched DB writes, then completed/failed status.
   */
  private async runIngestionCore(
    uploadId: string,
    buffer: Buffer,
    originalName: string,
    mimeType: string,
    dto: UploadDocumentDto,
    extractor: PdfExtractor,
  ): Promise<void> {
    const onProgress: ParseOptions['onProgress'] = (processed, total) =>
      this.updateProgress(uploadId, processed, total);

    try {
      const { lineItems: rawItems, providerDetected, totalTax, invoiceBillingPeriod } =
        await this.parserFactory.parseFromBuffer(
          buffer,
          originalName,
          mimeType,
          dto.providerHint,
          extractor,
          { onProgress },
        );

      const lineItemsForIngestion = rawItems.filter((item) => !isTaxOnlyLineItem(item));
      const normalizedItems = this.normalizationService.normalizeAll(lineItemsForIngestion, providerDetected);
      const costSummary = this.costSummaryService.build(normalizedItems, totalTax ?? null);

      await this.persistNormalizedLineItems(
        uploadId,
        providerDetected as CloudProviderDetected,
        normalizedItems as PersistableLineItem[],
      );

      await this.uploadModel.updateOne(
        { _id: uploadId },
        {
          status: 'completed' as DocumentUploadStatus,
          providerDetected: providerDetected as CloudProviderDetected,
          progressPercent: 100,
          processedPages: null,
          totalPages: null,
          billingPeriodStart: costSummary.billingPeriodStart,
          billingPeriodEnd: costSummary.billingPeriodEnd,
          invoiceBillingPeriodStart: invoiceBillingPeriod?.start ?? null,
          invoiceBillingPeriodEnd: invoiceBillingPeriod?.end ?? null,
          totalTax: totalTax ?? null,
          errorMessage: null,
        },
      );

      this.logger.log(`[${uploadId}] Completed: ${normalizedItems.length} items, provider=${providerDetected}`);
    } catch (err) {
      const message = this.sanitizeErrorMessage(err);
      await this.uploadModel.updateOne(
        { _id: uploadId },
        { status: 'failed' as DocumentUploadStatus, errorMessage: message },
      );
      this.logger.error(`[${uploadId}] Ingestion failed: ${message}`);
    }
  }

  private async updateProgress(uploadId: string, processedPages: number, totalPages: number): Promise<void> {
    const progressPercent = totalPages > 0 ? Math.round((processedPages / totalPages) * 100) : 0;
    await this.uploadModel.updateOne(
      { _id: uploadId },
      { progressPercent, processedPages, totalPages },
    );
  }

  /** Always persist upload buffer so the worker can read from disk (avoids huge Redis payloads). */
  private async persistUploadBuffer(
    buffer: Buffer,
    uploadId: string,
    originalName: string,
  ): Promise<{ absolutePath: string; storagePath: string }> {
    const basePath = process.env.UPLOAD_STORAGE_PATH?.trim();
    const dir = basePath ? basePath : join(tmpdir(), 'oci-price-calculator-ingestion');
    await mkdir(dir, { recursive: true });
    const ext = originalName.match(/\.(pdf|csv|xlsx)$/i)?.[0]?.toLowerCase() ?? '';
    const fileName = `${uploadId}${ext}`;
    const absolutePath = join(dir, fileName);
    await writeFile(absolutePath, buffer);
    const storagePath = basePath ? fileName : absolutePath;
    return { absolutePath, storagePath };
  }

  private async persistNormalizedLineItems(
    uploadId: string,
    providerDetected: CloudProviderDetected,
    normalizedItems: PersistableLineItem[],
  ): Promise<void> {
    if (normalizedItems.length === 0) return;

    const unifiedDocs = normalizedItems.map((item) => ({
      uploadId,
      provider: providerDetected,
      sourceResourceId: item.resourceId ?? null,
      invoiceId: item.invoiceId ?? null,
      productCode: item.productCode ?? null,
      productName: item.productName ?? null,
      usageQuantity: item.usageQuantity ?? null,
      ociEquivalentQuantity: item.ociEquivalentQuantity ?? null,
      serviceCategory: item.serviceCategory,
      unitPrice: item.unitPrice ?? null,
      isPaidSku: item.isPaidSku ?? true,
      brlTaxAmount: item.brlTaxAmount ?? null,
      costAfterTax: item.costAfterTax ?? item.costBeforeTax ?? null,
      isGenerativeAI: item.isGenerativeAI ?? false,
      isWindowsLicensed: item.isWindowsLicensed ?? false,
      windowsSkuCode: item.windowsSkuCode ?? null,
      costBeforeTax: item.costBeforeTax ?? null,
      currencyCode: item.currencyCode ?? 'USD',
      regionName: item.regionName ?? null,
      usageStartDate: item.usageStartDate ?? null,
      usageEndDate: item.usageEndDate ?? null,
      ingestionStatus: IngestionStatus.COMPLETED,
      rawData: item.rawLine ?? null,
    }));

    const lineDocs = normalizedItems.map((item) => ({
      uploadId,
      providerId: null,
      invoiceId: item.invoiceId ?? null,
      linkedAccountId: item.linkedAccountId ?? null,
      resourceId: item.resourceId ?? null,
      productId: item.productId ?? null,
      productCode: item.productCode ?? null,
      productName: item.productName ?? null,
      serviceCategory: item.serviceCategory ?? null,
      usageStartDate: item.usageStartDate ?? null,
      usageEndDate: item.usageEndDate ?? null,
      usageQuantity: item.usageQuantity ?? null,
      unitOfMeasure: item.unitOfMeasure ?? null,
      costBeforeTax: item.costBeforeTax ?? null,
      taxAmount: item.taxAmount ?? null,
      currencyCode: item.currencyCode ?? 'USD',
      regionId: item.regionId ?? null,
      regionName: item.regionName ?? null,
      isSpotInstance: item.isSpotInstance ?? false,
      rawLine: item.rawLine ?? null,
    }));

    for (let i = 0; i < unifiedDocs.length; i += BULK_INSERT_BATCH_SIZE) {
      const batch = unifiedDocs.slice(i, i + BULK_INSERT_BATCH_SIZE);
      await withMongoRetry(() => this.unifiedBillingModel.insertMany(batch, { ordered: false }));
    }
    for (let i = 0; i < lineDocs.length; i += BULK_INSERT_BATCH_SIZE) {
      const batch = lineDocs.slice(i, i + BULK_INSERT_BATCH_SIZE);
      await withMongoRetry(() => this.lineItemModel.insertMany(batch, { ordered: false }));
    }
  }

  // ---------------------------------------------------------------------------
  // CollectorService integration
  // ---------------------------------------------------------------------------

  /**
   * Orchestrates the automated pull pipeline. Dry-run returns immediately with file list.
   * Full run returns immediately with uploadId and status 'processing'; actual fetch/parse
   * runs in the background to avoid 504 on Railway. Poll GET /api/documents/:uploadId for result.
   *
   * @param dto  CollectBillingDto with optional backend, providerHint, prefix, dryRun
   */
  async processFromCollector(
    dto: CollectBillingDto,
  ): Promise<CollectionResult | DryRunResult | DocumentUploadResult> {
    // Dry-run: list available files without downloading
    if (dto.dryRun) {
      const files = await this.collectorService.listBillingFiles(dto);
      const backend = this.collectorService.detectBackend(dto.backend);
      return { source: backend, files };
    }

    // Full run: create upload record and return immediately; run fetch/parse in background
    const uploadDoc = await this.uploadModel.create({
      originalName: 'collecting...',
      mimeType: 'application/octet-stream',
      size: 0,
      storagePath: null,
      providerDetected: (dto.providerHint as CloudProviderDetected) ?? 'unknown',
      billingPeriodStart: null,
      billingPeriodEnd: null,
      uploadedAt: new Date(),
      status: 'processing' as DocumentUploadStatus,
      errorMessage: null,
    });
    const uploadId = String(uploadDoc._id);
    this.logger.log(`[${uploadId}] Collect started; running in background`);

    const collectPayload: CollectIngestionJobData = {
      uploadId,
      dto: {
        backend: dto.backend,
        providerHint: dto.providerHint,
        prefix: dto.prefix,
        dryRun: dto.dryRun,
      },
    };

    if (this.ingestionQueue) {
      try {
        await this.ingestionQueue.add('collect', collectPayload, {
          jobId: `collect-${uploadId}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 10_000 },
        });
        this.logger.log(`[${uploadId}] Collect job queued (Redis)`);
      } catch (err) {
        this.logger.error(
          `[${uploadId}] Failed to enqueue collect job: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.uploadModel.updateOne(
          { _id: uploadId },
          {
            status: 'failed' as DocumentUploadStatus,
            errorMessage: 'Failed to queue ingestion job. Check Redis connectivity.',
          },
        );
      }
    } else {
      void this.runCollectPipeline(uploadId, dto).catch((err) => {
        this.logger.error(
          `[${uploadId}] Collect pipeline error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    return {
      uploadId,
      fileName: 'collecting...',
      status: 'processing',
      progressPercent: 0,
      totalPages: null,
      processedPages: null,
    };
  }

  /**
   * Background: fetch billing file from storage, parse, normalize, persist. Updates upload status.
   */
  private async runCollectPipeline(
    uploadId: string,
    dto: CollectBillingDto,
  ): Promise<void> {
    const uploadDoc = await this.uploadModel.findById(uploadId).exec();
    if (!uploadDoc) {
      this.logger.warn(`[${uploadId}] Upload not found, skipping collect pipeline`);
      return;
    }

    try {
      const fetched = await this.collectorService.fetchLatestBillingFile(dto);
      this.logger.log(
        `[${uploadId}] Processing "${fetched.fileName}" from ${fetched.backend} ` +
          `(${(fetched.sizeBytes / 1024).toFixed(1)} KB)`,
      );

      await this.uploadModel.updateOne(
        { _id: uploadId },
        {
          originalName: fetched.fileName,
          mimeType: fetched.mimeType,
          size: fetched.sizeBytes,
          storagePath: `${fetched.backend}://${fetched.bucket}/${fetched.key}`,
        },
      );

      const { lineItems: rawItems, providerDetected } =
        await this.parserFactory.parseFromBuffer(
          fetched.buffer,
          fetched.fileName,
          fetched.mimeType,
          dto.providerHint,
        );

      const lineItemsForIngestion = rawItems.filter((item) => !isTaxOnlyLineItem(item));
      const normalizedItems = this.normalizationService.normalizeAll(
        lineItemsForIngestion,
        providerDetected,
      );
      const costSummary = this.costSummaryService.build(normalizedItems);

      await this.persistNormalizedLineItems(
        uploadId,
        providerDetected as CloudProviderDetected,
        normalizedItems as PersistableLineItem[],
      );

      await this.uploadModel.updateOne(
        { _id: uploadId },
        {
          status: 'completed' as DocumentUploadStatus,
          errorMessage: null,
          billingPeriodStart: costSummary.billingPeriodStart,
          billingPeriodEnd: costSummary.billingPeriodEnd,
        },
      );
      this.logger.log(
        `[${uploadId}] Collect completed: ${normalizedItems.length} items, provider=${providerDetected}`,
      );
    } catch (err) {
      const message = this.sanitizeErrorMessage(err);
      await this.uploadModel.updateOne(
        { _id: uploadId },
        { status: 'failed' as DocumentUploadStatus, errorMessage: message },
      );
      this.logger.error(`[${uploadId}] Collect failed: ${message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Upload history
  // ---------------------------------------------------------------------------

  async listUploads(
    page: number = 1,
    limit: number = 20,
  ): Promise<{
    uploads: Array<{
      uploadId: string;
      fileName: string;
      providerDetected: string;
      status: string;
      progressPercent: number | null;
      totalPages: number | null;
      processedPages: number | null;
      billingPeriodStart: Date | null;
      billingPeriodEnd: Date | null;
      uploadedAt: Date;
      itemCount: number;
      totalTax: number | null;
    }>;
    total: number;
    page: number;
    limit: number;
  }> {
    const skip = (page - 1) * limit;

    const [uploads, total] = await Promise.all([
      this.uploadModel
        .find()
        .sort({ uploadedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.uploadModel.countDocuments(),
    ]);

    // Fetch item counts in a single aggregation
    const uploadIds = uploads.map((u) => String(u._id));
    const countAgg = await this.unifiedBillingModel
      .aggregate<{ _id: string; count: number }>([
        { $match: { uploadId: { $in: uploadIds } } },
        { $group: { _id: '$uploadId', count: { $sum: 1 } } },
      ])
      .exec();
    const countMap = new Map(countAgg.map((r) => [r._id, r.count]));

    return {
      uploads: uploads.map((u) => {
        const doc = u as typeof u & {
          invoiceBillingPeriodStart?: Date | null;
          invoiceBillingPeriodEnd?: Date | null;
          totalTax?: number | null;
          progressPercent?: number | null;
          totalPages?: number | null;
          processedPages?: number | null;
        };
        return {
          uploadId: String(u._id),
          fileName: u.originalName,
          providerDetected: u.providerDetected,
          status: u.status,
          progressPercent: doc.progressPercent ?? null,
          totalPages: doc.totalPages ?? null,
          processedPages: doc.processedPages ?? null,
          billingPeriodStart: doc.invoiceBillingPeriodStart ?? u.billingPeriodStart ?? null,
          billingPeriodEnd: doc.invoiceBillingPeriodEnd ?? u.billingPeriodEnd ?? null,
          uploadedAt: u.uploadedAt,
          itemCount: countMap.get(String(u._id)) ?? 0,
          totalTax: doc.totalTax ?? null,
        };
      }),
      total,
      page,
      limit,
    };
  }

  async getByUploadId(uploadId: string): Promise<DocumentUploadResult | null> {
    const upload = await this.uploadModel.findById(uploadId).lean().exec();
    if (!upload) return null;

    const uploadDoc = upload as typeof upload & {
      invoiceBillingPeriodStart?: Date | null;
      invoiceBillingPeriodEnd?: Date | null;
      totalTax?: number | null;
      progressPercent?: number | null;
      totalPages?: number | null;
      processedPages?: number | null;
    };

    const base = {
      uploadId: String(upload._id),
      fileName: upload.originalName,
      status: upload.status,
      progressPercent: uploadDoc.progressPercent ?? null,
      totalPages: uploadDoc.totalPages ?? null,
      processedPages: uploadDoc.processedPages ?? null,
      errorMessage: upload.errorMessage ?? null,
    };

    if (upload.status === 'processing') {
      return { ...base };
    }

    if (upload.status === 'failed') {
      return { ...base, lineItems: [], costSummary: undefined };
    }

    const lineItems = await this.lineItemModel.find({ uploadId }).lean().exec();
    const needsResolution = lineItems.filter(
      (d) => d.ociSkuPartNumber == null || String(d.ociSkuPartNumber).trim() === '',
    );
    let resolved: Awaited<ReturnType<OciSkuResolutionService['resolveMany']>> = [];
    if (needsResolution.length > 0) {
      resolved = await this.ociSkuResolutionService.resolveMany(
        needsResolution.map((d) => ({
          productName: d.productName,
          productCode: d.productCode,
          serviceCategory: d.serviceCategory,
        })),
      );
    }

    const resolutionByIndex = new Map<number, { ociSkuPartNumber: string; ociSkuName: string } | null>();
    let needIdx = 0;
    for (let i = 0; i < lineItems.length; i++) {
      const d = lineItems[i]!;
      if (d.ociSkuPartNumber != null && String(d.ociSkuPartNumber).trim() !== '') continue;
      const r = resolved[needIdx++] ?? null;
      if (r) resolutionByIndex.set(i, r);
    }

    const normalized: NormalizedLineItem[] = lineItems.map((d, idx) => {
      const resolvedSku = resolutionByIndex.get(idx);
      const ociSkuPartNumber = d.ociSkuPartNumber != null && String(d.ociSkuPartNumber).trim() !== ''
        ? d.ociSkuPartNumber
        : (resolvedSku?.ociSkuPartNumber ?? null);
      const ociSkuName = d.ociSkuName != null && String(d.ociSkuName).trim() !== ''
        ? d.ociSkuName
        : (resolvedSku?.ociSkuName ?? null);

      return {
        id: String((d as { _id: unknown })._id),
        invoiceId: d.invoiceId ?? null,
        linkedAccountId: d.linkedAccountId ?? null,
        resourceId: d.resourceId ?? null,
        productId: d.productId ?? null,
        productCode: d.productCode ?? null,
        productName: d.productName ?? null,
        serviceCategory: d.serviceCategory ?? null,
        usageStartDate: d.usageStartDate ?? null,
        usageEndDate: d.usageEndDate ?? null,
        usageQuantity: d.usageQuantity ?? null,
        unitOfMeasure: d.unitOfMeasure ?? null,
        costBeforeTax: d.costBeforeTax ?? null,
        taxAmount: d.taxAmount ?? null,
        currencyCode: d.currencyCode ?? 'USD',
        regionId: d.regionId ?? null,
        regionName: d.regionName ?? null,
        isSpotInstance: d.isSpotInstance ?? false,
        ociSkuPartNumber: ociSkuPartNumber ?? undefined,
        ociSkuName: ociSkuName ?? undefined,
        rawLine: d.rawLine ?? null,
      };
    });

    if (resolutionByIndex.size > 0) {
      const bulkUpdates = Array.from(resolutionByIndex.entries()).map(([idx]) => {
        const doc = lineItems[idx]!;
        const r = resolutionByIndex.get(idx)!;
        return this.lineItemModel.updateOne(
          { _id: (doc as { _id: unknown })._id, uploadId },
          { $set: { ociSkuPartNumber: r.ociSkuPartNumber, ociSkuName: r.ociSkuName } },
        );
      });
      await Promise.all(bulkUpdates);
    }

    const costSummary = this.costSummaryService.build(normalized, uploadDoc.totalTax ?? null);

    return {
      ...base,
      fileType: upload.mimeType.includes('pdf')
        ? 'pdf'
        : upload.mimeType.includes('spreadsheet') || upload.originalName?.toLowerCase().endsWith('.xlsx')
          ? 'xlsx'
          : 'csv',
      cloudProviderDetected: upload.providerDetected as CloudProviderDetected,
      billingPeriod: {
        start: uploadDoc.invoiceBillingPeriodStart ?? upload.billingPeriodStart ?? null,
        end: uploadDoc.invoiceBillingPeriodEnd ?? upload.billingPeriodEnd ?? null,
      },
      totalTax: uploadDoc.totalTax ?? null,
      lineItems: normalized,
      costSummary,
    };
  }

  // ---------------------------------------------------------------------------
  // Delete upload (cascade)
  // ---------------------------------------------------------------------------

  /**
   * Update a single line item's OCI SKU (for user edits in Extracted Data table).
   * Returns the updated line item fields (id, ociSkuPartNumber, ociSkuName) or null if not found.
   */
  async updateLineItemOciSku(
    uploadId: string,
    lineItemId: string,
    payload: { ociSkuPartNumber?: string | null; ociSkuName?: string | null },
  ): Promise<NormalizedLineItem | null> {
    const update: Record<string, unknown> = {};
    if (payload.ociSkuPartNumber !== undefined) update.ociSkuPartNumber = payload.ociSkuPartNumber ?? null;
    if (payload.ociSkuName !== undefined) update.ociSkuName = payload.ociSkuName ?? null;
    if (Object.keys(update).length === 0) {
      const doc = await this.lineItemModel
        .findOne({ _id: lineItemId, uploadId })
        .lean()
        .exec();
      if (!doc) return null;
      const d = doc as typeof doc & { _id: unknown; ociSkuPartNumber?: string | null; ociSkuName?: string | null };
      return this.toNormalizedLineItem(d);
    }
    const doc = await this.lineItemModel
      .findOneAndUpdate(
        { _id: lineItemId, uploadId },
        { $set: update },
        { new: true },
      )
      .lean()
      .exec();
    if (!doc) return null;
    return this.toNormalizedLineItem(doc as typeof doc & { _id: unknown; ociSkuPartNumber?: string | null; ociSkuName?: string | null });
  }

  private toNormalizedLineItem(
    d: {
      _id: unknown;
      invoiceId?: string | null;
      linkedAccountId?: string | null;
      resourceId?: string | null;
      productId?: number | null;
      productCode?: string | null;
      productName?: string | null;
      serviceCategory?: string | null;
      usageStartDate?: Date | null;
      usageEndDate?: Date | null;
      usageQuantity?: number | null;
      unitOfMeasure?: string | null;
      costBeforeTax?: number | null;
      taxAmount?: number | null;
      currencyCode?: string;
      regionId?: number | null;
      regionName?: string | null;
      isSpotInstance?: boolean;
      ociSkuPartNumber?: string | null;
      ociSkuName?: string | null;
      rawLine?: Record<string, unknown> | null;
    },
  ): NormalizedLineItem {
    return {
      id: String(d._id),
      invoiceId: d.invoiceId ?? null,
      linkedAccountId: d.linkedAccountId ?? null,
      resourceId: d.resourceId ?? null,
      productId: d.productId ?? null,
      productCode: d.productCode ?? null,
      productName: d.productName ?? null,
      serviceCategory: d.serviceCategory ?? null,
      usageStartDate: d.usageStartDate ?? null,
      usageEndDate: d.usageEndDate ?? null,
      usageQuantity: d.usageQuantity ?? null,
      unitOfMeasure: d.unitOfMeasure ?? null,
      costBeforeTax: d.costBeforeTax ?? null,
      taxAmount: d.taxAmount ?? null,
      currencyCode: d.currencyCode ?? 'USD',
      regionId: d.regionId ?? null,
      regionName: d.regionName ?? null,
      isSpotInstance: d.isSpotInstance ?? false,
      ociSkuPartNumber: d.ociSkuPartNumber ?? undefined,
      ociSkuName: d.ociSkuName ?? undefined,
      rawLine: d.rawLine ?? null,
    };
  }

  async deleteUpload(uploadId: string): Promise<{ deleted: boolean; uploadId: string }> {
    const upload = await this.uploadModel.findById(uploadId).lean().exec();
    if (!upload) throw new NotFoundException(`Document upload "${uploadId}" not found`);

    await Promise.all([
      this.uploadModel.deleteOne({ _id: uploadId }),
      this.lineItemModel.deleteMany({ uploadId }),
      this.unifiedBillingModel.deleteMany({ uploadId }),
      this.ociCostModelingModel.deleteMany({ uploadId }),
    ]);

    this.logger.log(`[${uploadId}] Deleted upload and all associated records`);
    return { deleted: true, uploadId };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private sanitizeErrorMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : 'Processing failed';
    const lower = raw.toLowerCase();
    if (
      lower.includes('password') ||
      lower.includes('corrupt') ||
      lower.includes('cannot read') ||
      lower.includes('invalid') ||
      lower.includes('parse') ||
      lower.includes('unreadable')
    ) {
      return 'Document could not be read. Verify the file is not corrupted or password-protected.';
    }
    return raw;
  }
}

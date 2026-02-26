import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { DocumentUpload, DocumentUploadStatus } from '../database/schemas/document-upload.schema';
import { DocumentLineItem } from '../database/schemas/document-line-item.schema';
import { UnifiedBilling } from '../database/schemas/unified-billing.schema';
import { OciCostModeling } from '../database/schemas/oci-cost-modeling.schema';
import { CloudProviderDetected, DocumentUploadResult, NormalizedLineItem } from './documents.types';
import { IngestionStatus } from './ingestion.types';
import { CostSummaryService } from './cost-summary.service';
import { ParserFactory, PdfExtractor } from './parser-factory.service';
import { NormalizationService } from './normalization.service';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { CollectorService, RemoteBillingFile } from './collector.service';
import { CollectBillingDto } from './dto/collect-billing.dto';

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
 * DocumentIngestionService is the single orchestrator for the ingestion pipeline.
 * The controller calls only this service; all other services are internal details.
 *
 * Pipeline:
 *   File → ParserFactory (type detection + extraction)
 *        → NormalizationService (OCI category mapping, OCPU conversion, Windows flag)
 *        → MongoDB: DocumentUpload (status tracking) + UnifiedBilling (primary store)
 *                                                    + DocumentLineItem (backward compat.)
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

    // 1. Create upload record with PENDING status
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
    });

    const uploadId = String(uploadDoc._id);
    this.logger.log(`[${uploadId}] Ingestion started for "${file.originalname}"`);

    // 2. Optionally persist the raw file to disk
    const storagePath = await this.persistFile(buffer, uploadId, file.originalname ?? '');
    if (storagePath) {
      await this.uploadModel.updateOne({ _id: uploadDoc._id }, { storagePath });
    }

    try {
      // 3. Detect file type and extract raw line items via ParserFactory
      const { lineItems: rawItems, providerDetected, fileType, totalTax, invoiceBillingPeriod } =
        await this.parserFactory.parse(file, dto.providerHint, extractor);

      // 4. Apply OCI normalization (category mapping, OCPU calc, Windows SKU flagging)
      const normalizedItems = this.normalizationService.normalizeAll(rawItems, providerDetected);

      // 5. Build cost summary (totalTax is added to grandTotal)
      const costSummary = this.costSummaryService.build(normalizedItems, totalTax ?? null);

      // 6. Persist to UnifiedBilling (primary Phase 1 store)
      if (normalizedItems.length > 0) {
        await this.unifiedBillingModel.insertMany(
          normalizedItems.map((item) => ({
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
            // FinOps rules
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
          })),
        );

        // 7. Persist to DocumentLineItem (backward compatibility with existing APIs)
        await this.lineItemModel.insertMany(
          normalizedItems.map((item) => ({
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
          })),
        );
      }

      // 8. Mark upload as completed
      await this.uploadModel.updateOne(
        { _id: uploadDoc._id },
        {
          status: 'completed' as DocumentUploadStatus,
          providerDetected,
          // Line-item-derived dates (CSV/XLSX); null for PDF invoices
          billingPeriodStart: costSummary.billingPeriodStart,
          billingPeriodEnd: costSummary.billingPeriodEnd,
          // Invoice-header dates (populated for PDFs via Gemini/Textract)
          invoiceBillingPeriodStart: invoiceBillingPeriod?.start ?? null,
          invoiceBillingPeriodEnd: invoiceBillingPeriod?.end ?? null,
          // Total tax from the invoice summary row
          totalTax: totalTax ?? null,
          errorMessage: null,
        },
      );

      this.logger.log(
        `[${uploadId}] Completed: ${normalizedItems.length} items, provider=${providerDetected}`,
      );

      // Prefer the invoice-header billing period; fall back to the range
      // derived from line-item dates by CostSummaryService.
      const billingPeriod = (invoiceBillingPeriod?.start ?? invoiceBillingPeriod?.end)
        ? invoiceBillingPeriod!
        : { start: costSummary.billingPeriodStart, end: costSummary.billingPeriodEnd };

      return {
        uploadId,
        fileName: file.originalname ?? 'unknown',
        fileType,
        cloudProviderDetected: providerDetected as CloudProviderDetected,
        billingPeriod,
        totalTax: totalTax ?? null,
        lineItems: normalizedItems as unknown as NormalizedLineItem[],
        costSummary,
      };
    } catch (err) {
      const message = this.sanitizeErrorMessage(err);
      await this.uploadModel.updateOne(
        { _id: uploadDoc._id },
        { status: 'failed' as DocumentUploadStatus, errorMessage: message },
      );
      this.logger.error(`[${uploadId}] Ingestion failed: ${message}`);
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(message);
    }
  }

  // ---------------------------------------------------------------------------
  // CollectorService integration
  // ---------------------------------------------------------------------------

  /**
   * Orchestrates the automated pull pipeline:
   *   CollectorService (list / fetch) → ParserFactory → NormalizationService → MongoDB
   *
   * @param dto  CollectBillingDto with optional backend, providerHint, prefix, dryRun
   */
  async processFromCollector(
    dto: CollectBillingDto,
  ): Promise<CollectionResult | DryRunResult> {
    // Dry-run: list available files without downloading
    if (dto.dryRun) {
      const files = await this.collectorService.listBillingFiles(dto);
      const backend = this.collectorService.detectBackend(dto.backend);
      return { source: backend, files };
    }

    // Full run: fetch latest billing file from cloud storage
    const fetched = await this.collectorService.fetchLatestBillingFile(dto);

    this.logger.log(
      `[Collector] Processing "${fetched.fileName}" from ${fetched.backend} ` +
        `(${(fetched.sizeBytes / 1024).toFixed(1)} KB)`,
    );

    // Pipe buffer directly into ParserFactory
    const { lineItems: rawItems, providerDetected, fileType } =
      await this.parserFactory.parseFromBuffer(
        fetched.buffer,
        fetched.fileName,
        fetched.mimeType,
        dto.providerHint,
      );

    // Apply mandatory OCI FinOps normalization rules
    const normalizedItems = this.normalizationService.normalizeAll(rawItems, providerDetected);
    const costSummary = this.costSummaryService.build(normalizedItems);

    // Persist via the same upload→line-item pipeline as manual uploads
    const uploadDoc = await this.uploadModel.create({
      originalName: fetched.fileName,
      mimeType: fetched.mimeType,
      size: fetched.sizeBytes,
      storagePath: `${fetched.backend}://${fetched.bucket}/${fetched.key}`,
      providerDetected,
      billingPeriodStart: costSummary.billingPeriodStart,
      billingPeriodEnd: costSummary.billingPeriodEnd,
      uploadedAt: new Date(),
      status: 'processing' as DocumentUploadStatus,
      errorMessage: null,
    });

    const uploadId = String(uploadDoc._id);

    try {
      if (normalizedItems.length > 0) {
        await this.unifiedBillingModel.insertMany(
          normalizedItems.map((item) => ({
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
          })),
        );

        await this.lineItemModel.insertMany(
          normalizedItems.map((item) => ({
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
          })),
        );
      }

      await this.uploadModel.updateOne(
        { _id: uploadDoc._id },
        { status: 'completed' as DocumentUploadStatus, errorMessage: null },
      );
    } catch (err) {
      const message = this.sanitizeErrorMessage(err);
      await this.uploadModel.updateOne(
        { _id: uploadDoc._id },
        { status: 'failed' as DocumentUploadStatus, errorMessage: message },
      );
      throw err;
    }

    const uploadResult: DocumentUploadResult = {
      uploadId,
      fileName: fetched.fileName,
      fileType,
      cloudProviderDetected: providerDetected as CloudProviderDetected,
      billingPeriod: {
        start: costSummary.billingPeriodStart,
        end: costSummary.billingPeriodEnd,
      },
      totalTax: null,
      lineItems: normalizedItems as unknown as NormalizedLineItem[],
      costSummary,
    };

    return {
      source: fetched.backend,
      bucket: fetched.bucket,
      objectKey: fetched.key,
      lastModified: fetched.lastModified,
      sizeBytes: fetched.sizeBytes,
      uploadResult,
    };
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
        };
        return {
          uploadId: String(u._id),
          fileName: u.originalName,
          providerDetected: u.providerDetected,
          status: u.status,
          // Prefer invoice-header dates (PDF); fall back to line-item-derived dates (CSV/XLSX)
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

    const lineItems = await this.lineItemModel.find({ uploadId }).lean().exec();
    const normalized = lineItems.map((d) => ({
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
      rawLine: d.rawLine ?? null,
    }));

    const uploadDoc = upload as typeof upload & {
      invoiceBillingPeriodStart?: Date | null;
      invoiceBillingPeriodEnd?: Date | null;
      totalTax?: number | null;
    };

    // Pass the stored totalTax so grandTotal = subtotal + tax (not just subtotal)
    const costSummary = this.costSummaryService.build(normalized, uploadDoc.totalTax ?? null);

    return {
      uploadId: String(upload._id),
      fileName: upload.originalName,
      fileType: upload.mimeType.includes('pdf')
        ? 'pdf'
        : upload.mimeType.includes('spreadsheet') || upload.originalName?.toLowerCase().endsWith('.xlsx')
          ? 'xlsx'
          : 'csv',
      cloudProviderDetected: upload.providerDetected as CloudProviderDetected,
      billingPeriod: {
        // Prefer invoice-header dates (PDF); fall back to line-item-derived dates (CSV/XLSX)
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

  private async persistFile(
    buffer: Buffer,
    uploadId: string,
    originalName: string,
  ): Promise<string | null> {
    const basePath = process.env.UPLOAD_STORAGE_PATH?.trim();
    if (!basePath) return null;
    try {
      await mkdir(basePath, { recursive: true });
      const ext = originalName.match(/\.(pdf|csv|xlsx)$/i)?.[0]?.toLowerCase() ?? '';
      const fileName = `${uploadId}${ext}`;
      await writeFile(join(basePath, fileName), buffer);
      return fileName;
    } catch {
      return null;
    }
  }

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

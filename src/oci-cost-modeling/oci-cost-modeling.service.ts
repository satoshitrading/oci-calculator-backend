import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OciCostModeling } from '../database/schemas/oci-cost-modeling.schema';
import { UnifiedBilling } from '../database/schemas/unified-billing.schema';
import { PricingService } from '../calculate/pricing.service';
import { OciServiceCategory } from '../documents/ingestion.types';
import { OciSkuCatalogService } from './oci-sku-catalog.service';
import { OciSkuMappingsRepository } from '../oci-sku-mappings/oci-sku-mappings.repository';
import { OciSkuMappingRow } from '../oci-sku-mappings/oci-sku-mappings.repository';
import { similarityToCandidate, SIMILARITY_THRESHOLD } from '../common/similarity.util';
import { withMongoRetry, BULK_INSERT_BATCH_SIZE } from '../common/mongo-bulk.util';
import { NormalizedLineItem } from '../documents/documents.types';

// Fix 2: Windows Server license SKU — charged per OCPU per Hour
// Per requirements: "4 OCPU × 744 hours × $0.092 per OCPU/hour"
const WINDOWS_LICENSE_SKU = 'B88318';
const WINDOWS_LICENSE_PRICE_PER_OCPU_HOUR = 0.092;

// Ratio-based savings factors (fallback when no quantity is available)
const SAVINGS_FACTOR: Record<OciServiceCategory | string, number> = {
  [OciServiceCategory.COMPUTE]: 0.35,
  [OciServiceCategory.STORAGE]: 0.28,
  [OciServiceCategory.NETWORK]: 0.55,
  [OciServiceCategory.DATABASE]: 0.40,
  [OciServiceCategory.GENAI]: 0.25,
  [OciServiceCategory.OTHER]: 0.30,
};

// Fix 5: OCI Always Free — outbound internet egress (GB per month)
const OCI_FREE_NETWORK_EGRESS_GB = 10 * 1024; // 10 TB

// Fix 6: Unit-mismatch sanity check — use quantity-based OCI Est. Cost only when the result
// is in a plausible range vs source cost. Source usageQuantity can be in wrong units
// (e.g. IP address-hours, request counts) while OCI SKU is per OCPU-hour or GB-month,
// producing wildly wrong OCI Est. Cost and nonsensical Save %. Fall back to ratio-based.
const OCI_COST_VS_SOURCE_MIN_RATIO = 0.05;  // quantity-based OCI cost must be >= 5% of source
const OCI_COST_VS_SOURCE_MAX_RATIO = 20;    // quantity-based OCI cost must be <= 20x source

// Fix 4: AWS Spot instance detection pattern
const SPOT_PATTERN = /\bspot\b/i;

export interface LiftAndShiftRow {
  sourceService: string;
  serviceCategory: string;
  sourceProvider: string;
  sourceCost: number;
  sourceCurrencyCode: string;
  ociSkuPartNumber: string;
  ociSkuName: string;
  ociEquivalentQuantity: number | null;
  ociUnit: string;
  ociUnitPrice: number;
  /** Null when skipped (no matching OCI SKU) */
  ociEstimatedCost: number | null;
  savingsAmount: number;
  savingsPct: number;
  /** Fix 4: true when an AWS Spot instance was converted to OCI On-Demand */
  isSpotConverted: boolean;
  /** Fix 2: true when Windows Server license (B88318) cost was added */
  hasWindowsLicense: boolean;
  /** Fix 2: additional Windows license cost added on top of base compute cost */
  windowsLicenseCost: number;
  /** When set, OCI cost was not calculated (no matching OCI SKU for source service). */
  skipReason?: string | null;
}

export interface LiftAndShiftResult {
  uploadId: string;
  sourceProvider: string;
  currencyCode: string;
  rows: LiftAndShiftRow[];
  summary: {
    totalSourceCost: number;
    totalOciEstimatedCost: number;
    totalSavings: number;
    totalSavingsPct: number;
    byCategory: Record<string, { sourceCost: number; ociCost: number; savings: number }>;
    skippedCount?: number;
    skippedSourceCost?: number;
  };
}

@Injectable()
export class OciCostModelingService {
  private readonly logger = new Logger(OciCostModelingService.name);

  constructor(
    @InjectModel(OciCostModeling.name)
    private readonly modelingModel: Model<OciCostModeling>,
    @InjectModel(UnifiedBilling.name)
    private readonly unifiedBillingModel: Model<UnifiedBilling>,
    private readonly pricingService: PricingService,
    private readonly ociSkuCatalog: OciSkuCatalogService,
    private readonly ociSkuMappings: OciSkuMappingsRepository,
  ) {}

  // ---------------------------------------------------------------------------
  // model() — run lift-and-shift for an uploadId, persist, return result
  // ---------------------------------------------------------------------------

  async model(
    uploadId: string,
    currencyCode: string = 'USD',
    lineItems?: NormalizedLineItem[],
  ): Promise<LiftAndShiftResult> {
    this.logger.log(`[${uploadId}] Starting OCI lift-and-shift modeling`);

    type VirtualRecord = {
      productName: string | null;
      productCode: string | null;
      serviceCategory: OciServiceCategory;
      costBeforeTax: number | null;
      costAfterTax: number | null;
      usageQuantity: number | null;
      ociEquivalentQuantity: number | null;
      provider: string;
      currencyCode: string;
      isWindowsLicensed: boolean;
      sourceResourceId: string | null;
    };
    type MappingRow = { record: VirtualRecord; mapping: OciSkuMappingRow | null };

    let billingRecords: VirtualRecord[];
    let resolved: MappingRow[];
    let providerDetected: string;

    if (lineItems != null && lineItems.length > 0) {
      // Use line items from Extracted Data table (with optional pre-set OCI SKU)
      const standardCategories = [
        OciServiceCategory.COMPUTE,
        OciServiceCategory.STORAGE,
        OciServiceCategory.NETWORK,
        OciServiceCategory.DATABASE,
        OciServiceCategory.OTHER,
      ];
      const categoriesFromItems = lineItems.map((i) => String(i.serviceCategory ?? OciServiceCategory.OTHER));
      const categories = [...new Set([...standardCategories, ...categoriesFromItems])];
      const candidatesByCategory: Record<string, OciSkuMappingRow[]> = {};
      for (const cat of categories) {
        candidatesByCategory[cat] = await this.ociSkuMappings.listByCategory(cat);
      }

      billingRecords = lineItems.map((item) => {
        const category = (item.serviceCategory as OciServiceCategory) ?? OciServiceCategory.OTHER;
        const usageQuantity = item.usageQuantity != null ? Number(item.usageQuantity) : null;
        const ociEquivalentQuantity =
          category === OciServiceCategory.COMPUTE && usageQuantity != null
            ? usageQuantity / 2
            : usageQuantity;
        const costBeforeTax = item.costBeforeTax != null ? Number(item.costBeforeTax) : 0;
        return {
          productName: item.productName ?? null,
          productCode: item.productCode ?? null,
          serviceCategory: category,
          costBeforeTax,
          costAfterTax: costBeforeTax,
          usageQuantity,
          ociEquivalentQuantity,
          provider: 'unknown',
          currencyCode: item.currencyCode ?? 'USD',
          isWindowsLicensed: false,
          sourceResourceId: null,
        };
      });

      resolved = billingRecords.map((record, idx) => {
        const item = lineItems[idx]!;
        const partNumber = item.ociSkuPartNumber != null && String(item.ociSkuPartNumber).trim() !== ''
          ? String(item.ociSkuPartNumber).trim()
          : null;
        const ociSkuName = item.ociSkuName != null && String(item.ociSkuName).trim() !== ''
          ? String(item.ociSkuName).trim()
          : null;
        if (partNumber) {
          const mapping: OciSkuMappingRow = {
            id: '',
            partNumber,
            productTitle: ociSkuName ?? partNumber,
            productTitleNormalized: (ociSkuName ?? partNumber).toLowerCase(),
            skuName: ociSkuName ?? null,
            serviceCategory: record.serviceCategory,
            unit: 'OCPU-hours',
            fallbackUnitPrice: null,
          };
          return { record, mapping };
        }
        const category = record.serviceCategory;
        const sourceService = record.productName || record.productCode || String(category);
        const candidates = candidatesByCategory[String(category)] ?? [];
        if (candidates.length === 0) return { record, mapping: null };
        let best = candidates[0]!;
        let bestScore = similarityToCandidate(sourceService, best.skuName ?? best.productTitle, '');
        for (let i = 1; i < candidates.length; i++) {
          const m = candidates[i]!;
          const score = similarityToCandidate(sourceService, m.skuName ?? m.productTitle, '');
          if (score > bestScore) {
            bestScore = score;
            best = m;
          }
        }
        if (bestScore < SIMILARITY_THRESHOLD) return { record, mapping: null };
        return { record, mapping: best };
      });

      providerDetected = 'unknown';
    } else {
      const dbRecords = await this.unifiedBillingModel
        .find({ uploadId })
        .lean()
        .exec();

      if (!dbRecords.length) {
        return this.emptyResult(uploadId, currencyCode);
      }

      billingRecords = dbRecords.map((r) => ({
        productName: r.productName ?? null,
        productCode: r.productCode ?? null,
        serviceCategory: (r.serviceCategory as OciServiceCategory) ?? OciServiceCategory.OTHER,
        costBeforeTax: r.costBeforeTax ?? null,
        costAfterTax: r.costAfterTax ?? r.costBeforeTax ?? null,
        usageQuantity: r.usageQuantity ?? null,
        ociEquivalentQuantity: r.ociEquivalentQuantity ?? null,
        provider: r.provider ?? 'unknown',
        currencyCode: r.currencyCode ?? 'USD',
        isWindowsLicensed: r.isWindowsLicensed ?? false,
        sourceResourceId: r.sourceResourceId ?? null,
      })) as VirtualRecord[];

      providerDetected =
        dbRecords.find((r) => r.provider && r.provider !== 'unknown')?.provider ??
        dbRecords[0]?.provider ??
        'unknown';

      const standardCategories = [
        OciServiceCategory.COMPUTE,
        OciServiceCategory.STORAGE,
        OciServiceCategory.NETWORK,
        OciServiceCategory.DATABASE,
        OciServiceCategory.OTHER,
      ];
      const categoriesFromBilling = billingRecords.map((r) => String(r.serviceCategory ?? OciServiceCategory.OTHER));
      const categories = [...new Set([...standardCategories, ...categoriesFromBilling])];
      const candidatesByCategory: Record<string, OciSkuMappingRow[]> = {};
      for (const cat of categories) {
        candidatesByCategory[cat] = await this.ociSkuMappings.listByCategory(cat);
      }
      const resolvedDb: MappingRow[] = billingRecords.map((record) => {
        const category = (record.serviceCategory as OciServiceCategory) ?? OciServiceCategory.OTHER;
        const sourceService = record.productName || record.productCode || String(category);
        const candidates = candidatesByCategory[String(category)] ?? [];
        if (candidates.length === 0) return { record, mapping: null };
        let best = candidates[0]!;
        let bestScore = similarityToCandidate(
          sourceService,
          best.skuName ?? best.productTitle,
          '',
        );
        for (let i = 1; i < candidates.length; i++) {
          const m = candidates[i]!;
          const score = similarityToCandidate(
            sourceService,
            m.skuName ?? m.productTitle,
            '',
          );
          if (score > bestScore) {
            bestScore = score;
            best = m;
          }
        }
        if (bestScore < SIMILARITY_THRESHOLD) return { record, mapping: null };
        return { record, mapping: best };
      });
      resolved = resolvedDb;
    }

    if (!billingRecords.length) {
      return this.emptyResult(uploadId, currencyCode);
    }

    // Delete any prior modeling records for this upload (idempotent re-run)
    await withMongoRetry(() => this.modelingModel.deleteMany({ uploadId }).exec());

    // Collect unique part numbers only from matched rows + Windows license SKU
    const partNumbersNeeded = new Set<string>(
      resolved.filter((r) => r.mapping).map((r) => r.mapping!.partNumber),
    );
    partNumbersNeeded.add(WINDOWS_LICENSE_SKU);

    // ── Step 2: Fetch ALL prices keyed by part number (concurrent) ────────────
    const ociPrices = await this.fetchOciPricesByPartNumbers(
      [...partNumbersNeeded],
      currencyCode,
    );

    // Live Windows license price (B88318), falls back to hardcoded constant
    const windowsLivePricePerOcpuHour =
      ociPrices[WINDOWS_LICENSE_SKU] ?? WINDOWS_LICENSE_PRICE_PER_OCPU_HOUR;

    const rows: LiftAndShiftRow[] = [];
    const insertDocs: Partial<OciCostModeling>[] = [];

    let spotCount = 0;
    let windowsCount = 0;

    for (let i = 0; i < billingRecords.length; i++) {
      const { record, mapping } = resolved[i]!;
      const category = (record.serviceCategory as OciServiceCategory) ?? OciServiceCategory.OTHER;
      const productName = record.productName ?? '';
      const productCode = record.productCode ?? '';
      const sourceService = productName || productCode || String(category);

      // ── No matching OCI SKU: skip cost calculation, add row with skipReason ─
      if (!mapping) {
        const skipReason = `No matching part number for source service: ${sourceService}`;
        const sourceCost = record.costAfterTax ?? record.costBeforeTax ?? 0;
        const row: LiftAndShiftRow = {
          sourceService,
          serviceCategory: category,
          sourceProvider: record.provider ?? providerDetected,
          sourceCost,
          sourceCurrencyCode: record.currencyCode ?? currencyCode,
          ociSkuPartNumber: '',
          ociSkuName: '',
          ociEquivalentQuantity: record.ociEquivalentQuantity ?? null,
          ociUnit: '',
          ociUnitPrice: 0,
          ociEstimatedCost: null,
          savingsAmount: 0,
          savingsPct: 0,
          isSpotConverted: false,
          hasWindowsLicense: false,
          windowsLicenseCost: 0,
          skipReason,
        };
        rows.push(row);
        insertDocs.push({
          uploadId,
          sourceProvider: row.sourceProvider,
          sourceService: row.sourceService,
          serviceCategory: category,
          sourceCost,
          sourceCurrencyCode: row.sourceCurrencyCode,
          ociSkuPartNumber: null,
          ociSkuName: null,
          ociEquivalentQuantity: row.ociEquivalentQuantity,
          ociUnit: null,
          ociUnitPrice: null,
          ociEstimatedCost: null,
          savingsAmount: null,
          savingsPct: null,
          skipReason,
        });
        continue;
      }

      // ── Step 3: Use resolved mapping for this record ────────────────────────
      const skuPartNumber = mapping.partNumber;
      const skuName = mapping.skuName ?? mapping.partNumber;
      const skuUnit = mapping.unit ?? 'OCPU-hours';
      const skuFallbackPrice = mapping.fallbackUnitPrice ?? 0;

      // Price keyed by partNumber — live or fallback
      const ociUnitPrice = ociPrices[skuPartNumber] ?? skuFallbackPrice;

      const sourceCost = record.costAfterTax ?? record.costBeforeTax ?? 0;
      const ociEquivalentQuantity = record.ociEquivalentQuantity ?? null;

      // Fix 4: Detect AWS Spot → log conversion to On-Demand
      const isSpotConverted =
        providerDetected === 'aws' &&
        SPOT_PATTERN.test(`${productName} ${productCode} ${record.sourceResourceId ?? ''}`);

      if (isSpotConverted) {
        spotCount++;
        this.logger.verbose(
          `[${uploadId}] Spot→On-Demand: "${productName}" converted to OCI On-Demand pricing`,
        );
      }

      // Fix 1: Only use quantity-based path for PAID items (sourceCost > 0).
      // Zero-cost free-tier / included items fall through to the ratio branch
      // where sourceCost * factor = 0, giving ociEstimatedCost = 0 correctly.
      let ociEstimatedCost: number;
      const savingsFactor = SAVINGS_FACTOR[category] ?? 0.30;
      const ratioBasedFallback = sourceCost > 0 ? +(sourceCost * (1 - savingsFactor)).toFixed(4) : 0;

      // Fix 7: Other category — always use ratio-based OCI Est. Cost. "Other" includes mixed units
      // (e.g. IP address-hours, VPC endpoint-hours) that do not map to a single OCI SKU unit (e.g. OCPU-hour).
      // Using quantity × OCI unit price produces wrong OCI Est. Cost and negative Save %. Formula: OCI Est. Cost = Source Cost × (1 - savingsFactor).
      const isOtherCategory = category === OciServiceCategory.OTHER;

      if (isOtherCategory) {
        ociEstimatedCost = ratioBasedFallback;
      } else if (ociEquivalentQuantity != null && ociEquivalentQuantity > 0 && sourceCost > 0) {
        let quantityBasedOciCost: number;
        // Fix 5: Network free tier — first 10 TB/month of outbound egress is free on OCI
        if (
          category === OciServiceCategory.NETWORK &&
          ociEquivalentQuantity <= OCI_FREE_NETWORK_EGRESS_GB
        ) {
          quantityBasedOciCost = 0;
          this.logger.verbose(
            `[${uploadId}] Network free tier applied: ${ociEquivalentQuantity.toFixed(2)} GB ≤ 10 TB`,
          );
        } else if (
          category === OciServiceCategory.NETWORK &&
          ociEquivalentQuantity > OCI_FREE_NETWORK_EGRESS_GB
        ) {
          quantityBasedOciCost = +((ociEquivalentQuantity - OCI_FREE_NETWORK_EGRESS_GB) * ociUnitPrice).toFixed(4);
        } else {
          quantityBasedOciCost = +(ociEquivalentQuantity * ociUnitPrice).toFixed(4);
        }

        // Fix 6: Use quantity-based only when result is in plausible range vs source cost.
        // Otherwise source quantity is likely in wrong units (e.g. request count vs GB-month).
        const ratio = quantityBasedOciCost / sourceCost;
        const useQuantityBased =
          quantityBasedOciCost === 0 ||
          (ratio >= OCI_COST_VS_SOURCE_MIN_RATIO && ratio <= OCI_COST_VS_SOURCE_MAX_RATIO);
        if (useQuantityBased) {
          ociEstimatedCost = quantityBasedOciCost;
        } else {
          ociEstimatedCost = ratioBasedFallback;
          this.logger.verbose(
            `[${uploadId}] Unit-mismatch fallback: "${productName}" quantity-based OCI ${quantityBasedOciCost.toFixed(2)} (${(ratio * 100).toFixed(0)}% of source) → ratio-based ${ratioBasedFallback.toFixed(2)}`,
          );
        }
      } else {
        // Ratio-based estimate using source cost (also handles free-tier: 0 * anything = 0)
        ociEstimatedCost = ratioBasedFallback;
      }

      // Fix 2: Add Windows Server license cost (B88318) for Windows Compute items.
      // Requirements: "Windows license is always charged unless BYOL is explicitly stated"
      // Pricing: OCPU per Hour × $0.092 (B88318)
      let windowsLicenseCost = 0;
      const hasWindowsLicense = record.isWindowsLicensed === true && category === OciServiceCategory.COMPUTE;
      if (hasWindowsLicense) {
        if (ociEquivalentQuantity != null && ociEquivalentQuantity > 0 && sourceCost > 0) {
          // Precise: quantity × live B88318 price/OCPU-hour
          windowsLicenseCost = +(ociEquivalentQuantity * windowsLivePricePerOcpuHour).toFixed(4);
        } else if (sourceCost > 0) {
          // Estimate: Windows overhead ratio vs base compute price
          const computeFallback = this.ociSkuCatalog.getFallbackForCategory(OciServiceCategory.COMPUTE);
          const computeBasePrice = ociPrices[computeFallback.partNumber] ?? computeFallback.fallbackUnitPrice;
          const windowsRatio = windowsLivePricePerOcpuHour / computeBasePrice;
          windowsLicenseCost = +(ociEstimatedCost * windowsRatio).toFixed(4);
        }
        ociEstimatedCost = +(ociEstimatedCost + windowsLicenseCost).toFixed(4);
        windowsCount++;
        this.logger.verbose(
          `[${uploadId}] Windows license (${WINDOWS_LICENSE_SKU}): +$${windowsLicenseCost.toFixed(4)} for "${productName}"`,
        );
      }

      const savingsAmount = +(sourceCost - ociEstimatedCost).toFixed(4);
      const savingsPct =
        sourceCost > 0 ? +((savingsAmount / sourceCost) * 100).toFixed(2) : 0;

      const row: LiftAndShiftRow = {
        sourceService: productName || productCode || category,
        serviceCategory: category,
        sourceProvider: record.provider ?? providerDetected,
        sourceCost,
        sourceCurrencyCode: record.currencyCode ?? currencyCode,
        ociSkuPartNumber: skuPartNumber,
        ociSkuName: skuName,
        ociEquivalentQuantity,
        ociUnit: skuUnit,
        ociUnitPrice,
        ociEstimatedCost,
        savingsAmount,
        savingsPct,
        isSpotConverted,
        hasWindowsLicense,
        windowsLicenseCost,
      };
      rows.push(row);

      insertDocs.push({
        uploadId,
        sourceProvider: row.sourceProvider,
        sourceService: row.sourceService,
        serviceCategory: category,
        sourceCost,
        sourceCurrencyCode: row.sourceCurrencyCode,
        ociSkuPartNumber: skuPartNumber,
        ociSkuName: skuName,
        ociEquivalentQuantity,
        ociUnit: skuUnit,
        ociUnitPrice,
        ociEstimatedCost,
        savingsAmount,
        savingsPct,
      });
    }

    if (insertDocs.length > 0) {
      for (let i = 0; i < insertDocs.length; i += BULK_INSERT_BATCH_SIZE) {
        const batch = insertDocs.slice(i, i + BULK_INSERT_BATCH_SIZE);
        await withMongoRetry(() =>
          this.modelingModel.insertMany(batch, { ordered: false }),
        );
      }
    }

    if (spotCount > 0) {
      this.logger.log(
        `[${uploadId}] Spot→On-Demand: ${spotCount} AWS Spot instance(s) converted to OCI On-Demand pricing`,
      );
    }
    if (windowsCount > 0) {
      this.logger.log(
        `[${uploadId}] Windows licensing: ${windowsCount} item(s) charged Windows Server license (${WINDOWS_LICENSE_SKU} @ $${WINDOWS_LICENSE_PRICE_PER_OCPU_HOUR}/OCPU-hour)`,
      );
    }

    const result = this.buildResult(uploadId, providerDetected, currencyCode, rows);

    this.logger.log(
      `[${uploadId}] Modeling complete: ${rows.length} records, ` +
        `source=${result.summary.totalSourceCost.toFixed(2)} ${currencyCode}, ` +
        `oci=${result.summary.totalOciEstimatedCost.toFixed(2)} ${currencyCode}, ` +
        `savings=${result.summary.totalSavingsPct.toFixed(1)}%`,
    );

    return result;
  }

  // ---------------------------------------------------------------------------
  // getByUploadId() — retrieve existing modeling results
  // ---------------------------------------------------------------------------

  async getByUploadId(
    uploadId: string,
    currencyCode: string = 'USD',
  ): Promise<LiftAndShiftResult | null> {
    const docs = await this.modelingModel
      .find({ uploadId })
      .lean()
      .exec();

    if (!docs.length) return null;

    const rows: LiftAndShiftRow[] = docs.map((d) => {
      const skipReason = d.skipReason ?? null;
      const ociEstimatedCost = d.ociEstimatedCost ?? (skipReason ? null : 0);
      return {
        sourceService: d.sourceService ?? d.resourceId ?? 'Unknown',
        serviceCategory: d.serviceCategory ?? OciServiceCategory.OTHER,
        sourceProvider: d.sourceProvider ?? d.sourceCloud ?? 'unknown',
        sourceCost: d.sourceCost ?? 0,
        sourceCurrencyCode: d.sourceCurrencyCode ?? currencyCode,
        ociSkuPartNumber: d.ociSkuPartNumber ?? d.ociTargetSku ?? '',
        ociSkuName: d.ociSkuName ?? '',
        ociEquivalentQuantity: d.ociEquivalentQuantity ?? null,
        ociUnit: d.ociUnit ?? '',
        ociUnitPrice: d.ociUnitPrice ?? 0,
        ociEstimatedCost,
        savingsAmount: d.savingsAmount ?? 0,
        savingsPct: d.savingsPct ?? 0,
        isSpotConverted: false,   // not persisted in schema; re-modelling required for this flag
        hasWindowsLicense: false, // not persisted in schema; re-modelling required for this flag
        windowsLicenseCost: 0,
        skipReason: skipReason || undefined,
      };
    });

    const provider =
      rows.find((r) => r.sourceProvider !== 'unknown')?.sourceProvider ?? 'unknown';
    return this.buildResult(uploadId, provider, currencyCode, rows);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch OCI prices for every unique part number concurrently.
   *
   * Strategy per part number (in priority order):
   *   1. Live OCI Pricing API (`fetchOciPriceByPartNumber`)
   *   2. Fallback from OCI SKU catalog fallbackUnitPrice
   *
   * Returns a map keyed by partNumber → unit price (USD or requested currency).
   */
  private async fetchOciPricesByPartNumbers(
    partNumbers: string[],
    currencyCode: string,
  ): Promise<Record<string, number>> {
    const fallbackByPartNumber: Record<string, number> = {};
    for (const sku of this.ociSkuCatalog.getAll()) {
      fallbackByPartNumber[sku.partNumber] = sku.fallbackUnitPrice;
    }
    fallbackByPartNumber[WINDOWS_LICENSE_SKU] = WINDOWS_LICENSE_PRICE_PER_OCPU_HOUR;

    // Fetch all part numbers concurrently
    const results = await Promise.allSettled(
      partNumbers.map(async (partNumber) => {
        // 1. Try live OCI Pricing API
        const live = await this.pricingService.fetchOciPriceByPartNumber(partNumber, currencyCode);
        if (live && live.unitPrice > 0) {
          this.logger.debug(`[pricing] ${partNumber} → $${live.unitPrice} (live API)`);
          return { partNumber, price: live.unitPrice };
        }

        // 2. Fall back to catalog/constant
        const fallback = fallbackByPartNumber[partNumber] ?? 0;
        this.logger.warn(`[pricing] ${partNumber} not found in live API — using fallback $${fallback}`);
        return { partNumber, price: fallback };
      }),
    );

    const prices: Record<string, number> = {};
    for (const result of results) {
      if (result.status === 'fulfilled') {
        prices[result.value.partNumber] = result.value.price;
      } else {
        this.logger.error(`[pricing] Unexpected error fetching price: ${result.reason}`);
      }
    }

    this.logger.log(
      `[pricing] Fetched ${Object.keys(prices).length} SKU price(s) for ${currencyCode}: ` +
        Object.entries(prices).map(([pn, p]) => `${pn}=$${p}`).join(', '),
    );

    return prices;
  }

  private buildResult(
    uploadId: string,
    providerDetected: string,
    currencyCode: string,
    rows: LiftAndShiftRow[],
  ): LiftAndShiftResult {
    let totalSourceCost = 0;
    let totalOciEstimatedCost = 0;
    let skippedCount = 0;
    let skippedSourceCost = 0;
    const byCategory: Record<string, { sourceCost: number; ociCost: number; savings: number }> = {};

    for (const row of rows) {
      totalSourceCost += row.sourceCost;
      if (row.skipReason != null && row.skipReason !== '' && row.ociEstimatedCost == null) {
        skippedCount++;
        skippedSourceCost += row.sourceCost;
      } else {
        totalOciEstimatedCost += row.ociEstimatedCost ?? 0;
        const cat = row.serviceCategory;
        if (!byCategory[cat]) {
          byCategory[cat] = { sourceCost: 0, ociCost: 0, savings: 0 };
        }
        byCategory[cat].sourceCost += row.sourceCost;
        byCategory[cat].ociCost += row.ociEstimatedCost ?? 0;
        byCategory[cat].savings += row.savingsAmount;
      }
    }

    for (const cat of Object.keys(byCategory)) {
      byCategory[cat].sourceCost = +byCategory[cat].sourceCost.toFixed(4);
      byCategory[cat].ociCost = +byCategory[cat].ociCost.toFixed(4);
      byCategory[cat].savings = +byCategory[cat].savings.toFixed(4);
    }

    const totalSavings = +(totalSourceCost - totalOciEstimatedCost - skippedSourceCost).toFixed(4);
    const sourceCostForPct = totalSourceCost - skippedSourceCost;
    const totalSavingsPct =
      sourceCostForPct > 0 ? +((totalSavings / sourceCostForPct) * 100).toFixed(2) : 0;

    return {
      uploadId,
      sourceProvider: providerDetected,
      currencyCode,
      rows,
      summary: {
        totalSourceCost: +totalSourceCost.toFixed(4),
        totalOciEstimatedCost: +totalOciEstimatedCost.toFixed(4),
        totalSavings,
        totalSavingsPct,
        byCategory,
        skippedCount,
        skippedSourceCost: +skippedSourceCost.toFixed(4),
      },
    };
  }

  private emptyResult(uploadId: string, currencyCode: string): LiftAndShiftResult {
    return {
      uploadId,
      sourceProvider: 'unknown',
      currencyCode,
      rows: [],
      summary: {
        totalSourceCost: 0,
        totalOciEstimatedCost: 0,
        totalSavings: 0,
        totalSavingsPct: 0,
        byCategory: {},
        skippedCount: 0,
        skippedSourceCost: 0,
      },
    };
  }
}

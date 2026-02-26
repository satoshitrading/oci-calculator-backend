import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OciCostModeling } from '../database/schemas/oci-cost-modeling.schema';
import { UnifiedBilling } from '../database/schemas/unified-billing.schema';
import { PricingService } from '../calculate/pricing.service';
import { OciServiceCategory } from '../documents/ingestion.types';

// ---------------------------------------------------------------------------
// OCI SKU defaults per service category
// ---------------------------------------------------------------------------
interface SkuDefault {
  partNumber: string;
  skuName: string;
  unit: string;
  fallbackUnitPrice: number; // USD
}

// ---------------------------------------------------------------------------
// Fix 3: Fine-grained DATABASE sub-type mapping
// Preserves service equivalence per requirements:
//   "PostgreSQL remains PostgreSQL, SQL Server remains SQL Server"
// ---------------------------------------------------------------------------
const DATABASE_SUBTYPE_MAP: Array<{ pattern: RegExp; sku: SkuDefault }> = [
  // SQL Server — $0.37/OCPU includes Windows + SQL Server Standard license
  {
    pattern: /sql.?server|sqlserver|mssql|sql express/i,
    sku: {
      partNumber: 'B88439',
      skuName: 'DBCS SQL Server Standard — OCPU per Hour (incl. license)',
      unit: 'OCPU-hours',
      fallbackUnitPrice: 0.37, // per requirements line 661
    },
  },
  // PostgreSQL (RDS PostgreSQL, Aurora PostgreSQL)
  {
    pattern: /postgres|aurora.?postgres|pg\b/i,
    sku: {
      partNumber: 'B103399',
      skuName: 'PostgreSQL Database — OCPU per Hour',
      unit: 'OCPU-hours',
      fallbackUnitPrice: 0.0544,
    },
  },
  // Autonomous Data Warehouse (Redshift, Athena, BigQuery, Synapse)
  {
    pattern: /redshift|athena|bigquery|synapse|data.?warehouse|dwh/i,
    sku: {
      partNumber: 'B91962',
      skuName: 'Autonomous Data Warehouse — OCPU per Hour',
      unit: 'OCPU-hours',
      fallbackUnitPrice: 0.26,
    },
  },
  // NoSQL (DynamoDB, DocumentDB, MongoDB, Neptune, Cosmos DB, Firestore)
  {
    pattern: /dynamo|documentdb|mongodb|neptune|cosmos|firestore|nosql/i,
    sku: {
      partNumber: 'B89037',
      skuName: 'NoSQL Database — On-Demand',
      unit: 'units',
      fallbackUnitPrice: 0.0025,
    },
  },
  // Cache (ElastiCache Redis/Memcached, Azure Cache, Cloud Memorystore)
  {
    pattern: /elasticache|redis|memcache|cache for redis/i,
    sku: {
      partNumber: 'B103069',
      skuName: 'Cache with Redis — GB per Hour',
      unit: 'GB-hours',
      fallbackUnitPrice: 0.013,
    },
  },
  // Aurora MySQL / standard MySQL / MariaDB (default database)
  {
    pattern: /mysql|aurora.?mysql|mariadb|aurora\b/i,
    sku: {
      partNumber: 'B89021',
      skuName: 'MySQL HeatWave — OCPU per Hour',
      unit: 'OCPU-hours',
      fallbackUnitPrice: 0.0544,
    },
  },
];

// Default DATABASE SKU when no sub-type pattern matches
const DATABASE_DEFAULT_SKU: SkuDefault = {
  partNumber: 'B89021',
  skuName: 'MySQL HeatWave — OCPU per Hour',
  unit: 'OCPU-hours',
  fallbackUnitPrice: 0.0544,
};

const CATEGORY_SKU_MAP: Record<OciServiceCategory | string, SkuDefault> = {
  [OciServiceCategory.COMPUTE]: {
    partNumber: 'B88298',
    skuName: 'VM.Standard.E4.Flex — OCPU per Hour',
    unit: 'OCPU-hours',
    fallbackUnitPrice: 0.025,
  },
  [OciServiceCategory.STORAGE]: {
    partNumber: 'B89879',
    skuName: 'Block Volume Storage Capacity — GB per Month',
    unit: 'GB-month',
    fallbackUnitPrice: 0.0255,
  },
  [OciServiceCategory.NETWORK]: {
    partNumber: 'B90046',
    skuName: 'Outbound Data Transfer — GB',
    unit: 'GB',
    fallbackUnitPrice: 0.0085,
  },
  [OciServiceCategory.DATABASE]: DATABASE_DEFAULT_SKU,
  [OciServiceCategory.GENAI]: {
    partNumber: 'B103447',
    skuName: 'OCI Generative AI — On-Demand Inference',
    unit: 'units',
    fallbackUnitPrice: 0.006,
  },
  [OciServiceCategory.OTHER]: {
    partNumber: 'B88298',
    skuName: 'VM.Standard.E4.Flex — OCPU per Hour (fallback)',
    unit: 'OCPU-hours',
    fallbackUnitPrice: 0.025,
  },
};

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
  ociEstimatedCost: number;
  savingsAmount: number;
  savingsPct: number;
  /** Fix 4: true when an AWS Spot instance was converted to OCI On-Demand */
  isSpotConverted: boolean;
  /** Fix 2: true when Windows Server license (B88318) cost was added */
  hasWindowsLicense: boolean;
  /** Fix 2: additional Windows license cost added on top of base compute cost */
  windowsLicenseCost: number;
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
  ) {}

  // ---------------------------------------------------------------------------
  // model() — run lift-and-shift for an uploadId, persist, return result
  // ---------------------------------------------------------------------------

  async model(
    uploadId: string,
    currencyCode: string = 'USD',
  ): Promise<LiftAndShiftResult> {
    this.logger.log(`[${uploadId}] Starting OCI lift-and-shift modeling`);

    const billingRecords = await this.unifiedBillingModel
      .find({ uploadId })
      .lean()
      .exec();

    if (!billingRecords.length) {
      return this.emptyResult(uploadId, currencyCode);
    }

    // Delete any prior modeling records for this upload (idempotent re-run)
    await this.modelingModel.deleteMany({ uploadId });

    const providerDetected =
      billingRecords.find((r) => r.provider && r.provider !== 'unknown')?.provider ??
      billingRecords[0]?.provider ??
      'unknown';

    // ── Step 1: Pre-resolve every SKU so we know ALL part numbers needed ──────
    // This is done before the main loop so we can batch-fetch live prices for
    // every unique part number in a single concurrent round-trip.
    const resolvedSkus: SkuDefault[] = billingRecords.map((record) => {
      const category = (record.serviceCategory as OciServiceCategory) ?? OciServiceCategory.OTHER;
      return category === OciServiceCategory.DATABASE
        ? this.resolveDbSku(record.productName ?? '', record.productCode ?? '')
        : (CATEGORY_SKU_MAP[category] ?? CATEGORY_SKU_MAP[OciServiceCategory.OTHER]);
    });

    // Collect unique part numbers: all resolved SKUs + Windows license SKU
    const partNumbersNeeded = new Set<string>(resolvedSkus.map((s) => s.partNumber));
    // Always pre-fetch Windows license so it's ready for any Windows Compute row
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
      const record = billingRecords[i]!;
      const category = (record.serviceCategory as OciServiceCategory) ?? OciServiceCategory.OTHER;
      const productName = record.productName ?? '';
      const productCode = record.productCode ?? '';

      // ── Step 3: Use pre-resolved SKU for this record ──────────────────────
      const skuDefault = resolvedSkus[i]!;

      // Price keyed by partNumber — always the correct SKU price (live or fallback)
      const ociUnitPrice = ociPrices[skuDefault.partNumber] ?? skuDefault.fallbackUnitPrice;

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
          const baseOciCost = ociEstimatedCost;
          const computeBasePrice = ociPrices[CATEGORY_SKU_MAP[OciServiceCategory.COMPUTE].partNumber]
            ?? CATEGORY_SKU_MAP[OciServiceCategory.COMPUTE].fallbackUnitPrice;
          const windowsRatio = windowsLivePricePerOcpuHour / computeBasePrice;
          windowsLicenseCost = +(baseOciCost * windowsRatio).toFixed(4);
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
        ociSkuPartNumber: skuDefault.partNumber,
        ociSkuName: skuDefault.skuName,
        ociEquivalentQuantity,
        ociUnit: skuDefault.unit,
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
        ociSkuPartNumber: skuDefault.partNumber,
        ociSkuName: skuDefault.skuName,
        ociEquivalentQuantity,
        ociUnit: skuDefault.unit,
        ociUnitPrice,
        ociEstimatedCost,
        savingsAmount,
        savingsPct,
      });
    }

    if (insertDocs.length > 0) {
      await this.modelingModel.insertMany(insertDocs);
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
      .find({ uploadId, ociEstimatedCost: { $ne: null } })
      .lean()
      .exec();

    if (!docs.length) return null;

    const rows: LiftAndShiftRow[] = docs.map((d) => ({
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
      ociEstimatedCost: d.ociEstimatedCost ?? 0,
      savingsAmount: d.savingsAmount ?? 0,
      savingsPct: d.savingsPct ?? 0,
      isSpotConverted: false,   // not persisted in schema; re-modelling required for this flag
      hasWindowsLicense: false, // not persisted in schema; re-modelling required for this flag
      windowsLicenseCost: 0,
    }));

    const provider =
      rows.find((r) => r.sourceProvider !== 'unknown')?.sourceProvider ?? 'unknown';
    return this.buildResult(uploadId, provider, currencyCode, rows);
  }

  // ---------------------------------------------------------------------------
  // Fix 3: Resolve DATABASE sub-type SKU from product name / code
  // ---------------------------------------------------------------------------

  private resolveDbSku(productName: string, productCode: string): SkuDefault {
    const combined = `${productName} ${productCode}`;
    for (const { pattern, sku } of DATABASE_SUBTYPE_MAP) {
      if (pattern.test(combined)) return sku;
    }
    return DATABASE_DEFAULT_SKU;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch live OCI prices for every unique part number concurrently.
   *
   * Strategy per part number (in priority order):
   *   1. Local MongoDB cache  (`getPriceFromDb`)
   *   2. Live OCI Pricing API (`fetchOciPriceByPartNumber`)
   *   3. Hardcoded fallback from `SkuDefault.fallbackUnitPrice`
   *
   * Returns a map keyed by partNumber → unit price (USD or requested currency).
   */
  private async fetchOciPricesByPartNumbers(
    partNumbers: string[],
    currencyCode: string,
  ): Promise<Record<string, number>> {
    // Build a lookup of fallback prices from every known SKU definition
    const fallbackByPartNumber: Record<string, number> = {};
    for (const sku of Object.values(CATEGORY_SKU_MAP)) {
      fallbackByPartNumber[sku.partNumber] = sku.fallbackUnitPrice;
    }
    for (const { sku } of DATABASE_SUBTYPE_MAP) {
      fallbackByPartNumber[sku.partNumber] = sku.fallbackUnitPrice;
    }
    fallbackByPartNumber[WINDOWS_LICENSE_SKU] = WINDOWS_LICENSE_PRICE_PER_OCPU_HOUR;

    // Fetch all part numbers concurrently
    const results = await Promise.allSettled(
      partNumbers.map(async (partNumber) => {
        // 1. Try local DB cache first (fast, no network)
        const fromDb = await this.pricingService.getPriceFromDb(partNumber, currencyCode);
        if (fromDb && fromDb.unitPrice > 0) {
          this.logger.debug(`[pricing] ${partNumber} → $${fromDb.unitPrice} (DB cache)`);
          return { partNumber, price: fromDb.unitPrice };
        }

        // 2. Try live OCI Pricing API
        const live = await this.pricingService.fetchOciPriceByPartNumber(partNumber, currencyCode);
        if (live && live.unitPrice > 0) {
          this.logger.debug(`[pricing] ${partNumber} → $${live.unitPrice} (live API)`);
          return { partNumber, price: live.unitPrice };
        }

        // 3. Fall back to hardcoded constant
        const fallback = fallbackByPartNumber[partNumber] ?? 0;
        this.logger.warn(`[pricing] ${partNumber} not found in DB or live API — using fallback $${fallback}`);
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
    const byCategory: Record<string, { sourceCost: number; ociCost: number; savings: number }> = {};

    for (const row of rows) {
      totalSourceCost += row.sourceCost;
      totalOciEstimatedCost += row.ociEstimatedCost;

      const cat = row.serviceCategory;
      if (!byCategory[cat]) {
        byCategory[cat] = { sourceCost: 0, ociCost: 0, savings: 0 };
      }
      byCategory[cat].sourceCost += row.sourceCost;
      byCategory[cat].ociCost += row.ociEstimatedCost;
      byCategory[cat].savings += row.savingsAmount;
    }

    for (const cat of Object.keys(byCategory)) {
      byCategory[cat].sourceCost = +byCategory[cat].sourceCost.toFixed(4);
      byCategory[cat].ociCost = +byCategory[cat].ociCost.toFixed(4);
      byCategory[cat].savings = +byCategory[cat].savings.toFixed(4);
    }

    const totalSavings = +(totalSourceCost - totalOciEstimatedCost).toFixed(4);
    const totalSavingsPct =
      totalSourceCost > 0 ? +((totalSavings / totalSourceCost) * 100).toFixed(2) : 0;

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
      },
    };
  }
}

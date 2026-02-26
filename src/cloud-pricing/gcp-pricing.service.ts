import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

// ──────────────────────────────────────────────────────────────────────────────
// GCP Cloud Billing API
// Endpoint: https://cloudbilling.googleapis.com/v1/services/{serviceId}/skus
// Auth: API Key (GCP_PRICING_API_KEY env var) — no OAuth required for public pricing
// ──────────────────────────────────────────────────────────────────────────────

const GCP_BILLING_BASE = 'https://cloudbilling.googleapis.com/v1';

/** Well-known GCP service IDs for common services */
export const GCP_SERVICE_IDS = {
  COMPUTE_ENGINE: '6F81-5844-456A',
  CLOUD_STORAGE:  '95FF-2EF5-5EA1',
  CLOUD_SQL:      '9662-B51E-5089',
  BIGQUERY:       '24E6-581D-38E5',
  KUBERNETES:     '95FF-2EF5-5EA1',
} as const;

export interface GcpSku {
  name: string;
  skuId: string;
  description: string;
  category: {
    serviceDisplayName: string;
    resourceFamily: string;
    resourceGroup: string;
    usageType: string;
  };
  serviceRegions: string[];
  pricingInfo: Array<{
    effectiveTime: string;
    pricingExpression: {
      usageUnit: string;
      usageUnitDescription: string;
      tieredRates: Array<{
        startUsageAmount: number;
        unitPrice: { currencyCode: string; units: string; nanos: number };
      }>;
    };
  }>;
}

export interface GcpPriceResult {
  provider: 'gcp';
  serviceId: string;
  skuId: string;
  description: string;
  region: string;
  unitPrice: number;
  unit: string;
  currencyCode: string;
  resourceFamily: string;
  usageType: string;
}

@Injectable()
export class GcpPricingService {
  private readonly logger = new Logger(GcpPricingService.name);
  private readonly apiKey: string | undefined;
  private readonly cache = new Map<string, GcpPriceResult | null>();
  /** Cache of SKU lists keyed by serviceId */
  private readonly skuCache = new Map<string, GcpSku[]>();

  constructor() {
    this.apiKey = process.env.GCP_PRICING_API_KEY;
    if (!this.apiKey) {
      this.logger.warn('GCP_PRICING_API_KEY not set — GCP pricing lookups will be skipped');
    }
  }

  get isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Fetch all SKUs for a GCP service and cache them.
   * Uses pageSize=5000 for a single-request bulk fetch.
   */
  async getSkusForService(serviceId: string): Promise<GcpSku[]> {
    if (!this.isConfigured) return [];
    if (this.skuCache.has(serviceId)) return this.skuCache.get(serviceId)!;

    const url = `${GCP_BILLING_BASE}/services/${serviceId}/skus`;
    try {
      const response = await axios.get<{ skus: GcpSku[] }>(url, {
        params: { key: this.apiKey, pageSize: 5000, currencyCode: 'USD' },
        timeout: 20000,
      });
      const skus = response.data?.skus ?? [];
      this.skuCache.set(serviceId, skus);
      return skus;
    } catch (err) {
      this.logger.warn(`GCP Billing API error for service ${serviceId}: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Lookup Compute Engine on-demand price for a given machine type and region.
   *
   * Strategy: filter SKUs by resourceGroup matching the machine family,
   * then pick the SKU covering the requested region.
   *
   * @param machineType - e.g. "n1-standard-4", "n2-standard-8", "e2-medium"
   * @param region      - GCP region, e.g. "us-central1"
   */
  async getComputeOnDemandPrice(
    machineType: string,
    region: string = 'us-central1',
  ): Promise<GcpPriceResult | null> {
    const cacheKey = `compute:${machineType}:${region}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

    const skus = await this.getSkusForService(GCP_SERVICE_IDS.COMPUTE_ENGINE);
    if (!skus.length) { this.cache.set(cacheKey, null); return null; }

    // Extract machine family from type: "n2-standard-8" → "N2"
    const familyMatch = /^([a-z][a-z0-9]*)[-/]/.exec(machineType.toLowerCase());
    const family = familyMatch ? familyMatch[1].toUpperCase() : '';

    // Find VCPU SKU for this family (On Demand, running)
    const vcpuSku = skus.find((s) =>
      s.category.usageType === 'OnDemand' &&
      s.category.resourceFamily === 'Compute' &&
      s.description.toLowerCase().includes('instance core') &&
      (family ? s.description.toUpperCase().includes(family) : true) &&
      s.serviceRegions.includes(region),
    );

    const result = vcpuSku ? this.skuToResult(vcpuSku, GCP_SERVICE_IDS.COMPUTE_ENGINE, region) : null;
    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * Lookup Cloud SQL on-demand price for a given database tier and region.
   *
   * @param dbEngine - "MySQL" | "PostgreSQL" | "SQL Server"
   * @param tier     - e.g. "db-n1-standard-4"
   * @param region   - GCP region
   */
  async getCloudSqlPrice(
    dbEngine: string,
    tier: string = 'db-n1-standard-4',
    region: string = 'us-central1',
  ): Promise<GcpPriceResult | null> {
    const cacheKey = `sql:${dbEngine}:${tier}:${region}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

    const skus = await this.getSkusForService(GCP_SERVICE_IDS.CLOUD_SQL);
    if (!skus.length) { this.cache.set(cacheKey, null); return null; }

    const engine = dbEngine.toLowerCase().includes('postgres') ? 'PostgreSQL'
      : dbEngine.toLowerCase().includes('sql server') ? 'SQL Server'
      : 'MySQL';

    const sku = skus.find((s) =>
      s.category.usageType === 'OnDemand' &&
      s.description.toLowerCase().includes(engine.toLowerCase()) &&
      s.description.toLowerCase().includes('vcpu') &&
      s.serviceRegions.includes(region),
    );

    const result = sku ? this.skuToResult(sku, GCP_SERVICE_IDS.CLOUD_SQL, region) : null;
    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * Extract a machine type from a GCP product name/code.
   * Examples:
   *   "Compute Engine - n2-standard-8"  → "n2-standard-8"
   *   "n1-standard-4"                   → "n1-standard-4"
   */
  extractMachineType(productName: string): string | null {
    const match = /([a-z][a-z0-9]*-[a-z]+-[0-9]+(?:-[0-9]+)?)/i.exec(productName);
    return match ? match[1].toLowerCase() : null;
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private skuToResult(sku: GcpSku, serviceId: string, region: string): GcpPriceResult {
    const pricing = sku.pricingInfo?.[0]?.pricingExpression;
    const baseRate = pricing?.tieredRates?.find((r) => r.startUsageAmount === 0)
      ?? pricing?.tieredRates?.[0];

    const nanos = baseRate?.unitPrice?.nanos ?? 0;
    const units = parseInt(baseRate?.unitPrice?.units ?? '0', 10);
    const unitPrice = units + nanos / 1e9;

    return {
      provider: 'gcp',
      serviceId,
      skuId: sku.skuId,
      description: sku.description,
      region,
      unitPrice,
      unit: pricing?.usageUnitDescription ?? pricing?.usageUnit ?? 'hour',
      currencyCode: baseRate?.unitPrice?.currencyCode ?? 'USD',
      resourceFamily: sku.category.resourceFamily,
      usageType: sku.category.usageType,
    };
  }
}

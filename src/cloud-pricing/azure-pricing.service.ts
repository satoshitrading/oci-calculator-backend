import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

// ──────────────────────────────────────────────────────────────────────────────
// Azure Retail Prices API
// Endpoint: https://prices.azure.com/api/retail/prices
// Auth: None — completely public
// Docs: https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices
// ──────────────────────────────────────────────────────────────────────────────

const AZURE_PRICING_BASE = 'https://prices.azure.com/api/retail/prices';

export interface AzurePriceItem {
  currencyCode: string;
  tierMinimumUnits: number;
  retailPrice: number;
  unitPrice: number;
  armRegionName: string;
  location: string;
  effectiveStartDate: string;
  meterId: string;
  meterName: string;
  productId: string;
  skuId: string;
  productName: string;
  skuName: string;
  serviceName: string;
  serviceId: string;
  serviceFamily: string;
  unitOfMeasure: string;
  type: string;
  isPrimaryMeterRegion: boolean;
  armSkuName: string;
}

export interface AzurePriceResult {
  provider: 'azure';
  skuName: string;
  productName: string;
  serviceName: string;
  armRegionName: string;
  unitPrice: number;
  unitOfMeasure: string;
  currencyCode: string;
  priceType: string;
  meterName: string;
}

interface AzureApiResponse {
  Items: AzurePriceItem[];
  NextPageLink: string | null;
  Count: number;
}

@Injectable()
export class AzurePricingService {
  private readonly logger = new Logger(AzurePricingService.name);
  private readonly cache = new Map<string, AzurePriceResult | null>();

  /**
   * Fetch Azure VM on-demand price for a given ARM SKU and region.
   *
   * @param armSkuName  - e.g. "Standard_D2s_v3", "Standard_E4s_v3"
   * @param region      - ARM region name, e.g. "eastus", "westeurope"
   * @param currencyCode - ISO 4217 currency code, default "USD"
   */
  async getVmPrice(
    armSkuName: string,
    region: string = 'eastus',
    currencyCode: string = 'USD',
  ): Promise<AzurePriceResult | null> {
    const cacheKey = `vm:${armSkuName}:${region}:${currencyCode}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

    // Consumption (pay-as-you-go) price, Linux by default
    const filter = [
      `armSkuName eq '${armSkuName}'`,
      `armRegionName eq '${region}'`,
      `priceType eq 'Consumption'`,
      `serviceName eq 'Virtual Machines'`,
    ].join(' and ');

    const result = await this.query(filter, currencyCode);
    // Prefer Linux (no Windows SKU in name)
    const item = result.find((r) => !r.skuName.toLowerCase().includes('windows')) ?? result[0] ?? null;
    const priceResult = item ? this.toResult(item) : null;
    this.cache.set(cacheKey, priceResult);
    return priceResult;
  }

  /**
   * Fetch Azure SQL Database pricing for a given service SKU and region.
   *
   * @param serviceName  - e.g. "Azure SQL Database", "SQL Database"
   * @param skuName      - e.g. "General Purpose - 4 vCores"
   * @param region       - ARM region name
   * @param currencyCode - ISO 4217 currency code
   */
  async getSqlDatabasePrice(
    serviceName: string,
    skuName: string,
    region: string = 'eastus',
    currencyCode: string = 'USD',
  ): Promise<AzurePriceResult | null> {
    const cacheKey = `sql:${serviceName}:${skuName}:${region}:${currencyCode}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

    const filter = [
      `serviceName eq '${serviceName}'`,
      `armRegionName eq '${region}'`,
      `priceType eq 'Consumption'`,
    ].join(' and ');

    const result = await this.query(filter, currencyCode);
    const item =
      result.find((r) => r.skuName.toLowerCase().includes(skuName.toLowerCase())) ??
      result[0] ??
      null;
    const priceResult = item ? this.toResult(item) : null;
    this.cache.set(cacheKey, priceResult);
    return priceResult;
  }

  /**
   * Generic price lookup by OData filter.
   * Returns the first page of results (max 100 items).
   */
  async query(
    filter: string,
    currencyCode: string = 'USD',
  ): Promise<AzurePriceItem[]> {
    try {
      const response = await axios.get<AzureApiResponse>(AZURE_PRICING_BASE, {
        params: {
          'api-version': '2023-01-01-preview',
          currencyCode: `'${currencyCode}'`,
          $filter: filter,
        },
        timeout: 15000,
      });
      return response.data?.Items ?? [];
    } catch (err) {
      this.logger.warn(`Azure Pricing API error (filter="${filter}"): ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Extract an ARM SKU name from an Azure billing product/meter name.
   * Examples:
   *   "Virtual Machines D2s v3 Series" → "Standard_D2s_v3"
   *   "D4s v3"                          → "Standard_D4s_v3"
   */
  extractArmSkuName(productName: string, meterName?: string): string | null {
    // Try to find an armSkuName pattern like "Standard_D2s_v3"
    const explicit = /\b(Standard_[A-Z][A-Za-z0-9_]+)\b/.exec(productName);
    if (explicit) return explicit[1];

    // Convert "D2s v3" → "Standard_D2s_v3"
    const shortMatch = /\b([A-Z][0-9]+[a-z]*\s+v[0-9]+(?:\s+[A-Z]+)?)\b/.exec(
      meterName ?? productName,
    );
    if (shortMatch) {
      return 'Standard_' + shortMatch[1].replace(/\s+/g, '_');
    }
    return null;
  }

  private toResult(item: AzurePriceItem): AzurePriceResult {
    return {
      provider: 'azure',
      skuName: item.skuName,
      productName: item.productName,
      serviceName: item.serviceName,
      armRegionName: item.armRegionName,
      unitPrice: item.unitPrice,
      unitOfMeasure: item.unitOfMeasure,
      currencyCode: item.currencyCode,
      priceType: item.type,
      meterName: item.meterName,
    };
  }
}

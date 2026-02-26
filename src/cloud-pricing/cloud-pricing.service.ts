import { Injectable, Logger } from '@nestjs/common';
import { AwsPricingService } from './aws-pricing.service';
import { GcpPricingService } from './gcp-pricing.service';
import { AzurePricingService } from './azure-pricing.service';
import { OciServiceCategory } from '../documents/ingestion.types';

// ──────────────────────────────────────────────────────────────────────────────
// Unified Cloud Pricing Service
// Orchestrates AWS / GCP / Azure live pricing lookups to enrich
// OCI lift-and-shift comparisons with real source-cloud list prices.
// ──────────────────────────────────────────────────────────────────────────────

/** Result of a live source-cloud price lookup */
export interface SourceCloudPrice {
  provider: string;
  listPrice: number;
  unit: string;
  currencyCode: string;
  serviceCode: string;
  instanceType: string | null;
  region: string | null;
  /** Human-readable note explaining what was looked up */
  note: string;
}

@Injectable()
export class CloudPricingService {
  private readonly logger = new Logger(CloudPricingService.name);

  constructor(
    private readonly awsPricing: AwsPricingService,
    private readonly gcpPricing: GcpPricingService,
    private readonly azurePricing: AzurePricingService,
  ) {}

  /**
   * Attempt a live source-cloud price lookup for a normalized billing record.
   *
   * The method tries progressively:
   * 1. Extract instance type / SKU from productName / productCode
   * 2. Call the appropriate provider API
   * 3. Return null gracefully if the API is unavailable or the instance is unknown
   *
   * This lookup is best-effort: if it fails the caller continues without it.
   *
   * @param provider        - 'aws' | 'azure' | 'gcp'
   * @param productName     - Source product name (e.g., "Amazon EC2 - m5.xlarge")
   * @param productCode     - Source product code / usage type (e.g., "BoxUsage:m5.xlarge")
   * @param serviceCategory - OCI service category already determined
   * @param regionName      - Source region (e.g., "us-east-1", "eastus")
   * @param isWindows       - True if Windows OS was detected
   */
  async lookupSourcePrice(
    provider: string,
    productName: string,
    productCode: string,
    serviceCategory: OciServiceCategory | string,
    regionName: string | null,
    isWindows: boolean,
  ): Promise<SourceCloudPrice | null> {
    try {
      switch (provider.toLowerCase()) {
        case 'aws':
          return await this.lookupAws(productName, productCode, serviceCategory, regionName, isWindows);
        case 'azure':
          return await this.lookupAzure(productName, productCode, serviceCategory, regionName);
        case 'gcp':
          return await this.lookupGcp(productName, productCode, serviceCategory, regionName);
        default:
          return null;
      }
    } catch (err) {
      this.logger.warn(`Cloud price lookup failed for ${provider}/${productCode}: ${(err as Error).message}`);
      return null;
    }
  }

  // ── AWS ─────────────────────────────────────────────────────────────────────

  private async lookupAws(
    productName: string,
    productCode: string,
    serviceCategory: OciServiceCategory | string,
    regionName: string | null,
    isWindows: boolean,
  ): Promise<SourceCloudPrice | null> {
    const region = regionName ?? 'us-east-1';

    if (serviceCategory === OciServiceCategory.COMPUTE) {
      const instanceType =
        this.awsPricing.extractInstanceType(productCode) ??
        this.awsPricing.extractInstanceType(productName);

      if (!instanceType) return null;

      const os = isWindows ? 'Windows' : 'Linux';
      const price = await this.awsPricing.getEc2OnDemandPrice(instanceType, os, region);
      if (!price) return null;

      return {
        provider: 'aws',
        listPrice: price.unitPrice,
        unit: price.unit,
        currencyCode: price.currencyCode,
        serviceCode: price.serviceCode,
        instanceType: price.instanceType,
        region: price.region,
        note: `AWS EC2 On-Demand — ${instanceType} (${os}) in ${region}`,
      };
    }

    if (serviceCategory === OciServiceCategory.DATABASE) {
      // Try to extract a DB instance class from productCode/productName
      const dbMatch = /db\.[a-z][a-z0-9]*\.[a-z0-9]+/i.exec(`${productCode} ${productName}`);
      if (!dbMatch) return null;

      const dbEngine = this.detectAwsDbEngine(productName, productCode);
      const price = await this.awsPricing.getRdsOnDemandPrice(dbEngine, dbMatch[0], region);
      if (!price) return null;

      return {
        provider: 'aws',
        listPrice: price.unitPrice,
        unit: price.unit,
        currencyCode: price.currencyCode,
        serviceCode: price.serviceCode,
        instanceType: price.instanceType,
        region: price.region,
        note: `AWS RDS On-Demand — ${dbEngine} ${dbMatch[0]} in ${region}`,
      };
    }

    return null;
  }

  // ── Azure ────────────────────────────────────────────────────────────────────

  private async lookupAzure(
    productName: string,
    productCode: string,
    serviceCategory: OciServiceCategory | string,
    regionName: string | null,
  ): Promise<SourceCloudPrice | null> {
    const region = regionName ?? 'eastus';

    if (serviceCategory === OciServiceCategory.COMPUTE) {
      const armSku = this.azurePricing.extractArmSkuName(productName, productCode);
      if (!armSku) return null;

      const price = await this.azurePricing.getVmPrice(armSku, region);
      if (!price) return null;

      return {
        provider: 'azure',
        listPrice: price.unitPrice,
        unit: price.unitOfMeasure,
        currencyCode: price.currencyCode,
        serviceCode: price.serviceName,
        instanceType: price.skuName,
        region: price.armRegionName,
        note: `Azure VM Consumption — ${armSku} in ${region}`,
      };
    }

    if (serviceCategory === OciServiceCategory.DATABASE) {
      const price = await this.azurePricing.getSqlDatabasePrice(
        'Azure SQL Database',
        productCode || productName,
        region,
      );
      if (!price) return null;

      return {
        provider: 'azure',
        listPrice: price.unitPrice,
        unit: price.unitOfMeasure,
        currencyCode: price.currencyCode,
        serviceCode: price.serviceName,
        instanceType: price.skuName,
        region: price.armRegionName,
        note: `Azure SQL Database Consumption — ${price.skuName} in ${region}`,
      };
    }

    return null;
  }

  // ── GCP ──────────────────────────────────────────────────────────────────────

  private async lookupGcp(
    productName: string,
    productCode: string,
    serviceCategory: OciServiceCategory | string,
    regionName: string | null,
  ): Promise<SourceCloudPrice | null> {
    if (!this.gcpPricing.isConfigured) return null;
    const region = regionName ?? 'us-central1';

    if (serviceCategory === OciServiceCategory.COMPUTE) {
      const machineType =
        this.gcpPricing.extractMachineType(productName) ??
        this.gcpPricing.extractMachineType(productCode);

      const price = await this.gcpPricing.getComputeOnDemandPrice(machineType ?? '', region);
      if (!price) return null;

      return {
        provider: 'gcp',
        listPrice: price.unitPrice,
        unit: price.unit,
        currencyCode: price.currencyCode,
        serviceCode: `Compute Engine/${price.skuId}`,
        instanceType: machineType,
        region: price.region,
        note: `GCP Compute Engine On-Demand — ${machineType ?? 'unknown'} in ${region}`,
      };
    }

    if (serviceCategory === OciServiceCategory.DATABASE) {
      const dbEngine = /postgres/i.test(productName) ? 'PostgreSQL'
        : /sql.?server/i.test(productName) ? 'SQL Server'
        : 'MySQL';

      const price = await this.gcpPricing.getCloudSqlPrice(dbEngine, '', region);
      if (!price) return null;

      return {
        provider: 'gcp',
        listPrice: price.unitPrice,
        unit: price.unit,
        currencyCode: price.currencyCode,
        serviceCode: `Cloud SQL/${price.skuId}`,
        instanceType: null,
        region: price.region,
        note: `GCP Cloud SQL On-Demand — ${dbEngine} in ${region}`,
      };
    }

    return null;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private detectAwsDbEngine(productName: string, productCode: string): string {
    const combined = `${productName} ${productCode}`.toLowerCase();
    if (/aurora/i.test(combined)) return 'Aurora MySQL';
    if (/postgres/i.test(combined)) return 'PostgreSQL';
    if (/sql.?server/i.test(combined)) return 'SQL Server';
    if (/oracle/i.test(combined)) return 'Oracle';
    if (/mariadb/i.test(combined)) return 'MariaDB';
    return 'MySQL';
  }
}

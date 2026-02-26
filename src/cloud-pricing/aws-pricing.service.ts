import { Injectable, Logger } from '@nestjs/common';
import {
  PricingClient,
  GetProductsCommand,
  FilterType,
} from '@aws-sdk/client-pricing';

// ──────────────────────────────────────────────────────────────────────────────
// AWS Pricing API
// Endpoint: https://api.pricing.us-east-1.amazonaws.com  (global service)
// Auth: AWS Signature V4 via @aws-sdk/client-pricing
// Credentials: FINOPS_ACCESS_KEY_ID / FINOPS_SECRET_ACCESS_KEY from env
// ──────────────────────────────────────────────────────────────────────────────

/** Maps AWS API region codes to the human-readable location names used by Pricing API */
const AWS_REGION_TO_LOCATION: Record<string, string> = {
  'us-east-1':      'US East (N. Virginia)',
  'us-east-2':      'US East (Ohio)',
  'us-west-1':      'US West (N. California)',
  'us-west-2':      'US West (Oregon)',
  'eu-west-1':      'Europe (Ireland)',
  'eu-west-2':      'Europe (London)',
  'eu-west-3':      'Europe (Paris)',
  'eu-central-1':   'Europe (Frankfurt)',
  'eu-north-1':     'Europe (Stockholm)',
  'eu-south-1':     'Europe (Milan)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'ap-northeast-2': 'Asia Pacific (Seoul)',
  'ap-northeast-3': 'Asia Pacific (Osaka)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
  'ap-south-1':     'Asia Pacific (Mumbai)',
  'ap-east-1':      'Asia Pacific (Hong Kong)',
  'sa-east-1':      'South America (Sao Paulo)',
  'ca-central-1':   'Canada (Central)',
  'me-south-1':     'Middle East (Bahrain)',
  'af-south-1':     'Africa (Cape Town)',
};

export interface AwsPriceResult {
  provider: 'aws';
  serviceCode: string;
  instanceType: string | null;
  operatingSystem: string;
  region: string;
  unitPrice: number;
  unit: string;
  currencyCode: string;
  priceType: 'ON_DEMAND';
  vcpu: string | null;
  memoryGib: string | null;
}

/** Raw product entry returned by AWS Pricing GetProducts */
interface AwsPriceListItem {
  product?: {
    attributes?: {
      instanceType?: string;
      vcpu?: string;
      memory?: string;
      operatingSystem?: string;
    };
  };
  terms?: {
    OnDemand?: Record<
      string,
      {
        priceDimensions?: Record<
          string,
          { unit?: string; pricePerUnit?: Record<string, string> }
        >;
      }
    >;
  };
}

@Injectable()
export class AwsPricingService {
  private readonly logger = new Logger(AwsPricingService.name);
  private readonly client: PricingClient;
  private readonly cache = new Map<string, AwsPriceResult | null>();

  constructor() {
    const accessKeyId = process.env.FINOPS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.FINOPS_SECRET_ACCESS_KEY;
    const region = process.env.AWS_PRICING_REGION ?? 'us-east-1';

    this.client = new PricingClient({
      region,
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    });
  }

  /**
   * Fetch EC2 on-demand hourly price for a given instance type and region.
   *
   * @param instanceType - e.g. "m5.xlarge", "t3.medium"
   * @param os           - "Linux" | "Windows"
   * @param region       - AWS API region code, e.g. "us-east-1"
   */
  async getEc2OnDemandPrice(
    instanceType: string,
    os: 'Linux' | 'Windows' = 'Linux',
    region: string = 'us-east-1',
  ): Promise<AwsPriceResult | null> {
    const cacheKey = `ec2:${instanceType}:${os}:${region}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

    const location = AWS_REGION_TO_LOCATION[region] ?? 'US East (N. Virginia)';

    try {
      const cmd = new GetProductsCommand({
        ServiceCode: 'AmazonEC2',
        Filters: [
          { Type: FilterType.TERM_MATCH, Field: 'instanceType',    Value: instanceType },
          { Type: FilterType.TERM_MATCH, Field: 'operatingSystem', Value: os },
          { Type: FilterType.TERM_MATCH, Field: 'location',        Value: location },
          { Type: FilterType.TERM_MATCH, Field: 'preInstalledSw',  Value: 'NA' },
          { Type: FilterType.TERM_MATCH, Field: 'tenancy',         Value: 'Shared' },
          { Type: FilterType.TERM_MATCH, Field: 'capacitystatus',  Value: 'Used' },
        ],
        FormatVersion: 'aws_v1',
      });

      const response = await this.client.send(cmd);
      const priceListStr = response.PriceList?.[0];
      if (!priceListStr) {
        this.cache.set(cacheKey, null);
        return null;
      }

      const result = this.parseEc2PriceItem(priceListStr, instanceType, os, region);
      this.cache.set(cacheKey, result);
      return result;
    } catch (err) {
      this.logger.warn(`AWS Pricing API error for EC2 ${instanceType} ${os} ${region}: ${(err as Error).message}`);
      this.cache.set(cacheKey, null);
      return null;
    }
  }

  /**
   * Fetch RDS on-demand hourly price for a given DB engine and instance class.
   *
   * @param dbEngine      - e.g. "MySQL", "PostgreSQL", "SQL Server Standard"
   * @param instanceClass - e.g. "db.m5.large"
   * @param region        - AWS API region code
   */
  async getRdsOnDemandPrice(
    dbEngine: string,
    instanceClass: string,
    region: string = 'us-east-1',
  ): Promise<AwsPriceResult | null> {
    const cacheKey = `rds:${dbEngine}:${instanceClass}:${region}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

    const location = AWS_REGION_TO_LOCATION[region] ?? 'US East (N. Virginia)';

    try {
      const cmd = new GetProductsCommand({
        ServiceCode: 'AmazonRDS',
        Filters: [
          { Type: FilterType.TERM_MATCH, Field: 'databaseEngine', Value: dbEngine },
          { Type: FilterType.TERM_MATCH, Field: 'instanceType',   Value: instanceClass },
          { Type: FilterType.TERM_MATCH, Field: 'location',       Value: location },
          { Type: FilterType.TERM_MATCH, Field: 'deploymentOption', Value: 'Single-AZ' },
        ],
        FormatVersion: 'aws_v1',
      });

      const response = await this.client.send(cmd);
      const priceListStr = response.PriceList?.[0];
      if (!priceListStr) {
        this.cache.set(cacheKey, null);
        return null;
      }

      const result = this.parseRdsPriceItem(priceListStr, dbEngine, instanceClass, region);
      this.cache.set(cacheKey, result);
      return result;
    } catch (err) {
      this.logger.warn(`AWS Pricing API error for RDS ${dbEngine} ${instanceClass} ${region}: ${(err as Error).message}`);
      this.cache.set(cacheKey, null);
      return null;
    }
  }

  /**
   * Try to extract an EC2 instance type from an AWS usage type string.
   * Examples:
   *   "BoxUsage:m5.xlarge"    → "m5.xlarge"
   *   "SpotUsage:c5.2xlarge"  → "c5.2xlarge"
   *   "HeavyUsage:t3.medium"  → "t3.medium"
   */
  extractInstanceType(usageType: string): string | null {
    const match = /(?:BoxUsage|SpotUsage|HeavyUsage|UnusedBox|DedicatedUsage|InstanceUsage)[:\s]+([a-z0-9]+\.[a-z0-9]+(?:\.[a-z0-9]+)?)/i.exec(usageType);
    if (match) return match[1];
    // Fallback: bare instance type pattern like "m5.xlarge"
    const bare = /^([a-z][a-z0-9]*\.[a-z0-9]+(?:\.[a-z0-9]+)?)$/i.exec(usageType.trim());
    return bare ? bare[1] : null;
  }

  // ── Private parsers ──────────────────────────────────────────────────────────

  private parseEc2PriceItem(
    priceListStr: string,
    instanceType: string,
    os: string,
    region: string,
  ): AwsPriceResult | null {
    try {
      const item = JSON.parse(priceListStr) as AwsPriceListItem;
      const { unitPrice, unit } = this.extractOnDemandPrice(item);
      if (unitPrice == null) return null;

      return {
        provider: 'aws',
        serviceCode: 'AmazonEC2',
        instanceType,
        operatingSystem: os,
        region,
        unitPrice,
        unit: unit ?? 'Hrs',
        currencyCode: 'USD',
        priceType: 'ON_DEMAND',
        vcpu: item.product?.attributes?.vcpu ?? null,
        memoryGib: item.product?.attributes?.memory ?? null,
      };
    } catch {
      return null;
    }
  }

  private parseRdsPriceItem(
    priceListStr: string,
    dbEngine: string,
    instanceClass: string,
    region: string,
  ): AwsPriceResult | null {
    try {
      const item = JSON.parse(priceListStr) as AwsPriceListItem;
      const { unitPrice, unit } = this.extractOnDemandPrice(item);
      if (unitPrice == null) return null;

      return {
        provider: 'aws',
        serviceCode: 'AmazonRDS',
        instanceType: instanceClass,
        operatingSystem: dbEngine,
        region,
        unitPrice,
        unit: unit ?? 'Hrs',
        currencyCode: 'USD',
        priceType: 'ON_DEMAND',
        vcpu: item.product?.attributes?.vcpu ?? null,
        memoryGib: item.product?.attributes?.memory ?? null,
      };
    } catch {
      return null;
    }
  }

  private extractOnDemandPrice(item: AwsPriceListItem): { unitPrice: number | null; unit: string | null } {
    const onDemand = item.terms?.OnDemand;
    if (!onDemand) return { unitPrice: null, unit: null };

    const [firstTerm] = Object.values(onDemand);
    if (!firstTerm?.priceDimensions) return { unitPrice: null, unit: null };

    const [dim] = Object.values(firstTerm.priceDimensions);
    const usdStr = dim?.pricePerUnit?.['USD'];
    const unitPrice = usdStr != null ? parseFloat(usdStr) : null;
    return { unitPrice, unit: dim?.unit ?? null };
  }
}

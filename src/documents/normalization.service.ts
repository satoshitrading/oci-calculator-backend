import { Injectable } from '@nestjs/common';
import { NormalizedLineItem } from './documents.types';
import { OciServiceCategory, WINDOWS_OCI_SKU } from './ingestion.types';

// ---------------------------------------------------------------------------
// AWS: lineItem/UsageType prefix -> OCI Service Category
// Source: AWS Cost & Usage Report field specification
// ---------------------------------------------------------------------------
const AWS_USAGE_TYPE_MAP: Array<[RegExp, OciServiceCategory]> = [
  // Compute (EC2 instance hours, Spot, Dedicated)
  [/BoxUsage|SpotUsage|DedicatedUsage|InstanceUsage|HeavyUsage|UnusedBox/i, OciServiceCategory.COMPUTE],
  // Storage (EBS volumes, S3, EFS, Glacier)
  [/EBS|VolumeUsage|S3|StorageBytes|Glacier|EFS/i, OciServiceCategory.STORAGE],
  // Network (Data transfer, NAT, VPN, CloudFront)
  [/DataTransfer|NatGateway|VPN|CloudFront|DirectConnect|TransitGateway/i, OciServiceCategory.NETWORK],
  // Database (RDS, Aurora, DynamoDB, ElastiCache, Redshift)
  [/RDS|Aurora|DynamoDB|ElastiCache|Redshift|DocumentDB|Neptune/i, OciServiceCategory.DATABASE],
  // GenAI (SageMaker, Bedrock, Comprehend, Rekognition)
  [/SageMaker|Bedrock|Comprehend|Rekognition|Polly|Transcribe|Translate/i, OciServiceCategory.GENAI],
];

// ---------------------------------------------------------------------------
// Azure: MeterCategory -> OCI Service Category
// Source: Azure Cost Management export field specification
// ---------------------------------------------------------------------------
const AZURE_METER_CATEGORY_MAP: Array<[RegExp, OciServiceCategory]> = [
  [/Virtual Machines|Container Instances|App Service|Functions|Kubernetes/i, OciServiceCategory.COMPUTE],
  [/Storage|Managed Disks|Data Lake|Backup/i, OciServiceCategory.STORAGE],
  [/Bandwidth|VPN Gateway|Load Balancer|ExpressRoute|Traffic Manager|CDN/i, OciServiceCategory.NETWORK],
  [/SQL Database|Azure Database|Cosmos DB|Cache for Redis|Synapse/i, OciServiceCategory.DATABASE],
  [/Azure OpenAI|Cognitive Services|Machine Learning|Bot Service/i, OciServiceCategory.GENAI],
];

// ---------------------------------------------------------------------------
// GCP: service.description -> OCI Service Category
// Source: GCP Billing export schema
// ---------------------------------------------------------------------------
const GCP_SERVICE_MAP: Array<[RegExp, OciServiceCategory]> = [
  [/Compute Engine|Cloud Run|GKE|App Engine/i, OciServiceCategory.COMPUTE],
  [/Cloud Storage|Persistent Disk|Filestore/i, OciServiceCategory.STORAGE],
  [/Networking|Cloud CDN|Cloud Armor|Interconnect/i, OciServiceCategory.NETWORK],
  [/Cloud SQL|BigQuery|Cloud Spanner|Firestore|Bigtable|AlloyDB/i, OciServiceCategory.DATABASE],
  [/Vertex AI|AI Platform|Document AI|Translation API|Vision AI/i, OciServiceCategory.GENAI],
];

// ---------------------------------------------------------------------------
// Generic keyword fallback (provider-agnostic)
// ---------------------------------------------------------------------------
const GENERIC_KEYWORD_MAP: Array<[RegExp, OciServiceCategory]> = [
  [/\b(vm|compute|instance|cpu|ecpu|ocpu|vcpu|server|node)\b/i, OciServiceCategory.COMPUTE],
  [/\b(storage|disk|bucket|blob|volume|ebs|efs|fss|object store)\b/i, OciServiceCategory.STORAGE],
  [/\b(network|bandwidth|data.?transfer|vpn|nat|cdn|dns|load.?balance|egress)\b/i, OciServiceCategory.NETWORK],
  [/\b(database|sql|rds|aurora|cosmos|mongodb|postgresql|mysql|redis|autonomous)\b/i, OciServiceCategory.DATABASE],
  [/\b(genai|generative|llm|openai|bedrock|sagemaker|vertex|copilot|cognitive|ai.?service)\b/i, OciServiceCategory.GENAI],
];

// ---------------------------------------------------------------------------
// OCI FinOps mandatory rules
// ---------------------------------------------------------------------------

/** Brazil IOF/indirect tax rate applied to all BRL-denominated cloud invoices */
const BRL_TAX_RATE = 0.13;

export interface NormalizedBillingRecord extends NormalizedLineItem {
  serviceCategory: OciServiceCategory;
  /** 1 OCPU = 2 vCPUs for x86 Compute; equals usageQuantity for all other categories */
  ociEquivalentQuantity: number | null;
  isGenerativeAI: boolean;
  isWindowsLicensed: boolean;
  /** 'B88318' when Windows is detected, null otherwise */
  windowsSkuCode: string | null;
  /** costBeforeTax / usageQuantity — always derived from Paid SKU pricing (Free Tier excluded) */
  unitPrice: number | null;
  /**
   * Rule: Paid SKU default — true on every record.
   * Free Tier entitlements are never used for cost modelling;
   * all quantities are priced at the standard Pay-As-You-Go rate.
   */
  isPaidSku: boolean;
  /**
   * Rule: 13% BRL tax applied when currencyCode === 'BRL'.
   * Represents Brazil IOF + indirect taxes on cloud services.
   * null for non-BRL invoices.
   */
  brlTaxAmount: number | null;
  /**
   * costBeforeTax + brlTaxAmount (BRL invoices) or costBeforeTax (all others).
   * This is the final amount used for OCI lift-and-shift cost modelling.
   */
  costAfterTax: number | null;
}

@Injectable()
export class NormalizationService {
  normalize(item: NormalizedLineItem, provider: string): NormalizedBillingRecord {
    const rawCategory = item.serviceCategory ?? '';
    const productName = item.productName ?? '';
    const productCode = item.productCode ?? '';

    const serviceCategory = this.resolveCategory(rawCategory, productName, provider);
    const isGenerativeAI = serviceCategory === OciServiceCategory.GENAI;

    const isWindowsLicensed = this.detectWindowsLicense(productName, productCode, rawCategory);
    const windowsSkuCode = isWindowsLicensed ? WINDOWS_OCI_SKU : null;

    const ociEquivalentQuantity = this.computeOciEquivalent(
      item.usageQuantity,
      serviceCategory,
      productName,
      rawCategory,
    );

    const unitPrice = this.deriveUnitPrice(item);
    const { brlTaxAmount, costAfterTax } = this.applyBrlTax(item);

    return {
      ...item,
      serviceCategory,
      ociEquivalentQuantity,
      isGenerativeAI,
      isWindowsLicensed,
      windowsSkuCode,
      unitPrice,
      isPaidSku: true,   // Rule: always price at Paid SKU rate, never Free Tier
      brlTaxAmount,
      costAfterTax,
    };
  }

  normalizeAll(items: NormalizedLineItem[], provider: string): NormalizedBillingRecord[] {
    return items.map((item) => this.normalize(item, provider));
  }

  // ---------------------------------------------------------------------------
  // Category resolution
  // ---------------------------------------------------------------------------

  private resolveCategory(
    rawCategory: string,
    productName: string,
    provider: string,
  ): OciServiceCategory {
    const combined = `${rawCategory} ${productName}`;

    const map =
      provider === 'aws'
        ? AWS_USAGE_TYPE_MAP
        : provider === 'azure'
          ? AZURE_METER_CATEGORY_MAP
          : provider === 'gcp'
            ? GCP_SERVICE_MAP
            : null;

    if (map) {
      for (const [pattern, category] of map) {
        if (pattern.test(combined)) return category;
      }
    }

    for (const [pattern, category] of GENERIC_KEYWORD_MAP) {
      if (pattern.test(combined)) return category;
    }

    return OciServiceCategory.OTHER;
  }

  // ---------------------------------------------------------------------------
  // OCPU equivalence
  // Automatic Rule: x86 Compute → ociEquivalentQuantity = usageQuantity / 2
  // Exclusion: ARM-based instances (Graviton, Ampere A1) are OCPU-native on OCI
  // ---------------------------------------------------------------------------

  private computeOciEquivalent(
    usageQuantity: number | null | undefined,
    serviceCategory: OciServiceCategory,
    productName: string,
    rawCategory: string,
  ): number | null {
    if (usageQuantity == null) return null;
    if (serviceCategory !== OciServiceCategory.COMPUTE) return usageQuantity;

    const combined = `${productName} ${rawCategory}`.toLowerCase();

    const isArm = /\b(graviton|ampere|a1\.|aarch64|arm64)\b/.test(combined);
    if (isArm) return usageQuantity;

    const isVcpuBased = /\b(vcpu|vcore|boxusage|ec2|virtual.?machine|vm\b|instance|core)\b/.test(combined);
    if (isVcpuBased) return usageQuantity / 2;

    return usageQuantity;
  }

  // ---------------------------------------------------------------------------
  // Windows license detection
  // Licensing Rule: 'Windows' in description → flag for OCI SKU B88318
  // ---------------------------------------------------------------------------

  private detectWindowsLicense(
    productName: string,
    productCode: string,
    rawCategory: string,
  ): boolean {
    const combined = `${productName} ${productCode} ${rawCategory}`.toLowerCase();
    return combined.includes('windows');
  }

  // ---------------------------------------------------------------------------
  // Unit price derivation (Paid SKU default — Free Tier excluded)
  // ---------------------------------------------------------------------------

  private deriveUnitPrice(item: NormalizedLineItem): number | null {
    if (
      item.costBeforeTax != null &&
      item.usageQuantity != null &&
      item.usageQuantity > 0
    ) {
      return +(item.costBeforeTax / item.usageQuantity).toFixed(10);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // BRL Tax Rule: apply 13% IOF/indirect tax to BRL-denominated invoices
  // ---------------------------------------------------------------------------

  private applyBrlTax(item: NormalizedLineItem): {
    brlTaxAmount: number | null;
    costAfterTax: number | null;
  } {
    if (item.currencyCode?.toUpperCase() !== 'BRL' || item.costBeforeTax == null) {
      return { brlTaxAmount: null, costAfterTax: item.costBeforeTax ?? null };
    }

    const brlTaxAmount = +(item.costBeforeTax * BRL_TAX_RATE).toFixed(4);
    const costAfterTax = +(item.costBeforeTax + brlTaxAmount).toFixed(4);
    return { brlTaxAmount, costAfterTax };
  }
}

export enum IngestionStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum CloudProvider {
  AWS = 'aws',
  AZURE = 'azure',
  GCP = 'gcp',
  OCI = 'oci',
  UNKNOWN = 'unknown',
}

export enum OciServiceCategory {
  COMPUTE = 'Compute',
  STORAGE = 'Storage',
  NETWORK = 'Network',
  DATABASE = 'Database',
  GENAI = 'GenAI',
  OTHER = 'Other',
}

/** OCI SKU for Windows Server License (BYOL/included) */
export const WINDOWS_OCI_SKU = 'B88318';

export interface ParsedFileResult {
  rows: Record<string, string>[];
  providerDetected: string;
}

export interface UnifiedBillingRecord {
  uploadId: string;
  provider: CloudProvider;
  sourceResourceId: string | null;
  invoiceId: string | null;
  productCode: string | null;
  productName: string | null;
  /** Raw usage quantity as reported by the source provider */
  usageQuantity: number | null;
  /** Calculated OCI equivalent: for x86 Compute, usageQuantity / 2 (1 OCPU = 2 vCPUs) */
  ociEquivalentQuantity: number | null;
  serviceCategory: OciServiceCategory;
  /** Unit price derived from costBeforeTax / usageQuantity; defaults to Paid SKU rate */
  unitPrice: number | null;
  /**
   * Always true — Free Tier is excluded from all OCI FinOps cost modelling.
   * All quantities are priced at Pay-As-You-Go Paid SKU rates.
   */
  isPaidSku: boolean;
  isGenerativeAI: boolean;
  isWindowsLicensed: boolean;
  /** Set to 'B88318' when Windows is detected in the description */
  windowsSkuCode: string | null;
  costBeforeTax: number | null;
  /** 13% IOF/indirect tax applied to BRL-denominated invoices; null for other currencies */
  brlTaxAmount: number | null;
  /** costBeforeTax + brlTaxAmount (BRL) or costBeforeTax (all others) */
  costAfterTax: number | null;
  currencyCode: string;
  regionName: string | null;
  usageStartDate: Date | null;
  usageEndDate: Date | null;
  ingestionStatus: IngestionStatus;
  /** Full original row stored as JSON for audit/debugging */
  rawData: Record<string, unknown> | null;
}

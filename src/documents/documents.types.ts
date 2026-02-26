export type CloudProviderDetected = 'aws' | 'azure' | 'gcp' | 'oci' | 'unknown';

export interface NormalizedLineItem {
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
  unitPrice?: number | null;
  unitOfMeasure?: string | null;
  costBeforeTax?: number | null;
  taxAmount?: number | null;
  currencyCode: string;
  regionId?: number | null;
  regionName?: string | null;
  isSpotInstance?: boolean;
  rawLine?: Record<string, unknown> | null;
}

export interface CostSummaryItem {
  key: string;
  label: string;
  cost: number;
  currencyCode: string;
}

export interface CostSummary {
  totalPerService: CostSummaryItem[];
  totalPerRegion: CostSummaryItem[];
  /** Sum of all costBeforeTax line items. */
  subtotal: number;
  /** Total tax extracted from the invoice summary (null when not available). */
  totalTax: number | null;
  /** subtotal + totalTax (or just subtotal when totalTax is null). */
  grandTotal: number;
  currencyCode: string;
  billingPeriodStart: Date | null;
  billingPeriodEnd: Date | null;
}

export interface DocumentUploadResult {
  uploadId: string;
  fileName: string;
  fileType: string;
  cloudProviderDetected: CloudProviderDetected;
  billingPeriod: { start: Date | null; end: Date | null };
  /** Total tax from the invoice summary level (e.g. "Total tax USD 230.23"). */
  totalTax: number | null;
  lineItems: NormalizedLineItem[];
  costSummary: CostSummary;
  /** Set when only some pages/sheets were processed. */
  partialExtraction?: boolean;
  /** Message describing partial extraction or data issues. */
  extractionMessage?: string;
}

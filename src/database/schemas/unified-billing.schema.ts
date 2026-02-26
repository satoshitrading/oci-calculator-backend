import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongoSchema } from 'mongoose';
import { IngestionStatus, OciServiceCategory } from '../../documents/ingestion.types';

export type CloudProviderValue = 'aws' | 'azure' | 'gcp' | 'oci' | 'unknown';

@Schema({ collection: 'unified_billing', timestamps: true })
export class UnifiedBilling extends Document {
  /** Reference to the DocumentUpload that created this record */
  @Prop({ required: true, index: true })
  uploadId: string;

  /** Detected cloud provider of the source document */
  @Prop({
    required: true,
    enum: ['aws', 'azure', 'gcp', 'oci', 'unknown'],
    default: 'unknown',
    index: true,
  })
  provider: CloudProviderValue;

  /** Original resource/instance ID from the source billing file */
  @Prop({ default: null })
  sourceResourceId: string | null;

  @Prop({ default: null })
  invoiceId: string | null;

  @Prop({ default: null })
  productCode: string | null;

  @Prop({ default: null })
  productName: string | null;

  /** Raw usage quantity as reported by the source provider */
  @Prop({ default: null, type: Number })
  usageQuantity: number | null;

  /**
   * OCI-equivalent quantity after conversion.
   * For x86 Compute: usageQuantity / 2 (1 OCPU = 2 vCPUs).
   * For all other categories: same as usageQuantity.
   */
  @Prop({ default: null, type: Number })
  ociEquivalentQuantity: number | null;

  /** Mapped OCI service category (Compute, Storage, Network, Database, GenAI, Other) */
  @Prop({
    required: true,
    enum: Object.values(OciServiceCategory),
    default: OciServiceCategory.OTHER,
    index: true,
  })
  serviceCategory: OciServiceCategory;

  /**
   * Unit price per usage unit.
   * Inferred from costBeforeTax / usageQuantity when not explicitly provided.
   * Defaults to Paid SKU rates as per OCI FinOps policy.
   */
  @Prop({ default: null, type: Number })
  unitPrice: number | null;

  /**
   * OCI FinOps Rule — Paid SKU Default.
   * Always true; Free Tier is excluded from all cost modelling.
   */
  @Prop({ default: true })
  isPaidSku: boolean;

  /** True when the record maps to OCI GenAI service category */
  @Prop({ default: false })
  isGenerativeAI: boolean;

  /** True when 'Windows' is detected in the product description */
  @Prop({ default: false })
  isWindowsLicensed: boolean;

  /** OCI SKU code for Windows Server license (B88318) when isWindowsLicensed is true */
  @Prop({ default: null })
  windowsSkuCode: string | null;

  @Prop({ default: null, type: Number })
  costBeforeTax: number | null;

  /**
   * OCI FinOps Rule — 13% BRL Tax.
   * Populated when currencyCode === 'BRL'; null otherwise.
   */
  @Prop({ default: null, type: Number })
  brlTaxAmount: number | null;

  /** costBeforeTax + brlTaxAmount (BRL) or costBeforeTax (all others) */
  @Prop({ default: null, type: Number })
  costAfterTax: number | null;

  @Prop({ default: 'USD' })
  currencyCode: string;

  @Prop({ default: null })
  regionName: string | null;

  @Prop({ default: null })
  usageStartDate: Date | null;

  @Prop({ default: null })
  usageEndDate: Date | null;

  /** Processing status of this record */
  @Prop({
    required: true,
    enum: Object.values(IngestionStatus),
    default: IngestionStatus.COMPLETED,
    index: true,
  })
  ingestionStatus: IngestionStatus;

  /** Full original row stored as JSON for audit and re-processing */
  @Prop({ type: MongoSchema.Types.Mixed, default: null })
  rawData: Record<string, unknown> | null;
}

export const UnifiedBillingSchema = SchemaFactory.createForClass(UnifiedBilling);

UnifiedBillingSchema.index({ uploadId: 1, provider: 1 });
UnifiedBillingSchema.index({ serviceCategory: 1, isGenerativeAI: 1 });
UnifiedBillingSchema.index({ usageStartDate: 1, usageEndDate: 1 });

import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CloudProviderDetected = 'aws' | 'azure' | 'gcp' | 'oci' | 'unknown';
export type DocumentUploadStatus = 'processing' | 'completed' | 'failed';

@Schema({ collection: 'document_uploads' })
export class DocumentUpload extends Document {
  @Prop({ required: true })
  originalName: string;

  @Prop({ required: true })
  mimeType: string;

  @Prop({ required: true })
  size: number;

  @Prop({ default: null })
  storagePath: string | null;

  @Prop({ required: true, default: 'unknown' })
  providerDetected: CloudProviderDetected;

  @Prop({ default: null })
  billingPeriodStart: Date | null;

  @Prop({ default: null })
  billingPeriodEnd: Date | null;

  @Prop({ required: true, default: Date.now })
  uploadedAt: Date;

  @Prop({ required: true, default: 'processing' })
  status: DocumentUploadStatus;

  @Prop({ default: null })
  errorMessage: string | null;

  /**
   * Total tax amount extracted from the invoice header (e.g. "Total tax: 230.23").
   * Populated for PDF invoices processed by Gemini or Textract.
   * Null for CSV/XLSX exports that do not include a tax summary line.
   */
  @Prop({ default: null, type: Number })
  totalTax: number | null;

  /**
   * Billing period read from the invoice header (e.g. "Dec 1 – Dec 31, 2025").
   * Separate from billingPeriodStart/End which are derived from line-item usageStartDate/usageEndDate.
   * For PDF invoices the per-line dates are null, so these fields are the authoritative source.
   */
  @Prop({ default: null })
  invoiceBillingPeriodStart: Date | null;

  @Prop({ default: null })
  invoiceBillingPeriodEnd: Date | null;
}

export const DocumentUploadSchema = SchemaFactory.createForClass(DocumentUpload);

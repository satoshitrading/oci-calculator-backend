import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import { Document, Schema as MongoSchema } from 'mongoose';

@Schema({ collection: 'document_line_items' })
export class DocumentLineItem extends Document {
  @Prop({ required: true, index: true })
  uploadId: string;

  @Prop({ default: null })
  providerId: number | null;

  @Prop({ default: null })
  invoiceId: string | null;

  @Prop({ default: null })
  linkedAccountId: string | null;

  @Prop({ default: null })
  resourceId: string | null;

  @Prop({ default: null })
  productId: number | null;

  @Prop({ default: null })
  productCode: string | null;

  @Prop({ default: null })
  productName: string | null;

  @Prop({ default: null })
  serviceCategory: string | null;

  @Prop({ default: null })
  usageStartDate: Date | null;

  @Prop({ default: null })
  usageEndDate: Date | null;

  @Prop({ default: null })
  usageQuantity: number | null;

  @Prop({ default: null })
  unitOfMeasure: string | null;

  @Prop({ default: null })
  costBeforeTax: number | null;

  @Prop({ default: null })
  taxAmount: number | null;

  @Prop({ default: 'USD' })
  currencyCode: string;

  @Prop({ default: null })
  regionId: number | null;

  @Prop({ default: null })
  regionName: string | null;

  @Prop({ default: false })
  isSpotInstance: boolean;

  @Prop({ type: MongoSchema.Types.Mixed, default: null })
  rawLine: Record<string, unknown> | null;
}

export const DocumentLineItemSchema = SchemaFactory.createForClass(DocumentLineItem);

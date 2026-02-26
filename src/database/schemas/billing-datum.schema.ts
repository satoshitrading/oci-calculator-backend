import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ collection: 'billing_data' })
export class BillingDatum extends Document {
  @Prop({ required: true, unique: true })
  billingId: number;

  @Prop({ required: true })
  providerId: number;

  @Prop({ default: null })
  providerName: string | null;

  @Prop({ default: null })
  invoiceId: string | null;

  @Prop({ default: null })
  payerAccountId: string | null;

  @Prop({ default: null })
  linkedAccountId: string | null;

  @Prop({ default: null })
  resourceId: string | null;

  @Prop({ default: null })
  productId: number | null;

  @Prop({ default: null })
  partNumber: string | null;

  @Prop({ default: null })
  skuName: string | null;

  @Prop({ required: true })
  usageStartDate: Date;

  @Prop({ required: true })
  usageEndDate: Date;

  @Prop({ required: true })
  usageQuantity: number;

  @Prop({ default: null })
  unitOfMeasure: string | null;

  @Prop({ required: true })
  costBeforeTax: number;

  @Prop({ default: 0 })
  taxAmount: number;

  @Prop({ required: true, default: 'USD' })
  currencyCode: string;

  @Prop({ default: null })
  regionId: number | null;

  @Prop({ default: false })
  isSpotInstance: boolean;
}

export const BillingDatumSchema = SchemaFactory.createForClass(BillingDatum);

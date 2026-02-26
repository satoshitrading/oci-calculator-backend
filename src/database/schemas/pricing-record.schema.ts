import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ collection: 'pricing_records' })
export class PricingRecord extends Document {
  @Prop({ required: true, unique: true })
  priceId: number;

  @Prop({ required: true })
  productId: number;

  @Prop({ required: true })
  currencyCode: string;

  @Prop({ required: true })
  unitPrice: string;

  @Prop({ default: null })
  pricingModel: string | null;

  @Prop({ required: true, default: Date.now })
  effectiveDate: Date;
}

export const PricingRecordSchema = SchemaFactory.createForClass(PricingRecord);

import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { Schema as MongoSchema } from 'mongoose';

@Schema({ collection: 'quotations' })
export class Quotation extends Document {
  @Prop({ required: true, unique: true })
  quoteId: number;

  @Prop({ default: null })
  customerName: string | null;

  @Prop({ default: null })
  projectName: string | null;

  @Prop({ required: true, default: 'USD' })
  currencyCode: string;

  @Prop({ default: null })
  billingCountry: string | null;

  @Prop({ type: MongoSchema.Types.Mixed })
  calculationResult: Record<string, unknown>;

  @Prop({ required: true, default: Date.now })
  createdAt: Date;
}

export const QuotationSchema = SchemaFactory.createForClass(Quotation);

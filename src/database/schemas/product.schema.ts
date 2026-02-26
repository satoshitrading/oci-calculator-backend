import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ collection: 'products' })
export class Product extends Document {
  @Prop({ required: true, unique: true })
  productId: number;

  @Prop({ required: true })
  providerId: number;

  @Prop({ default: null })
  partNumber: string | null;

  @Prop({ required: true })
  skuName: string;

  @Prop({ default: null })
  serviceCategory: string | null;

  @Prop({ default: null })
  metricName: string | null;

  @Prop({ default: null })
  isGenerativeAi: boolean | null;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

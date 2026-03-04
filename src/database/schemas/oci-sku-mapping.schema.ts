import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ collection: 'oci_sku_mappings', timestamps: true })
export class OciSkuMapping extends Document {
  /** Part number — used to fetch price and identify the OCI product */
  @Prop({ required: true })
  partNumber: string;

  /** Product name — human-readable name to match against Source Service (productName/productCode) */
  @Prop({ required: true })
  productTitle: string;

  /** Normalized product name for lookup: trim, lowercase, collapse spaces */
  @Prop({ required: true })
  productTitleNormalized: string;

  @Prop({ default: null })
  skuName: string | null;

  /** OCI service category for filtering (Compute, Storage, Network, Database, GenAI, Other). */
  @Prop({ default: null })
  serviceCategory: string | null;

  @Prop({ default: 'OCPU-hours' })
  unit: string;

  @Prop({ default: null, type: Number })
  fallbackUnitPrice: number | null;
}

export const OciSkuMappingSchema = SchemaFactory.createForClass(OciSkuMapping);

OciSkuMappingSchema.index({ productTitleNormalized: 1, serviceCategory: 1 }, { unique: true });
OciSkuMappingSchema.index({ serviceCategory: 1 });

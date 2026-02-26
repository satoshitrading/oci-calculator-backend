import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ collection: 'oci_cost_modeling', timestamps: true })
export class OciCostModeling extends Document {
  // ── Upload-based lift-and-shift modeling fields (new) ──────────────────────
  @Prop({ default: null, index: true })
  uploadId: string | null;

  @Prop({ default: null })
  sourceProvider: string | null;

  @Prop({ default: null })
  sourceService: string | null;

  @Prop({ default: null })
  serviceCategory: string | null;

  @Prop({ default: null, type: Number })
  sourceCost: number | null;

  @Prop({ default: 'USD' })
  sourceCurrencyCode: string;

  @Prop({ default: null })
  ociSkuPartNumber: string | null;

  @Prop({ default: null })
  ociSkuName: string | null;

  @Prop({ default: null, type: Number })
  ociEquivalentQuantity: number | null;

  @Prop({ default: null })
  ociUnit: string | null;

  @Prop({ default: null, type: Number })
  ociUnitPrice: number | null;

  @Prop({ default: null, type: Number })
  ociEstimatedCost: number | null;

  @Prop({ default: null, type: Number })
  savingsAmount: number | null;

  @Prop({ default: null, type: Number })
  savingsPct: number | null;

  // ── Legacy fields (backward compat with existing records) ──────────────────
  @Prop({ default: null })
  billingId: number | null;

  @Prop({ default: null })
  sourceCloud: string | null;

  @Prop({ default: null })
  resourceId: string | null;

  @Prop({ default: null, type: Number })
  sourceVcpus: number | null;

  @Prop({ default: null })
  ociTargetSku: string | null;
}

export const OciCostModelingSchema = SchemaFactory.createForClass(OciCostModeling);

OciCostModelingSchema.index({ uploadId: 1 });
OciCostModelingSchema.index({ uploadId: 1, serviceCategory: 1 });

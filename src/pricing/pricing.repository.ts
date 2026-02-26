import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Product } from '../database/schemas/product.schema';
import { PricingRecord } from '../database/schemas/pricing-record.schema';

export interface PricingRow {
  priceId: number;
  productId: number;
  currencyCode: string;
  unitPrice: string;
  model: string | null;
  partNumber?: string;
  skuName?: string;
  metricName?: string | null;
  serviceCategory?: string | null;
}

@Injectable()
export class PricingRepository {
  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<Product>,
    @InjectModel(PricingRecord.name)
    private readonly pricingModel: Model<PricingRecord>,
  ) {}

  async getByPartNumberAndCurrency(
    partNumber: string,
    currencyCode: string = 'USD',
  ): Promise<PricingRow | null> {
    const product = await this.productModel.findOne({ partNumber }).lean().exec();
    if (!product) return null;
    const pr = await this.pricingModel
      .findOne({ productId: product.productId, currencyCode })
      .sort({ effectiveDate: -1 })
      .lean()
      .exec();
    if (!pr) return null;
    return {
      priceId: pr.priceId,
      productId: pr.productId,
      currencyCode: pr.currencyCode,
      unitPrice: pr.unitPrice,
      model: (pr as { pricingModel?: string | null }).pricingModel ?? null,
      partNumber: product.partNumber ?? undefined,
      skuName: product.skuName,
      metricName: product.metricName ?? undefined,
      serviceCategory: product.serviceCategory ?? undefined,
    };
  }
}

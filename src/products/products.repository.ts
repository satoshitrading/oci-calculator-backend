import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Product } from '../database/schemas/product.schema';

export interface ProductRow {
  productId: number;
  providerId: number;
  partNumber: string | null;
  skuName: string;
  serviceCategory: string | null;
  metricName: string | null;
  isGenerativeAi: boolean | null;
}

@Injectable()
export class ProductsRepository {
  constructor(
    @InjectModel(Product.name)
    private readonly model: Model<Product>,
  ) {}

  async list(providerId: number | null = null): Promise<ProductRow[]> {
    const filter = providerId != null ? { providerId } : {};
    const docs = await this.model.find(filter).sort({ partNumber: 1 }).lean().exec();
    return docs as ProductRow[];
  }

  async getByPartNumber(partNumber: string): Promise<ProductRow | null> {
    const doc = await this.model.findOne({ partNumber }).lean().exec();
    return doc as ProductRow | null;
  }
}

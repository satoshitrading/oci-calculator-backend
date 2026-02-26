import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from '../database/schemas/product.schema';
import { PricingRecord, PricingRecordSchema } from '../database/schemas/pricing-record.schema';
import { PricingRepository } from './pricing.repository';

@Module({
  imports: [
    MongooseModule.forFeature(
      [
        { name: Product.name, schema: ProductSchema },
        { name: PricingRecord.name, schema: PricingRecordSchema },
      ],
    ),
  ],
  providers: [PricingRepository],
  exports: [PricingRepository],
})
export class PricingModule {}

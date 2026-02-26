import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CloudProvider, CloudProviderSchema } from '../database/schemas/cloud-provider.schema';
import { Product, ProductSchema } from '../database/schemas/product.schema';
import { BillingDatum, BillingDatumSchema } from '../database/schemas/billing-datum.schema';
import { BillingController } from './billing.controller';
import { BillingRepository } from './billing.repository';

@Module({
  imports: [
    MongooseModule.forFeature(
      [
        { name: CloudProvider.name, schema: CloudProviderSchema },
        { name: Product.name, schema: ProductSchema },
        { name: BillingDatum.name, schema: BillingDatumSchema },
      ],
    ),
  ],
  controllers: [BillingController],
  providers: [BillingRepository],
})
export class BillingModule {}

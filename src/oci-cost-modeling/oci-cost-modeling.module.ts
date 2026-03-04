import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  OciCostModeling,
  OciCostModelingSchema,
} from '../database/schemas/oci-cost-modeling.schema';
import {
  UnifiedBilling,
  UnifiedBillingSchema,
} from '../database/schemas/unified-billing.schema';
import { PricingService } from '../calculate/pricing.service';
import { PricingModule } from '../pricing/pricing.module';
import { OciSkuMappingsModule } from '../oci-sku-mappings/oci-sku-mappings.module';
import { OciCostModelingController } from './oci-cost-modeling.controller';
import { OciCostModelingRepository } from './oci-cost-modeling.repository';
import { OciCostModelingService } from './oci-cost-modeling.service';
import { OciSkuCatalogService } from './oci-sku-catalog.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OciCostModeling.name, schema: OciCostModelingSchema },
      { name: UnifiedBilling.name, schema: UnifiedBillingSchema },
    ]),
    PricingModule,
    OciSkuMappingsModule,
  ],
  controllers: [OciCostModelingController],
  providers: [OciCostModelingRepository, OciSkuCatalogService, PricingService, OciCostModelingService],
  exports: [OciCostModelingService],
})
export class OciCostModelingModule {}

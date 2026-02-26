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
import { PricingModule } from '../pricing/pricing.module';
import { OciCostModelingController } from './oci-cost-modeling.controller';
import { OciCostModelingRepository } from './oci-cost-modeling.repository';
import { OciCostModelingService } from './oci-cost-modeling.service';
import { PricingService } from '../calculate/pricing.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OciCostModeling.name, schema: OciCostModelingSchema },
      { name: UnifiedBilling.name, schema: UnifiedBillingSchema },
    ]),
    PricingModule,
  ],
  controllers: [OciCostModelingController],
  providers: [OciCostModelingRepository, OciCostModelingService, PricingService],
  exports: [OciCostModelingService],
})
export class OciCostModelingModule {}

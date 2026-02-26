import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module';
import { CalculateController } from './calculate.controller';
import { CalculationService } from './calculation.service';
import { PricingService } from './pricing.service';

@Module({
  imports: [PricingModule],
  controllers: [CalculateController],
  providers: [PricingService, CalculationService],
})
export class CalculateModule {}

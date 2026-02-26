import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { CalculationService, CalculationResult } from './calculation.service';
import { PricingService } from './pricing.service';

interface CalculateBody {
  currencyCode?: string;
  region?: string;
  billingCountry?: string;
  resources?: Array<{
    id?: string;
    description?: string;
    partNumber?: string;
    metric?: string;
    quantity?: number;
    hoursPerMonth?: number;
    isWindows?: boolean;
    isSqlServerStandard?: boolean;
    category?: string;
  }>;
}

@Controller('api')
export class CalculateController {
  constructor(
    private readonly pricingService: PricingService,
    private readonly calculationService: CalculationService,
  ) {}

  @Post('calculate')
  async calculate(@Body() body: CalculateBody): Promise<CalculationResult> {
    const { currencyCode = 'USD', billingCountry, resources = [] } = body ?? {};
    if (!Array.isArray(resources) || resources.length === 0) {
      throw new BadRequestException('resources array is required');
    }
    const pricesByPartNumber = await this.pricingService.fetchPricesForResources(
      resources,
      currencyCode,
    );
    return this.calculationService.calculateOciCosts({
      resources,
      pricesByPartNumber,
      currencyCode,
      billingCountry,
    });
  }
}

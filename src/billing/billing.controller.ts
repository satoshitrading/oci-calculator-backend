import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { BillingRepository } from './billing.repository';

@Controller('api')
export class BillingController {
  constructor(private readonly repo: BillingRepository) {}

  @Post('billing')
  async insert(@Body() row: Record<string, unknown>) {
    const providerId = row.providerId as number | undefined;
    const usageStartDate = row.usageStartDate;
    const usageEndDate = row.usageEndDate;
    const usageQuantity = row.usageQuantity;
    const costBeforeTax = row.costBeforeTax;
    if (
      providerId == null ||
      !usageStartDate ||
      !usageEndDate ||
      usageQuantity == null ||
      costBeforeTax == null
    ) {
      throw new BadRequestException(
        'providerId, usageStartDate, usageEndDate, usageQuantity, costBeforeTax required',
      );
    }
    return this.repo.insert({
      providerId,
      invoiceId: row.invoiceId as string | undefined,
      payerAccountId: row.payerAccountId as string | undefined,
      linkedAccountId: row.linkedAccountId as string | undefined,
      resourceId: row.resourceId as string | undefined,
      productId: row.productId as number | undefined,
      usageStartDate: usageStartDate as string | Date,
      usageEndDate: usageEndDate as string | Date,
      usageQuantity: Number(usageQuantity),
      unitOfMeasure: row.unitOfMeasure as string | undefined,
      costBeforeTax: Number(costBeforeTax),
      taxAmount: row.taxAmount as number | undefined,
      currencyCode: row.currencyCode as string | undefined,
      regionId: row.regionId as number | undefined,
      isSpotInstance: row.isSpotInstance as boolean | undefined,
    });
  }

  @Get('billing')
  async list(
    @Query('providerId') providerId?: string,
    @Query('invoiceId') invoiceId?: string,
    @Query('limit') limit?: string,
  ) {
    const pId = providerId ? parseInt(providerId, 10) : null;
    const lim = limit ? parseInt(limit, 10) : 100;
    return this.repo.list({
      providerId: pId != null && !Number.isNaN(pId) ? pId : null,
      invoiceId: invoiceId ?? null,
      limit: Number.isNaN(lim) ? 100 : lim,
    });
  }
}

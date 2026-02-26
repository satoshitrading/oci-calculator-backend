import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { QuotationsRepository } from './quotations.repository';
import { CalculationResult } from '../calculate/calculation.service';

interface CreateQuotationBody {
  customerName?: string;
  projectName?: string;
  currencyCode?: string;
  billingCountry?: string;
  calculationResult: CalculationResult;
}

@Controller('api')
export class QuotationsController {
  constructor(private readonly repo: QuotationsRepository) {}

  @Post('quotations')
  async create(@Body() body: CreateQuotationBody) {
    const { customerName, projectName, currencyCode, billingCountry, calculationResult } =
      body ?? {};
    if (!calculationResult) {
      throw new BadRequestException('calculationResult is required');
    }
    return this.repo.create({
      customerName,
      projectName,
      currencyCode,
      billingCountry,
      calculationResult,
    });
  }

  @Get('quotations')
  async list(@Query('limit') limit?: string) {
    const n = limit ? parseInt(limit, 10) : 50;
    return this.repo.list(Number.isNaN(n) ? 50 : n);
  }

  @Get('quotations/:id')
  async getById(@Param('id') id: string) {
    const quoteId = parseInt(id, 10);
    if (Number.isNaN(quoteId)) {
      throw new BadRequestException('Invalid quote id');
    }
    const row = await this.repo.getById(quoteId);
    if (!row) {
      throw new NotFoundException('Quotation not found');
    }
    return row;
  }
}

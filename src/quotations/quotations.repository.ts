import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CountersService } from '../database/counters.service';
import { Quotation } from '../database/schemas/quotation.schema';
import { CalculationResult } from '../calculate/calculation.service';

export interface QuotationRow {
  quoteId: number;
  customerName: string | null;
  projectName: string | null;
  currencyCode: string;
  billingCountry: string | null;
  calculationResult?: CalculationResult;
  createdAt: Date;
}

@Injectable()
export class QuotationsRepository {
  constructor(
    @InjectModel(Quotation.name)
    private readonly model: Model<Quotation>,
    private readonly counters: CountersService,
  ) {}

  async create(data: {
    customerName?: string | null;
    projectName?: string | null;
    currencyCode?: string;
    billingCountry?: string | null;
    calculationResult: CalculationResult;
  }): Promise<QuotationRow> {
    const quoteId = await this.counters.getNextValue('quotation');
    const doc = await this.model.create({
      quoteId,
      customerName: data.customerName ?? null,
      projectName: data.projectName ?? null,
      currencyCode: data.currencyCode ?? 'USD',
      billingCountry: data.billingCountry ?? null,
      calculationResult: data.calculationResult as unknown as Record<string, unknown>,
      createdAt: new Date(),
    });
    const raw = doc.toObject();
    return {
      quoteId: raw.quoteId,
      customerName: raw.customerName,
      projectName: raw.projectName,
      currencyCode: raw.currencyCode,
      billingCountry: raw.billingCountry,
      calculationResult: raw.calculationResult as unknown as CalculationResult,
      createdAt: raw.createdAt,
    };
  }

  async list(limit: number = 50): Promise<Omit<QuotationRow, 'calculationResult'>[]> {
    const docs = await this.model
      .find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('-calculationResult')
      .lean()
      .exec();
    return docs as Omit<QuotationRow, 'calculationResult'>[];
  }

  async getById(quoteId: number): Promise<QuotationRow | null> {
    const doc = await this.model.findOne({ quoteId }).lean().exec();
    if (!doc) return null;
    return doc as unknown as QuotationRow;
  }
}

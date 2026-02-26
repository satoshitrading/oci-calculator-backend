import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CloudProvider } from '../database/schemas/cloud-provider.schema';
import { Product } from '../database/schemas/product.schema';
import { BillingDatum } from '../database/schemas/billing-datum.schema';
import { CountersService } from '../database/counters.service';

export interface BillingInsertRow {
  providerId: number;
  invoiceId?: string | null;
  payerAccountId?: string | null;
  linkedAccountId?: string | null;
  resourceId?: string | null;
  productId?: number | null;
  usageStartDate: string | Date;
  usageEndDate: string | Date;
  usageQuantity: number;
  unitOfMeasure?: string | null;
  costBeforeTax: number;
  taxAmount?: number | null;
  currencyCode?: string | null;
  regionId?: number | null;
  isSpotInstance?: boolean;
}

export interface BillingListRow {
  billingId: number;
  providerId: number;
  providerName: string;
  invoiceId: string | null;
  resourceId: string | null;
  productId: number | null;
  partNumber: string | null;
  skuName: string | null;
  usageQuantity: number;
  usageStartDate: Date;
  usageEndDate: Date;
  costBeforeTax: number;
  taxAmount: number;
  currencyCode: string;
  isSpotInstance: boolean;
}

@Injectable()
export class BillingRepository {
  constructor(
    @InjectModel(BillingDatum.name)
    private readonly model: Model<BillingDatum>,
    @InjectModel(CloudProvider.name)
    private readonly providerModel: Model<CloudProvider>,
    @InjectModel(Product.name)
    private readonly productModel: Model<Product>,
    private readonly counters: CountersService,
  ) {}

  async insert(row: BillingInsertRow): Promise<{
    billingId: number;
    providerId: number;
    invoiceId: string | null;
    resourceId: string | null;
    usageQuantity: number;
    costBeforeTax: number;
    currencyCode: string;
    usageStartDate: Date;
    usageEndDate: Date;
  }> {
    const billingId = await this.counters.getNextValue('billing');
    const provider = await this.providerModel
      .findOne({ providerId: row.providerId })
      .lean()
      .exec();
    const providerName = provider?.providerName ?? null;
    let partNumber: string | null = null;
    let skuName: string | null = null;
    if (row.productId != null) {
      const product = await this.productModel
        .findOne({ productId: row.productId })
        .lean()
        .exec();
      partNumber = product?.partNumber ?? null;
      skuName = product?.skuName ?? null;
    }
    const usageStartDate =
      row.usageStartDate instanceof Date
        ? row.usageStartDate
        : new Date(row.usageStartDate);
    const usageEndDate =
      row.usageEndDate instanceof Date
        ? row.usageEndDate
        : new Date(row.usageEndDate);
    await this.model.create({
      billingId,
      providerId: row.providerId,
      providerName,
      invoiceId: row.invoiceId ?? null,
      payerAccountId: row.payerAccountId ?? null,
      linkedAccountId: row.linkedAccountId ?? null,
      resourceId: row.resourceId ?? null,
      productId: row.productId ?? null,
      partNumber,
      skuName,
      usageStartDate,
      usageEndDate,
      usageQuantity: row.usageQuantity,
      unitOfMeasure: row.unitOfMeasure ?? null,
      costBeforeTax: row.costBeforeTax,
      taxAmount: row.taxAmount != null ? row.taxAmount : 0,
      currencyCode: row.currencyCode ?? 'USD',
      regionId: row.regionId ?? null,
      isSpotInstance: row.isSpotInstance === true,
    });
    return {
      billingId,
      providerId: row.providerId,
      invoiceId: row.invoiceId ?? null,
      resourceId: row.resourceId ?? null,
      usageQuantity: row.usageQuantity,
      costBeforeTax: row.costBeforeTax,
      currencyCode: row.currencyCode ?? 'USD',
      usageStartDate,
      usageEndDate,
    };
  }

  async list(filters: {
    providerId?: number | null;
    invoiceId?: string | null;
    limit?: number;
  } = {}): Promise<BillingListRow[]> {
    const filter: Record<string, unknown> = {};
    if (filters.providerId != null) filter.providerId = filters.providerId;
    if (filters.invoiceId) filter.invoiceId = filters.invoiceId;
    let q = this.model.find(filter).sort({ usageStartDate: -1 });
    if (filters.limit) q = q.limit(filters.limit);
    const docs = await q.lean().exec();
    return docs.map((d) => ({
      billingId: d.billingId,
      providerId: d.providerId,
      providerName: d.providerName ?? '',
      invoiceId: d.invoiceId ?? null,
      resourceId: d.resourceId ?? null,
      productId: d.productId ?? null,
      partNumber: d.partNumber ?? null,
      skuName: d.skuName ?? null,
      usageQuantity: d.usageQuantity,
      usageStartDate: d.usageStartDate,
      usageEndDate: d.usageEndDate,
      costBeforeTax: d.costBeforeTax,
      taxAmount: d.taxAmount ?? 0,
      currencyCode: d.currencyCode ?? 'USD',
      isSpotInstance: d.isSpotInstance ?? false,
    })) as BillingListRow[];
  }
}

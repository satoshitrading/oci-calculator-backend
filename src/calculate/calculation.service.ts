import { Injectable } from '@nestjs/common';
import { PriceInfo } from './pricing.service';

const BRAZIL_TAX_MULTIPLIER = 1.13;
const USD_TO_BRL_RATE = 5.5112;
const DEFAULT_HOURS_PER_MONTH = 744;

export interface ResourceInput {
  id?: string;
  description?: string;
  partNumber?: string;
  metric?: string;
  quantity?: number;
  hoursPerMonth?: number;
  isWindows?: boolean;
  isSqlServerStandard?: boolean;
  category?: string;
}

export interface LineItem {
  id?: string;
  description?: string;
  partNumber?: string;
  metric?: string;
  quantity: number;
  hoursPerMonth: number;
  unitPrice: number;
  currencyCode: string;
  costCategory: string;
  baseCost: number;
  formula: string;
  priceInfo?: PriceInfo | null;
}

export interface CalculationResult {
  currencyCode: string;
  billingCountry?: string;
  totals: {
    computeTotal: number;
    storageTotal: number;
    networkTotal: number;
    licenseTotal: number;
    totalBeforeTax: number;
    totalAfterTax: number;
  };
  lineItems: LineItem[];
  assumptions: Record<string, unknown>;
}

@Injectable()
export class CalculationService {
  calculateOciCosts(params: {
    resources: ResourceInput[];
    pricesByPartNumber: Record<string, PriceInfo | null>;
    currencyCode: string;
    billingCountry?: string;
  }): CalculationResult {
    const { resources, pricesByPartNumber, currencyCode, billingCountry } = params;
    const lineItems: LineItem[] = [];
    let computeTotal = 0;
    let storageTotal = 0;
    let networkTotal = 0;
    let licenseTotal = 0;

    for (const resource of resources) {
      const {
        id,
        description,
        partNumber,
        metric,
        quantity = 0,
        hoursPerMonth,
        category,
      } = resource;
      const priceInfo = partNumber ? pricesByPartNumber[partNumber] : null;
      const unitPrice = priceInfo ? Number(priceInfo.unitPrice ?? 0) : 0;
      const effectiveHours =
        hoursPerMonth != null && hoursPerMonth > 0 ? hoursPerMonth : DEFAULT_HOURS_PER_MONTH;

      let baseCost = 0;
      let costCategory = category ?? 'other';
      let formula = '';

      if (metric === 'OCPU_PER_HOUR' || /OCPU Per Hour/i.test(metric ?? '')) {
        baseCost = quantity * effectiveHours * unitPrice;
        costCategory = 'compute';
        formula = `${quantity} OCPU * ${effectiveHours} h * ${unitPrice} ${currencyCode}/OCPU-h`;
      } else if (metric === 'GB_PER_MONTH' || /GB Per Month/i.test(metric ?? '')) {
        baseCost = quantity * unitPrice;
        costCategory = 'storage';
        formula = `${quantity} GB * ${unitPrice} ${currencyCode}/GB-month`;
      } else if (/GB Per Month Internet Data Transfer/i.test(metric ?? '')) {
        baseCost = quantity * unitPrice;
        costCategory = 'network';
        formula = `${quantity} GB * ${unitPrice} ${currencyCode}/GB`;
      } else {
        baseCost = quantity * unitPrice;
        formula = `${quantity} * ${unitPrice} ${currencyCode}`;
      }

      if (costCategory === 'compute') computeTotal += baseCost;
      else if (costCategory === 'storage') storageTotal += baseCost;
      else if (costCategory === 'network') networkTotal += baseCost;
      else licenseTotal += baseCost;

      lineItems.push({
        id,
        description,
        partNumber,
        metric,
        quantity,
        hoursPerMonth: effectiveHours,
        unitPrice,
        currencyCode,
        costCategory,
        baseCost,
        formula,
        priceInfo: priceInfo ?? undefined,
      });
    }

    const totalBeforeTax = computeTotal + storageTotal + networkTotal + licenseTotal;
    const totalAfterTax =
      billingCountry === 'BR' && currencyCode === 'BRL'
        ? totalBeforeTax * BRAZIL_TAX_MULTIPLIER
        : totalBeforeTax;

    return {
      currencyCode,
      billingCountry,
      totals: {
        computeTotal,
        storageTotal,
        networkTotal,
        licenseTotal,
        totalBeforeTax,
        totalAfterTax,
      },
      lineItems,
      assumptions: {
        hoursPerMonthDefault: DEFAULT_HOURS_PER_MONTH,
        brazilTaxApplied: billingCountry === 'BR' && currencyCode === 'BRL',
        usdToBrlRate: USD_TO_BRL_RATE,
        brazilTaxMultiplier: BRAZIL_TAX_MULTIPLIER,
        note:
          'Always Free Tier is NOT applied automatically. All costs are calculated using paid SKUs only, except where explicitly modeled otherwise.',
      },
    };
  }
}

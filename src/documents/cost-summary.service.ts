import { Injectable } from '@nestjs/common';
import { CostSummary, CostSummaryItem, NormalizedLineItem } from './documents.types';

/** Round to exactly 2 decimal places, eliminating floating-point drift. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

@Injectable()
export class CostSummaryService {
  build(lineItems: NormalizedLineItem[], totalTax: number | null = null): CostSummary {
    const totalPerService = this.aggregateBy(lineItems, (item) => item.serviceCategory ?? item.productName ?? item.productCode ?? 'Unknown');
    const totalPerRegion = this.aggregateBy(lineItems, (item) => item.regionName ?? 'Unknown');
    let subtotal = 0;
    const currencySet = new Set<string>();
    for (const item of lineItems) {
      const c = item.costBeforeTax ?? 0;
      if (typeof c === 'number' && !Number.isNaN(c)) subtotal += c;
      if (item.currencyCode) currencySet.add(item.currencyCode);
    }
    const currencyCode = currencySet.size === 1 ? [...currencySet][0]! : 'USD';
    let billingPeriodStart: Date | null = null;
    let billingPeriodEnd: Date | null = null;
    for (const item of lineItems) {
      if (item.usageStartDate) {
        if (!billingPeriodStart || item.usageStartDate < billingPeriodStart) billingPeriodStart = item.usageStartDate;
        if (!billingPeriodEnd || item.usageStartDate > billingPeriodEnd) billingPeriodEnd = item.usageStartDate;
      }
      if (item.usageEndDate) {
        if (!billingPeriodEnd || item.usageEndDate > billingPeriodEnd) billingPeriodEnd = item.usageEndDate;
      }
    }
    const roundedSubtotal = round2(subtotal);
    const roundedTax = totalTax != null ? round2(totalTax) : null;
    return {
      totalPerService,
      totalPerRegion,
      subtotal: roundedSubtotal,
      totalTax: roundedTax,
      grandTotal: round2(roundedSubtotal + (roundedTax ?? 0)),
      currencyCode,
      billingPeriodStart,
      billingPeriodEnd,
    };
  }

  private aggregateBy(lineItems: NormalizedLineItem[], keyFn: (item: NormalizedLineItem) => string): CostSummaryItem[] {
    const map = new Map<string, number>();
    let currencyCode = 'USD';
    for (const item of lineItems) {
      const key = keyFn(item) || 'Unknown';
      const cost = item.costBeforeTax ?? 0;
      if (typeof cost === 'number' && !Number.isNaN(cost)) {
        map.set(key, (map.get(key) ?? 0) + cost);
        if (item.currencyCode) currencyCode = item.currencyCode;
      }
    }
    return Array.from(map.entries()).map(([key, cost]) => ({
      key,
      label: key,
      cost: round2(cost),
      currencyCode,
    }));
  }
}

import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { PricingRepository } from '../pricing/pricing.repository';

const OCI_BASE_URL = 'https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/';

export interface PriceInfo {
  partNumber: string;
  displayName: string;
  metricName: string;
  serviceCategory: string;
  currencyCode: string;
  model: string;
  unitPrice: number;
  rangeMin: unknown;
  rangeMax: unknown;
  rangeUnit: unknown;
}

@Injectable()
export class PricingService {
  constructor(private readonly pricingRepository: PricingRepository) {}

  async fetchOciPriceByPartNumber(
    partNumber: string,
    currencyCode: string = 'USD',
  ): Promise<PriceInfo | null> {
    if (!partNumber?.trim()) return null;
    const url = `${OCI_BASE_URL}?partNumber=${encodeURIComponent(partNumber)}&currencyCode=${encodeURIComponent(currencyCode)}`;
    const response = await axios.get<{ items?: Array<Record<string, unknown>> }>(url, {
      timeout: 15000,
    });
    const items = response.data?.items ?? [];
    if (!items.length) return null;
    const item = items[0] as Record<string, unknown>;
    const priceContainer = (item.prices as Array<{ prices?: Array<{ model?: string; value?: number }>; currencyCode?: string }>)?.[0];
    const innerPrices = priceContainer?.prices ?? [];
    const payg = innerPrices.find((p) => p.model === 'PAY_AS_YOU_GO') ?? innerPrices[0];
    if (!payg) return null;
    return {
      partNumber: item.partNumber as string,
      displayName: (item.displayName as string) ?? '',
      metricName: (item.metricName as string) ?? '',
      serviceCategory: (item.serviceCategory as string) ?? '',
      currencyCode: (priceContainer?.currencyCode as string) ?? currencyCode,
      model: (payg.model as string) ?? 'PAY_AS_YOU_GO',
      unitPrice: Number(payg.value ?? 0),
      rangeMin: null,
      rangeMax: null,
      rangeUnit: null,
    };
  }

  async getPriceFromDb(
    partNumber: string,
    currencyCode: string = 'USD',
  ): Promise<PriceInfo | null> {
    if (!partNumber?.trim()) return null;
    try {
      const row = await this.pricingRepository.getByPartNumberAndCurrency(
        partNumber,
        currencyCode,
      );
      if (!row) return null;
      return {
        partNumber: row.partNumber ?? partNumber,
        displayName: row.skuName ?? '',
        metricName: row.metricName ?? '',
        serviceCategory: row.serviceCategory ?? '',
        currencyCode: row.currencyCode,
        model: row.model ?? 'PAY_AS_YOU_GO',
        unitPrice: Number(row.unitPrice),
        rangeMin: null,
        rangeMax: null,
        rangeUnit: null,
      };
    } catch {
      return null;
    }
  }

  async fetchPricesForResources(
    resources: Array<{ partNumber?: string }>,
    currencyCode: string,
  ): Promise<Record<string, PriceInfo | null>> {
    const partNumbers = Array.from(
      new Set(
        (resources ?? [])
          .map((r) => r.partNumber)
          .filter((p): p is string => typeof p === 'string' && p.trim().length > 0),
      ),
    );
    const result: Record<string, PriceInfo | null> = {};
    for (const pn of partNumbers) {
      try {
        const fromDb = await this.getPriceFromDb(pn, currencyCode);
        if (fromDb) {
          result[pn] = fromDb;
          continue;
        }
        const priceInfo = await this.fetchOciPriceByPartNumber(pn, currencyCode);
        result[pn] = priceInfo;
      } catch (err) {
        console.error(`Error fetching price for partNumber ${pn}:`, err);
        result[pn] = null;
      }
    }
    return result;
  }
}

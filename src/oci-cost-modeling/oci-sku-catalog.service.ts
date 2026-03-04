import { Injectable, Logger } from '@nestjs/common';
import { OciServiceCategory } from '../documents/ingestion.types';
import catalogSeed from './data/oci-sku-catalog.json';

export interface OciSkuCandidate {
  partNumber: string;
  skuName: string;
  serviceCategory: string;
  unit: string;
  fallbackUnitPrice: number;
}

type CatalogRow = {
  partNumber: string;
  skuName: string;
  serviceCategory: string;
  unit?: string;
  fallbackUnitPrice?: number;
};

/**
 * Returns the OCI SKU catalog (array of candidates) for dynamic mapping.
 * Loaded from seed JSON; filter by serviceCategory to get approximate OCI SKU list.
 */
@Injectable()
export class OciSkuCatalogService {
  private readonly logger = new Logger(OciSkuCatalogService.name);
  private catalog: OciSkuCandidate[];

  constructor() {
    const rows = catalogSeed as CatalogRow[];
    this.catalog = rows.map((row) => ({
      partNumber: row.partNumber,
      skuName: row.skuName,
      serviceCategory: row.serviceCategory,
      unit: row.unit ?? 'OCPU-hours',
      fallbackUnitPrice: typeof row.fallbackUnitPrice === 'number' ? row.fallbackUnitPrice : 0,
    }));
    this.logger.log(`Loaded OCI SKU catalog: ${this.catalog.length} SKU(s)`);
  }

  getAll(): OciSkuCandidate[] {
    return this.catalog;
  }

  /**
   * Filter the OCI SKU array by service category (matches OciServiceCategory enum values).
   */
  getByCategory(category: OciServiceCategory | string): OciSkuCandidate[] {
    const all = this.getAll();
    const categoryStr = String(category);
    return all.filter((sku) => sku.serviceCategory === categoryStr);
  }

  /**
   * Fallback SKU per category when catalog is empty or no similarity match meets threshold.
   */
  getFallbackForCategory(category: OciServiceCategory | string): OciSkuCandidate {
    const candidates = this.getByCategory(category);
    if (candidates.length > 0) {
      return candidates[0]!;
    }
    const all = this.getAll();
    const other = all.filter((s) => s.serviceCategory === OciServiceCategory.OTHER);
    if (other.length > 0) return other[0]!;
    return {
      partNumber: 'B88298',
      skuName: 'VM.Standard.E4.Flex — OCPU per Hour (fallback)',
      serviceCategory: String(category),
      unit: 'OCPU-hours',
      fallbackUnitPrice: 0.025,
    };
  }
}

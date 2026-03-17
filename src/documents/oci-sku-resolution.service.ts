import { Injectable } from '@nestjs/common';
import { OciSkuMappingsRepository } from '../oci-sku-mappings/oci-sku-mappings.repository';
import { similarityToCandidate, SIMILARITY_THRESHOLD } from '../common/similarity.util';
import { OciServiceCategory } from './ingestion.types';

export interface ResolvedOciSku {
  ociSkuPartNumber: string;
  ociSkuName: string;
}

/**
 * Resolves OCI SKU (part number + name) for a line item using category and
 * similarity against OCI SKU mappings. Shared by document ingestion (Extracted Data)
 * and OCI cost modeling.
 */
@Injectable()
export class OciSkuResolutionService {
  constructor(private readonly ociSkuMappings: OciSkuMappingsRepository) {}

  /**
   * Resolve OCI SKU for a single item. Returns null when no mapping meets the similarity threshold.
   */
  async resolveOne(
    productName: string | null,
    productCode: string | null,
    serviceCategory: string | null,
  ): Promise<ResolvedOciSku | null> {
    const category = (serviceCategory ?? OciServiceCategory.OTHER).trim() || OciServiceCategory.OTHER;
    const sourceService = (productName || productCode || category) as string;
    const candidates = await this.ociSkuMappings.listByCategory(category);
    if (candidates.length === 0) return null;

    let best = candidates[0]!;
    let bestScore = similarityToCandidate(
      sourceService,
      best.skuName ?? best.productTitle,
      '',
    );
    for (let i = 1; i < candidates.length; i++) {
      const m = candidates[i]!;
      const score = similarityToCandidate(
        sourceService,
        m.skuName ?? m.productTitle,
        '',
      );
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    if (bestScore < SIMILARITY_THRESHOLD) return null;

    return {
      ociSkuPartNumber: best.partNumber,
      ociSkuName: best.skuName ?? best.partNumber,
    };
  }

  /**
   * Resolve OCI SKU for multiple items. Loads candidates per category once and reuses.
   */
  async resolveMany(
    items: Array<{ productName?: string | null; productCode?: string | null; serviceCategory?: string | null }>,
  ): Promise<(ResolvedOciSku | null)[]> {
    const categories = [...new Set(items.map((i) => (i.serviceCategory ?? OciServiceCategory.OTHER).trim() || OciServiceCategory.OTHER))];
    const candidatesByCategory: Record<string, Awaited<ReturnType<OciSkuMappingsRepository['listByCategory']>>> = {};
    for (const cat of categories) {
      candidatesByCategory[cat] = await this.ociSkuMappings.listByCategory(cat);
    }

    return items.map((item) => {
      const category = (item.serviceCategory ?? OciServiceCategory.OTHER).trim() || OciServiceCategory.OTHER;
      const sourceService = (item.productName || item.productCode || category) as string;
      const candidates = candidatesByCategory[category] ?? [];
      if (candidates.length === 0) return null;

      let best = candidates[0]!;
      let bestScore = similarityToCandidate(
        sourceService,
        best.skuName ?? best.productTitle,
        '',
      );
      for (let i = 1; i < candidates.length; i++) {
        const m = candidates[i]!;
        const score = similarityToCandidate(
          sourceService,
          m.skuName ?? m.productTitle,
          '',
        );
        if (score > bestScore) {
          bestScore = score;
          best = m;
        }
      }
      if (bestScore < SIMILARITY_THRESHOLD) return null;

      return {
        ociSkuPartNumber: best.partNumber,
        ociSkuName: best.skuName ?? best.partNumber,
      };
    });
  }
}

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OciSkuMapping } from '../database/schemas/oci-sku-mapping.schema';
import { normalizeProductTitle } from '../common/normalize.util';
import { withMongoRetry, BULK_INSERT_BATCH_SIZE } from '../common/mongo-bulk.util';

/** Escape special regex characters for literal substring match in MongoDB $regex */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface OciSkuMappingRow {
  id: string;
  partNumber: string;
  productTitle: string;
  productTitleNormalized: string;
  skuName: string | null;
  serviceCategory: string | null;
  unit: string;
  fallbackUnitPrice: number | null;
}

@Injectable()
export class OciSkuMappingsRepository {
  constructor(
    @InjectModel(OciSkuMapping.name)
    private readonly model: Model<OciSkuMapping>,
  ) {}

  async list(): Promise<OciSkuMappingRow[]> {
    const docs = await this.model.find().sort({ serviceCategory: 1, productTitle: 1 }).lean().exec();
    return docs.map((d) => this.toRow(d as LeanDoc));
  }

  /**
   * List OCI SKU mappings where the normalized category is included in productTitleNormalized.
   * Category is normalized (trim, lowercase, collapse whitespace) to match product title normalization.
   * When category is "Other", also includes mappings with null/empty serviceCategory.
   */
  async listByCategory(category: string): Promise<OciSkuMappingRow[]> {
    const categoryStr = (category ?? '').trim();
    const normalizedCategory = normalizeProductTitle(categoryStr);
    if (!normalizedCategory) {
      return [];
    }
    const escaped = escapeRegex(normalizedCategory);
    const query =
      categoryStr === 'Other'
        ? {
            $or: [
              { productTitleNormalized: { $regex: escaped } },
              { serviceCategory: 'Other' },
              { serviceCategory: null },
              { serviceCategory: '' },
            ],
          }
        : { productTitleNormalized: { $regex: escaped } };
    const docs = await this.model.find(query).sort({ productTitle: 1 }).lean().exec();
    return docs.map((d) => this.toRow(d as LeanDoc));
  }

  async findByProductTitleNormalized(normalized: string): Promise<OciSkuMappingRow | null> {
    const doc = await this.model.findOne({ productTitleNormalized: normalized }).lean().exec();
    if (!doc) return null;
    return this.toRow(doc as LeanDoc);
  }

  async getById(id: string): Promise<OciSkuMappingRow | null> {
    const doc = await this.model.findById(id).lean().exec();
    if (!doc) return null;
    return this.toRow(doc as LeanDoc);
  }

  async createOne(row: Omit<OciSkuMappingRow, 'id' | 'productTitleNormalized'>): Promise<OciSkuMappingRow> {
    const doc = await this.model.create({
      ...row,
      productTitleNormalized: normalizeProductTitle(row.productTitle),
    });
    return this.toRow(doc.toObject() as LeanDoc);
  }

  async updateById(
    id: string,
    row: Partial<Omit<OciSkuMappingRow, 'id' | 'productTitleNormalized'>>,
  ): Promise<OciSkuMappingRow | null> {
    const update: Record<string, unknown> = { ...row };
    if (row.productTitle != null) {
      update.productTitleNormalized = normalizeProductTitle(row.productTitle);
    }
    const doc = await this.model
      .findByIdAndUpdate(id, { $set: update }, { new: true })
      .lean()
      .exec();
    if (!doc) return null;
    return this.toRow(doc as LeanDoc);
  }

  async deleteById(id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id }).exec();
    return (result.deletedCount ?? 0) > 0;
  }

  async replaceAll(rows: Omit<OciSkuMappingRow, 'id' | 'productTitleNormalized'>[]): Promise<number> {
    await withMongoRetry(() => this.model.deleteMany({}).exec());
    if (rows.length === 0) return 0;
    const toInsert = rows.map((r) => ({
      ...r,
      productTitleNormalized: normalizeProductTitle(r.productTitle),
    }));
    for (let i = 0; i < toInsert.length; i += BULK_INSERT_BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BULK_INSERT_BATCH_SIZE);
      await withMongoRetry(() =>
        this.model.insertMany(batch, { ordered: false }),
      );
    }
    return toInsert.length;
  }

  private toRow(d: LeanDoc): OciSkuMappingRow {
    return {
      id: (d as { _id?: unknown })._id?.toString() ?? '',
      partNumber: d.partNumber,
      productTitle: d.productTitle,
      productTitleNormalized: d.productTitleNormalized,
      skuName: d.skuName ?? null,
      serviceCategory: d.serviceCategory ?? null,
      unit: d.unit ?? 'OCPU-hours',
      fallbackUnitPrice: d.fallbackUnitPrice ?? null,
    };
  }
}

type LeanDoc = {
  _id?: unknown;
  partNumber: string;
  productTitle: string;
  productTitleNormalized: string;
  skuName?: string | null;
  serviceCategory?: string | null;
  unit?: string;
  fallbackUnitPrice?: number | null;
};

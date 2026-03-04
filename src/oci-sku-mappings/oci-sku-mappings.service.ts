import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { normalizeProductTitle } from '../common/normalize.util';
import { OciSkuMappingsRepository, OciSkuMappingRow } from './oci-sku-mappings.repository';

export interface ImportResult {
  count: number;
  message: string;
}

@Injectable()
export class OciSkuMappingsService {
  private readonly logger = new Logger(OciSkuMappingsService.name);

  constructor(private readonly repo: OciSkuMappingsRepository) {}

  async list(): Promise<OciSkuMappingRow[]> {
    return this.repo.list();
  }

  /**
   * Create one mapping. Throws BadRequestException if partNumber/productTitle missing; ConflictException if (productTitleNormalized, serviceCategory) already exists.
   */
  async create(body: {
    partNumber?: string;
    productTitle?: string;
    serviceCategory?: string | null;
    skuName?: string | null;
    unit?: string;
    fallbackUnitPrice?: number | null;
  }): Promise<OciSkuMappingRow> {
    const partNumber = (body.partNumber ?? '').trim();
    const productTitle = (body.productTitle ?? '').trim();
    if (!partNumber || !productTitle) {
      throw new BadRequestException('partNumber and productTitle are required.');
    }
    try {
      return await this.repo.createOne({
        partNumber,
        productTitle,
        skuName: body.skuName ?? null,
        serviceCategory: (body.serviceCategory ?? '').trim() || null,
        unit: (body.unit ?? '').trim() || 'OCPU-hours',
        fallbackUnitPrice: body.fallbackUnitPrice ?? null,
      });
    } catch (err: unknown) {
      if (isMongoDuplicateKeyError(err)) {
        throw new ConflictException(
          'A mapping with this product name (and category) already exists.',
        );
      }
      throw err;
    }
  }

  /**
   * Update one mapping by id. Throws NotFoundException if not found, ConflictException on duplicate key.
   */
  async update(
    id: string,
    body: Partial<{
      partNumber: string;
      productTitle: string;
      serviceCategory: string | null;
      skuName: string | null;
      unit: string;
      fallbackUnitPrice: number | null;
    }>,
  ): Promise<OciSkuMappingRow> {
    if (!id?.trim()) {
      throw new BadRequestException('id is required.');
    }
    const update: Record<string, unknown> = {};
    if (body.partNumber != null) update.partNumber = body.partNumber.trim();
    if (body.productTitle != null) update.productTitle = body.productTitle.trim();
    if (body.serviceCategory !== undefined) update.serviceCategory = (body.serviceCategory ?? '').trim() || null;
    if (body.skuName !== undefined) update.skuName = body.skuName?.trim() || null;
    if (body.unit != null) update.unit = body.unit.trim() || 'OCPU-hours';
    if (body.fallbackUnitPrice !== undefined) update.fallbackUnitPrice = body.fallbackUnitPrice;
    if (Object.keys(update).length === 0) {
      const existing = await this.repo.getById(id);
      if (!existing) throw new NotFoundException(`OCI mapping with id "${id}" not found.`);
      return existing;
    }
    try {
      const row = await this.repo.updateById(id, update as Parameters<OciSkuMappingsRepository['updateById']>[1]);
      if (!row) {
        throw new NotFoundException(`OCI mapping with id "${id}" not found.`);
      }
      return row;
    } catch (err: unknown) {
      if (err instanceof NotFoundException) throw err;
      if (isMongoDuplicateKeyError(err)) {
        throw new ConflictException(
          'A mapping with this product name (and category) already exists.',
        );
      }
      throw err;
    }
  }

  /**
   * Delete one mapping by id. Throws NotFoundException if not found.
   */
  async delete(id: string): Promise<void> {
    if (!id?.trim()) {
      throw new BadRequestException('id is required.');
    }
    const deleted = await this.repo.deleteById(id);
    if (!deleted) {
      throw new NotFoundException(`OCI mapping with id "${id}" not found.`);
    }
  }

  /**
   * Parse CSV and replace all stored mappings.
   * CSV is defined with columns: OCI SKU, OCI Product name.
   * Optional: serviceCategory, unit, fallbackUnitPrice, etc.
   */
  async importFromCsv(buffer: Buffer): Promise<ImportResult> {
    let rows: Record<string, string>[];
    try {
      rows = parse(buffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });
    } catch (err) {
      this.logger.warn('CSV parse failed', err);
      throw new BadRequestException(
        'Invalid CSV. Expected header row with SKU (or OCI SKU) and OCI Product Title (or OCI Product name).',
      );
    }

    if (!rows.length) {
      throw new BadRequestException('CSV has no data rows.');
    }

    const normalized = this.normalizeHeaders(rows);
    const toInsert: Omit<OciSkuMappingRow, 'id' | 'productTitleNormalized'>[] = [];

    for (let i = 0; i < normalized.length; i++) {
      const row = normalized[i]!;
      const partNumber = (row.partNumber ?? row.ociSku ?? '').trim();
      const productTitle = (row.productTitle ?? row.productName ?? row.ociProductName ?? row.ociProductTitle ?? '').trim();
      if (!partNumber || !productTitle) {
        this.logger.warn(`Row ${i + 2}: missing OCI SKU or OCI Product name, skipped`);
        continue;
      }
      const skuName = (row.skuName ?? '').trim() || null;
      const serviceCategory = (row.serviceCategory ?? row.category ?? '').trim() || null;
      const unit = (row.unit ?? '').trim() || 'OCPU-hours';
      const fallback = row.fallbackUnitPrice;
      const fallbackUnitPrice =
        fallback !== undefined && fallback !== null && fallback !== ''
          ? parseFloat(String(fallback))
          : null;
      if (fallbackUnitPrice !== null && Number.isNaN(fallbackUnitPrice)) {
        this.logger.warn(`Row ${i + 2}: invalid fallbackUnitPrice "${row.fallbackUnitPrice}", using null`);
      }
      toInsert.push({
        partNumber,
        productTitle,
        skuName: skuName || null,
        serviceCategory,
        unit,
        fallbackUnitPrice: fallbackUnitPrice !== null && !Number.isNaN(fallbackUnitPrice) ? fallbackUnitPrice : null,
      });
    }

    if (toInsert.length === 0) {
      throw new BadRequestException(
        'No valid rows. Each row must have SKU (or OCI SKU) and OCI Product Title (or OCI Product name).',
      );
    }

    // Deduplicate by (productTitleNormalized, serviceCategory) so we don't hit unique index E11000; last occurrence wins
    const dedupKey = (r: (typeof toInsert)[0]) =>
      `${normalizeProductTitle(r.productTitle)}|${r.serviceCategory ?? ''}`;
    const deduped = Array.from(
      toInsert.reduce((acc, row) => {
        acc.set(dedupKey(row), row);
        return acc;
      }, new Map<string, (typeof toInsert)[0]>()).values(),
    );
    if (deduped.length < toInsert.length) {
      this.logger.warn(
        `OCI mapping import: deduplicated ${toInsert.length} rows to ${deduped.length} by (product name + category).`,
      );
    }

    const count = await this.repo.replaceAll(deduped);
    this.logger.log(`OCI mapping import: ${count} mapping(s) saved.`);
    return {
      count,
      message: `Imported ${count} mapping(s).`,
    };
  }

  /** Map CSV row to canonical keys (partNumber, productTitle/productName, etc.) by case-insensitive header match. */
  private normalizeHeaders(rows: Record<string, string>[]): Record<string, string>[] {
    if (rows.length === 0) return rows;
    const headerMap = this.buildHeaderMap(rows[0]!);
    return rows.map((row) => {
      const out: Record<string, string> = {};
      for (const [canonical, csvHeader] of Object.entries(headerMap)) {
        const key = csvHeader in row ? csvHeader : Object.keys(row).find((k) => this.norm(k) === this.norm(csvHeader));
        out[canonical] = (key ? row[key] : '') ?? '';
      }
      return out;
    });
  }

  /** Map canonical field names to actual CSV header names from first row. */
  private buildHeaderMap(first: Record<string, string>): Record<string, string> {
    const keys = Object.keys(first);
    const normToKey: Record<string, string> = {};
    for (const k of keys) {
      normToKey[this.norm(k)] = k;
    }
    const aliases: Record<string, string[]> = {
      partNumber: ['sku', 'oci sku', 'ocisku', 'partnumber', 'part number'],
      ociSku: ['ocisku'],
      productTitle: ['oci product title', 'ociproducttitle', 'oci product name', 'ociproductname', 'producttitle', 'product name', 'productname', 'product title'],
      productName: ['oci product name', 'ociproductname', 'productname', 'product name'],
      ociProductName: ['ociproductname', 'oci product name'],
      ociProductTitle: ['ociproducttitle'],
      skuName: ['skuname', 'sku name'],
      serviceCategory: ['servicecategory', 'service category', 'category'],
      category: ['category'],
      unit: ['unit'],
      fallbackUnitPrice: ['fallbackunitprice', 'fallback unit price'],
    };
    const out: Record<string, string> = {};
    for (const [canonical, variants] of Object.entries(aliases)) {
      for (const v of variants) {
        const n = this.norm(v);
        if (normToKey[n]) {
          out[canonical] = normToKey[n];
          break;
        }
      }
    }
    return out;
  }

  private norm(s: string): string {
    return (s ?? '').trim().toLowerCase().replace(/\s+/g, '');
  }
}

function isMongoDuplicateKeyError(err: unknown): boolean {
  const e = err as { code?: number; errmsg?: string };
  return e?.code === 11000 || (typeof e?.errmsg === 'string' && e.errmsg.includes('E11000'));
}

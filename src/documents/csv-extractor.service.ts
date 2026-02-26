import { Injectable } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { NormalizedLineItem } from './documents.types';
import { ProviderDetectionService } from './provider-detection.service';

// ---------------------------------------------------------------------------
// Column key lists derived from real reference invoices:
//
//  Billing_invoice_transactionsbancodisco.csv (Azure PT-BR):
//    DATA (UTC), PERÍODO DE SERVIÇO (UTC), TIPO DE TRANSAÇÃO,
//    FAMÍLIA DO PRODUTO, TIPO DE PRODUTO, SKU DO PRODUTO, SEÇÃO DE FATURA,
//    PREÇO DE PAYG CURRENCY, PREÇO DE PAYG, PREÇO EFETIVO CURRENCY, PREÇO EFETIVO,
//    QUANTIDADE, TIPO DE UNIDADE, TAXA DE CÂMBIO,
//    ENCARGOS/CRÉDITOS CURRENCY, ENCARGOS/CRÉDITOS,
//    CRÉDITOS DO AZURE APLICADOS CURRENCY, CRÉDITOS DO AZURE APLICADOS,
//    IMPOSTO CURRENCY, IMPOSTO, TOTAL CURRENCY, TOTAL
//
//  AWS CUR CSVs (EN):
//    lineItem/ProductCode, lineItem/UsageType, lineItem/UnblendedCost,
//    lineItem/UsageStartDate, lineItem/UsageEndDate, lineItem/ResourceId,
//    product/ProductName, product/region
// ---------------------------------------------------------------------------

// IMPORTANT: avoid substrings that match CURRENCY columns — those are excluded in getCost() anyway.
// Most-specific keys first so they win over generic ones.
const COST_KEYS = [
  'costbeforetax',
  'unblendedcost',
  'pretaxcost',
  'blendedcost',
  'totalcost',
  'cost.amount',
  // Azure PT-BR — ENCARGOS/CRÉDITOS is the pre-tax charge column
  'encargos/créditos',
  'encargos/creditos',
  'encargos créditos',
  // Azure PT-BR — PREÇO EFETIVO is unit effective price (less preferred than charge total)
  'preço efetivo',
  'preco efetivo',
  // Azure PT-BR — PREÇO DE PAYG is PAYG unit price (even less preferred)
  'preço de payg',
  'preco de payg',
  // Generic total — matched last so more specific keys win
  'total',
  'cost',
];

const DATE_KEYS = [
  'usagestartdate',
  'usageenddate',
  'billingperiodstart',
  'billingperiodend',
  'invoicedate',
  // Azure PT-BR — exact header (contains ISO timestamp)
  'data (utc)',
  'data utc',
  // Azure PT-BR — PERÍODO DE SERVIÇO (UTC) is a date range "01/12/2025 - 31/12/2025"
  'período de serviço (utc)',
  'periodo de servico (utc)',
  'período de serviço',
  'periodo de servico',
];

const NUM_KEYS = [
  'usagequantity', 'quantity', 'usagequantityamount',
  // Azure PT-BR — exact header
  'quantidade',
];

const UNIT_PRICE_KEYS = [
  'unitprice', 'blendedrate', 'unblendedrate',
  // Azure PT-BR — exact headers (both are unit prices; PREÇO EFETIVO wins over PREÇO DE PAYG)
  'preço efetivo', 'preco efetivo',
  'preço de payg', 'preco de payg',
];

const EXCHANGE_RATE_KEYS = [
  // Azure PT-BR — exact header
  'taxa de câmbio', 'taxa de cambio',
  'exchange rate', 'exchangerate',
];

function findKeyIgnoreCase(obj: Record<string, string>, keys: string[]): string | undefined {
  const lower = Object.keys(obj).reduce<Record<string, string>>((acc, k) => {
    acc[k.toLowerCase().trim()] = obj[k];
    return acc;
  }, {});
  for (const key of keys) {
    const found = Object.keys(lower).find((k) => k.includes(key) || key.includes(k));
    if (found) return lower[found];
  }
  return undefined;
}

function parseNum(val: unknown): number | null {
  if (val == null || val === '') return null;
  if (typeof val === 'number' && !Number.isNaN(val)) return val;
  const s = String(val).replace(/,/g, '.').trim();
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

/**
 * Azure Portuguese billing (and similar) doesn't have a dedicated region column.
 * The region is embedded at the end of the SKU/product name after the last " - ".
 * e.g. "...PostgreSQL - B1MS - Sul do Brasil" → "Sul do Brasil"
 */
function extractRegionFromProductName(name: string | null | undefined): string | null {
  if (!name) return null;
  const parts = name.split(' - ');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1].trim();
  // Must be a readable name (not a short code like "B1MS" or purely uppercase/numbers)
  if (last.length > 3 && !/^[A-Z0-9]+$/.test(last)) return last;
  // If the last segment looks like an SKU code, try the second-to-last
  if (parts.length >= 3) {
    const prev = parts[parts.length - 2].trim();
    if (prev.length > 3 && !/^[A-Z0-9]+$/.test(prev)) return prev;
  }
  return null;
}

function parseDate(val: unknown): Date | null {
  if (val == null || val === '') return null;
  if (val instanceof Date) return val;
  const s = String(val).trim();

  // DD/MM/YYYY — Azure PT-BR date format (e.g. "03/01/2026")
  const dmyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmyMatch) {
    const d = new Date(
      parseInt(dmyMatch[3]!), parseInt(dmyMatch[2]!) - 1, parseInt(dmyMatch[1]!),
    );
    return isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Azure PT-BR PERÍODO DE SERVIÇO (UTC) contains a date range:
 * "01/12/2025 - 31/12/2025". Split and return the start date.
 * Returns null if val is not a range string.
 */
function parsePeriodStart(val: unknown): Date | null {
  if (!val) return null;
  const s = String(val).trim();
  const parts = s.split(/\s*[-–]\s*/);
  if (parts.length >= 2) return parseDate(parts[0]);
  return null;
}

function parsePeriodEnd(val: unknown): Date | null {
  if (!val) return null;
  const s = String(val).trim();
  const parts = s.split(/\s*[-–]\s*/);
  if (parts.length >= 2) return parseDate(parts[parts.length - 1]);
  return null;
}

@Injectable()
export class CsvExtractorService {
  constructor(private readonly providerDetection: ProviderDetectionService) {}

  extract(buffer: Buffer, fileName: string): { rows: Record<string, string>[]; providerDetected: string } {
    let content = buffer.toString('utf8');
    content = this.stripDirectiveLine(content);
    const delimiter = this.detectDelimiter(content);
    const records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      delimiter,
      bom: true,
    }) as Record<string, string>[];
    const providerDetected = this.providerDetection.detectFromFileName(fileName);
    const fromCols = records.length > 0 ? this.providerDetection.detectFromColumnNames(Object.keys(records[0])) : 'unknown';
    const provider = providerDetected !== 'unknown' ? providerDetected : fromCols;
    return { rows: records, providerDetected: provider };
  }

  normalizeRows(rows: Record<string, string>[], providerDetected: string): NormalizedLineItem[] {
    return rows.map((row) => this.normalizeRow(row, providerDetected));
  }

  private normalizeRow(row: Record<string, string>, _provider: string): NormalizedLineItem {
    const getCost = () => {
      for (const key of COST_KEYS) {
        // Skip columns whose name ends with 'currency' / 'moeda' — they hold the currency code
        const k = Object.keys(row).find((x) => {
          const lx = x.toLowerCase().trim();
          return (
            lx.includes(key) &&
            !lx.endsWith('currency') &&
            !lx.endsWith('moeda') &&
            !lx.endsWith(' currency')
          );
        });
        if (k) {
          const n = parseNum(row[k]);
          if (n != null) return n;
        }
      }
      return null;
    };

    const getUnitPrice = () => {
      for (const key of UNIT_PRICE_KEYS) {
        const k = Object.keys(row).find((x) => {
          const lx = x.toLowerCase().trim();
          return lx.includes(key) && !lx.endsWith('currency') && !lx.endsWith(' currency');
        });
        if (k) {
          const n = parseNum(row[k]);
          if (n != null) return n;
        }
      }
      return null;
    };

    const getNum = (keys: string[]) => {
      const v = findKeyIgnoreCase(row, keys);
      return v != null ? parseNum(v) : null;
    };

    // --- Invoice / account fields ---
    const invoiceId =
      findKeyIgnoreCase(row, ['invoiceid', 'bill/invoiceid']) ?? null;

    const linkedAccountId =
      findKeyIgnoreCase(row, [
        'linkedaccountid', 'bill/payeraccountid',
        // Azure PT-BR — SEÇÃO DE FATURA maps to the billing section / account name
        'seção de fatura', 'secao de fatura',
      ]) ?? null;

    const resourceId =
      findKeyIgnoreCase(row, ['resourceid', 'lineitem/resourceid']) ?? null;

    // --- Product / service fields ---
    const productCode =
      findKeyIgnoreCase(row, [
        'productcode', 'lineitem/productcode',
        // Azure PT-BR — exact header
        'sku do produto',
      ]) ?? null;

    const productName =
      findKeyIgnoreCase(row, [
        'productname', 'lineitem/productname', 'metername',
        // Azure PT-BR — exact headers (preference order: SKU > TIPO > FAMÍLIA)
        'sku do produto', 'tipo de produto', 'família do produto', 'familia do produto',
      ]) ?? null;

    const serviceCategory =
      findKeyIgnoreCase(row, [
        'servicecategory', 'lineitem/usagetype', 'metercategory',
        // Azure PT-BR — exact headers
        'família do produto', 'familia do produto', 'tipo de transação', 'tipo de transacao',
      ]) ?? null;

    // --- Region: dedicated column first, then embedded in SKU/product name ---
    const regionName = (() => {
      const dedicated = findKeyIgnoreCase(row, [
        'region', 'product/region', 'armregionname',
        'local', 'location', 'localização', 'localizacao',
      ]);
      if (dedicated) return dedicated;
      // Azure PT-BR: region is embedded in SKU DO PRODUTO / TIPO DE PRODUTO after last " - "
      const skuVal = findKeyIgnoreCase(row, ['sku do produto', 'tipo de produto']);
      return extractRegionFromProductName(skuVal ?? null);
    })();

    const unitOfMeasure =
      findKeyIgnoreCase(row, [
        'unitofmeasure', 'lineitem/usageamount',
        // Azure PT-BR — exact header
        'tipo de unidade',
      ]) ?? null;

    // --- Financial fields ---
    const taxAmount = parseNum(
      findKeyIgnoreCase(row, [
        'taxamount', 'taxtotal',
        // Azure PT-BR — exact header
        'imposto',
      ]) ?? undefined,
    );

    const currencyCode = (
      findKeyIgnoreCase(row, [
        'currencycode', 'currency',
        // Azure PT-BR — currency columns in preference order
        'total currency', 'encargos/créditos currency', 'encargos/creditos currency',
        'preço efetivo currency', 'preco efetivo currency',
        'imposto currency',
      ]) ?? 'USD'
    ).toUpperCase().slice(0, 3);

    // --- Dates ---
    // Azure PT-BR: DATA (UTC) is the charge date; PERÍODO DE SERVIÇO (UTC) is a range
    const periodRaw = findKeyIgnoreCase(row, [
      'período de serviço (utc)', 'periodo de servico (utc)',
      'período de serviço', 'periodo de servico',
    ]);

    const usageStartDate =
      parsePeriodStart(periodRaw) ??
      parseDate(findKeyIgnoreCase(row, ['usagestartdate', 'usage start date', 'data (utc)', 'data utc']) ?? null);

    const usageEndDate =
      parsePeriodEnd(periodRaw) ??
      parseDate(findKeyIgnoreCase(row, ['usageenddate', 'usage end date']) ?? null);

    // Exchange rate (Azure PT-BR: TAXA DE CÂMBIO) — stored in rawLine for FinOps rules
    const exchangeRate = parseNum(
      findKeyIgnoreCase(row, EXCHANGE_RATE_KEYS) ?? undefined,
    );

    return {
      invoiceId: invoiceId || null,
      linkedAccountId: linkedAccountId || null,
      resourceId: resourceId || null,
      productCode: productCode || null,
      productName: productName || null,
      serviceCategory: serviceCategory || null,
      usageStartDate,
      usageEndDate,
      usageQuantity: getNum(['usagequantity', 'quantity', 'quantidade']) ?? null,
      unitPrice: getUnitPrice(),
      unitOfMeasure: unitOfMeasure || null,
      costBeforeTax: getCost(),
      taxAmount: taxAmount ?? null,
      currencyCode: currencyCode || 'USD',
      regionName: regionName || null,
      isSpotInstance: false,
      rawLine: { ...row, exchangeRate } as unknown as Record<string, unknown>,
    };
  }

  private stripDirectiveLine(content: string): string {
    const trimmed = content.trimStart();
    if (/^SEP=/i.test(trimmed)) {
      const firstNewline = trimmed.indexOf('\n');
      return firstNewline === -1 ? '' : trimmed.slice(firstNewline + 1);
    }
    return content;
  }

  private detectDelimiter(content: string): string {
    const firstLine = content.split('\n')[0] ?? '';
    if (firstLine.includes(';')) return ';';
    if (firstLine.includes('\t')) return '\t';
    return ',';
  }
}

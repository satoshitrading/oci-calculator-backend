import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { NormalizedLineItem } from './documents.types';
import {
  buildOciSignedHeaders,
  isOciConfigured,
  loadOciSigningConfig,
} from '../utils/oci-signing.util';

// ---------------------------------------------------------------------------
// OCI Document AI response interfaces
// Mirrors the structure returned by POST /20221109/actions/analyzeDocument
// ---------------------------------------------------------------------------

interface OciKeyValue {
  name: string;
  value?: { rawValue?: string; normalized?: { value?: string; valueType?: string } };
  confidence?: number;
}

interface OciDocumentField {
  fieldType?: string;
  fieldLabel?: { name?: string; confidence?: number };
  fieldValue?: { value?: string; valueType?: string; confidence?: number };
}

interface OciTableCell {
  text?: string;
  rowIndex?: number;
  columnIndex?: number;
  confidence?: number;
}

interface OciTableRow {
  cells?: OciTableCell[];
}

interface OciTable {
  rows?: OciTableRow[];
  confidence?: number;
}

interface OciDocumentPage {
  pageNumber?: number;
  tables?: OciTable[];
  documentFields?: OciDocumentField[];
}

interface OciAnalyzeResponse {
  detectedDocumentTypes?: Array<{ documentType?: string; confidence?: number }>;
  keyValues?: OciKeyValue[];
  pages?: OciDocumentPage[];
}

// ---------------------------------------------------------------------------
// Typed field maps — derived from REAL invoices in /references:
//
//  aws_122025 signove.pdf        → AWS invoice (PT-BR)
//    Columns: Descrição | Quantidade de uso | Valor em USD
//    Summary: Período de faturamento, ID da conta, Total de impostos, Total geral,
//             Fatura emitida, Status da fatura
//
//  Bills _ Billing and Cost Management _ Global.pdf → AWS invoice (EN)
//    Columns: Description | Usage Quantity | Amount in USD
//    Summary: Billing period, Account ID, Bill issued, Grand total, Total tax,
//             Total pre-tax, Total invoiced charges
//    Tax table: Service name | Post-tax charges | Pre-tax charges | Taxes
//
//  Billing_invoice_transactionsbancodisco.csv → Azure billing (PT-BR)
//    Columns: DATA (UTC), PERÍODO DE SERVIÇO (UTC), TIPO DE TRANSAÇÃO,
//             FAMÍLIA DO PRODUTO, TIPO DE PRODUTO, SKU DO PRODUTO,
//             SEÇÃO DE FATURA, PREÇO DE PAYG CURRENCY, PREÇO DE PAYG,
//             PREÇO EFETIVO CURRENCY, PREÇO EFETIVO, QUANTIDADE,
//             TIPO DE UNIDADE, TAXA DE CÂMBIO, ENCARGOS/CRÉDITOS CURRENCY,
//             ENCARGOS/CRÉDITOS, CRÉDITOS DO AZURE APLICADOS CURRENCY,
//             CRÉDITOS DO AZURE APLICADOS, IMPOSTO CURRENCY, IMPOSTO,
//             TOTAL CURRENCY, TOTAL
// ---------------------------------------------------------------------------

/**
 * Document-level (SummaryFields) key-value names → typed field category.
 * Each array lists every variant seen in the reference invoices, ordered
 * most-specific first so the first match wins.
 */
const SUMMARY_FIELD_MAP: Record<string, string[]> = {
  invoiceId: [
    // English (AWS)
    'invoice id', 'invoice number', 'invoice #', 'invoice no',
    'bill number', 'receipt number', 'receipt id', 'document number',
    'total invoiced charges',
    // Portuguese (AWS PT-BR)
    'id da fatura', 'número da fatura', 'número fatura',
  ],
  accountId: [
    // English (AWS)
    'account id', 'payer account id', 'linked account id',
    // Portuguese (AWS PT-BR)
    'id da conta',
    // Azure
    'seção de fatura', 'secao de fatura',
  ],
  vendorName: [
    // English
    'vendor', 'supplier', 'biller', 'from', 'sold by', 'seller', 'company',
    'service provider',
    // AWS provider strings (as they appear in the PDF)
    'amazon web services, inc.', 'amazon aws serviços brasil ltda.',
    'amazon aws servicos brasil ltda.',
    // Portuguese (AWS PT-BR)
    'provedor de serviços', 'provedor de servicos',
  ],
  invoiceDate: [
    // English (AWS)
    'bill issued', 'invoice date', 'date', 'bill date', 'issue date',
    'issued date', 'date printed',
    // Portuguese (AWS PT-BR)
    'fatura emitida', 'data de impressão', 'data de impressao',
  ],
  dueDate: ['due date', 'payment due', 'payment date', 'pay by'],
  total: [
    // English (AWS)
    'grand total', 'total', 'total amount', 'amount due', 'invoice total',
    'balance due', 'total due',
    // Portuguese (AWS PT-BR)
    'total geral',
    // Azure PT
    'total',
  ],
  subtotal: [
    // English (AWS)
    'total pre-tax', 'total pre tax', 'subtotal', 'sub total', 'sub-total',
    'net amount',
    // Portuguese (AWS PT-BR)
    'total antes de impostos',
  ],
  taxAmount: [
    // English (AWS)
    'total tax', 'tax', 'tax amount', 'vat', 'gst', 'sales tax', 'tax total',
    'vat amount', 'taxes',
    // Portuguese (AWS PT-BR)
    'total de impostos',
    // Azure PT
    'imposto',
  ],
  discount: ['discount', 'total discount', 'discount amount'],
  currency: [
    // English
    'currency', 'currency code', 'billing currency',
    // Azure PT
    'total currency', 'imposto currency', 'preço efetivo currency',
    'preco efetivo currency',
  ],
  billingPeriodStart: [
    // English (AWS)
    'billing period', 'billing period start', 'period start', 'service start',
    'from date', 'start date', 'usage start',
    // Portuguese (AWS PT-BR) — whole billing period string "1 de dez. - 31 de dez. de 2025"
    'período de faturamento', 'periodo de faturamento',
    // Azure PT
    'data (utc)', 'data utc',
  ],
  billingPeriodEnd: [
    // English (AWS)
    'billing period end', 'period end', 'service end', 'to date', 'end date',
    'usage end',
    // Azure PT — service period contains a range "01/12/2025 - 31/12/2025"
    'período de serviço (utc)', 'periodo de servico (utc)',
    'período de serviço', 'periodo de servico',
  ],
};

/**
 * Table column header → typed line-item expense field.
 * Derived from the exact headers seen in the reference invoices.
 *
 * AWS PDF (PT-BR): Descrição | Quantidade de uso | Valor em USD
 * AWS PDF (EN):    Description | Usage Quantity | Amount in USD
 * AWS Tax table:   Service name | Post-tax charges | Pre-tax charges | Taxes
 * Azure CSV (PT):  FAMÍLIA DO PRODUTO | TIPO DE PRODUTO | SKU DO PRODUTO |
 *                  QUANTIDADE | TIPO DE UNIDADE | PREÇO DE PAYG |
 *                  PREÇO EFETIVO | ENCARGOS/CRÉDITOS | IMPOSTO | TOTAL
 */
const LINE_ITEM_COLUMN_MAP: Record<string, string[]> = {
  description: [
    // English (AWS, generic)
    'description', 'service', 'item', 'product', 'name', 'details',
    'line item', 'charge', 'product name', 'service name',
    // AWS PDF (PT-BR) — exact column header
    'descrição', 'descricao',
    // AWS tax table
    'service name',
    // Azure PT
    'tipo de produto', 'tipo de transação', 'tipo de transacao',
  ],
  quantity: [
    // English (AWS)
    'usage quantity', 'quantity', 'qty', 'usage', 'units', 'hours', 'count',
    // AWS PDF (PT-BR) — exact column header
    'quantidade de uso',
    // Azure PT
    'quantidade',
  ],
  unitPrice: [
    // English
    'unit price', 'unit cost', 'rate', 'price per unit', 'unit rate',
    'blended rate',
    // Azure PT — exact column headers
    'preço de payg', 'preco de payg',
    'preço efetivo', 'preco efetivo',
  ],
  amount: [
    // English
    'amount', 'cost', 'price', 'charge', 'line total',
    'extended price', 'extended amount',
    // AWS PDF (PT-BR) — exact column header
    'valor em usd',
    // AWS PDF (EN) — exact column header
    'amount in usd',
    // AWS tax table columns
    'pre-tax charges', 'post-tax charges',
    // Azure PT — exact column header
    'encargos/créditos', 'encargos/creditos',
    // Generic totals (lower priority, matched last)
    'total',
  ],
  taxAmount: [
    // AWS tax table
    'taxes', 'tax',
    // Azure PT
    'imposto',
  ],
  region: [
    // English
    'region', 'location', 'zone', 'area', 'availability domain',
    'aws region', 'armregionname',
    // Portuguese
    'localização', 'localizacao', 'local',
  ],
  productCode: [
    // English
    'product code', 'sku', 'service code', 'part number', 'code', 'item code',
    // Azure PT — exact column header
    'sku do produto',
  ],
  unitOfMeasure: [
    // English
    'unit of measure', 'unit type', 'uom',
    // Azure PT — exact column header
    'tipo de unidade',
  ],
  serviceFamily: [
    // English
    'service family', 'product family',
    // Azure PT — exact column header
    'família do produto', 'familia do produto',
  ],
  exchangeRate: [
    // Azure PT — exact column header
    'taxa de câmbio', 'taxa de cambio',
    // English
    'exchange rate',
  ],
};

/** Minimum extraction confidence to trust a key-value pair (0–1). */
const CONFIDENCE_THRESHOLD = 0.4;

// ---------------------------------------------------------------------------
// Required env vars:
//   OCI_TENANCY_OCID, OCI_USER_OCID, OCI_FINGERPRINT,
//   OCI_PRIVATE_KEY (PEM, newlines as \n), OCI_REGION, OCI_COMPARTMENT_OCID
//
// Optional (Object Storage source — equivalent to Textract S3):
//   OCI_DOCAI_NAMESPACE, OCI_DOCAI_BUCKET
// ---------------------------------------------------------------------------

@Injectable()
export class OciDocumentAiService {
  private readonly logger = new Logger(OciDocumentAiService.name);

  isAvailable(): boolean {
    return isOciConfigured() && !!process.env.OCI_COMPARTMENT_OCID;
  }

  // ---------------------------------------------------------------------------
  // process() — INLINE source (base64 buffer)
  // Equivalent to Textract AnalyzeExpenseCommand with Document.Bytes
  // ---------------------------------------------------------------------------

  async process(
    buffer: Buffer,
    fileName: string,
  ): Promise<{ lineItems: NormalizedLineItem[]; providerDetected: string }> {
    const body = this.buildRequestBody({
      source: 'INLINE',
      data: buffer.toString('base64'),
    });
    const response = await this.callAnalyzeDocument(body);
    return this.parseResponse(response, fileName);
  }

  // ---------------------------------------------------------------------------
  // processFromObjectStorage() — Object Storage source
  // Equivalent to Textract AnalyzeExpenseCommand with Document.S3Object:
  //   { Bucket: bucketName, Name: objectName }
  // ---------------------------------------------------------------------------

  async processFromObjectStorage(
    namespaceName: string,
    bucketName: string,
    objectName: string,
    fileName?: string,
  ): Promise<{ lineItems: NormalizedLineItem[]; providerDetected: string }> {
    const body = this.buildRequestBody({
      source: 'OBJECT_STORAGE',
      namespaceName,
      bucketName,
      objectName,
    });
    const response = await this.callAnalyzeDocument(body);
    return this.parseResponse(response, fileName ?? objectName);
  }

  // ---------------------------------------------------------------------------
  // Internal — build the analyzeDocument request body
  // ---------------------------------------------------------------------------

  private buildRequestBody(document: Record<string, string>): string {
    return JSON.stringify({
      processorConfig: {
        processorType: 'GENERAL',
        features: [
          { featureType: 'DOCUMENT_CLASSIFICATION' },
          { featureType: 'KEY_VALUE_EXTRACTION' },
          { featureType: 'TABLE_EXTRACTION' },
          { featureType: 'TEXT_EXTRACTION' },
        ],
        isZipOutputEnabled: false,
      },
      document,
      compartmentId: process.env.OCI_COMPARTMENT_OCID,
    });
  }

  // ---------------------------------------------------------------------------
  // Internal — sign and POST to OCI Document AI
  // ---------------------------------------------------------------------------

  private async callAnalyzeDocument(body: string): Promise<OciAnalyzeResponse> {
    const config = loadOciSigningConfig();
    const region = config.region;
    const host = `document.aiservice.${region}.oci.oraclecloud.com`;
    const path = '/20221109/actions/analyzeDocument';
    const headers = buildOciSignedHeaders('POST', host, path, body, config);
    const response = await axios.post<OciAnalyzeResponse>(
      `https://${host}${path}`,
      body,
      { headers },
    );
    return response.data;
  }

  // ---------------------------------------------------------------------------
  // Internal — parse OCI response into NormalizedLineItem[]
  // Mirrors Textract AnalyzeExpenseCommand traversal:
  //   ExpenseDocuments → LineItemGroups → LineItems → LineItemExpenseFields
  // ---------------------------------------------------------------------------

  private parseResponse(
    response: OciAnalyzeResponse,
    fileName: string,
  ): { lineItems: NormalizedLineItem[]; providerDetected: string } {
    const providerDetected = this.inferProvider(response, fileName);
    const lineItems = this.extractLineItems(response);
    this.logger.log(
      `OCI Document AI extracted ${lineItems.length} line items from "${fileName}" ` +
      `(provider=${providerDetected})`,
    );
    return { lineItems, providerDetected };
  }

  // ---------------------------------------------------------------------------
  // Step 1 — Build SummaryFields flat map from keyValues + documentFields
  // Mirrors Textract ExpenseDocument.SummaryFields[].Type.Text
  // ---------------------------------------------------------------------------

  private buildSummaryFields(
    kvs: OciKeyValue[],
    documentFields: OciDocumentField[],
  ): Record<string, string> {
    const flat: Record<string, string> = {};

    for (const kv of kvs) {
      if (!kv.name) continue;
      if ((kv.confidence ?? 1) < CONFIDENCE_THRESHOLD) continue;
      const val = kv.value?.normalized?.value ?? kv.value?.rawValue ?? '';
      if (val) flat[kv.name.toLowerCase().trim()] = val;
    }

    // Page-level documentFields override keyValues (higher-structure extraction)
    for (const df of documentFields) {
      const label = df.fieldLabel?.name?.toLowerCase().trim() ?? '';
      const val = df.fieldValue?.value ?? '';
      if (label && val) flat[label] = val;
    }

    return flat;
  }

  /**
   * Resolve a typed summary field from the flat KV map.
   * Equivalent to Textract SummaryField lookup by Type.Text.
   */
  private resolveSummaryField(
    flat: Record<string, string>,
    fieldType: string,
  ): string | null {
    const candidates = SUMMARY_FIELD_MAP[fieldType] ?? [];
    for (const key of candidates) {
      if (flat[key]) return flat[key];
      // Partial match — key appears anywhere in a flat key name
      const match = Object.keys(flat).find((k) => k.includes(key) || key.includes(k));
      if (match) return flat[match] ?? null;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Step 2 — Extract line items from tables (LineItemGroups equivalent)
  // ---------------------------------------------------------------------------

  private extractLineItems(response: OciAnalyzeResponse): NormalizedLineItem[] {
    const allKvs = response.keyValues ?? [];
    const allDocFields = (response.pages ?? []).flatMap((p) => p.documentFields ?? []);
    const flat = this.buildSummaryFields(allKvs, allDocFields);

    // --- Typed summary / header-level expense fields ---
    const invoiceId = this.resolveSummaryField(flat, 'invoiceId');
    const accountId = this.resolveSummaryField(flat, 'accountId');
    const currency = (
      this.resolveSummaryField(flat, 'currency') ?? 'USD'
    ).toUpperCase().slice(0, 3);

    // Billing period — handles "Dec 1 - Dec 31, 2025" and "1 de dez. - 31 de dez. de 2025"
    const periodRaw = this.resolveSummaryField(flat, 'billingPeriodStart') ?? '';
    const { start: billingStart, end: billingEnd } = this.parseBillingPeriod(
      periodRaw,
      this.resolveSummaryField(flat, 'billingPeriodEnd') ?? '',
    );

    const headerTax = this.parseNum(
      this.resolveSummaryField(flat, 'taxAmount') ?? '',
    );

    const items: NormalizedLineItem[] = [];

    // --- Iterate pages → tables (LineItemGroups equivalent) ---
    for (const page of response.pages ?? []) {
      for (const table of page.tables ?? []) {
        const { headers, dataRows } = this.parseTable(table);
        const colIndex = this.resolveColumnIndices(headers);

        for (const row of dataRows) {
          // Build typed expense fields per row (LineItemExpenseFields equivalent)
          const ef = this.buildExpenseFields(row, headers, colIndex);

          const productName = ef.description ?? null;
          const usageQuantity = this.parseNum(ef.quantity ?? '');
          const unitPrice = this.parseNum(ef.unitPrice ?? '');
          const costBeforeTax = this.parseNum(ef.amount ?? '');
          const taxAmount = this.parseNum(ef.taxAmount ?? '');
          const regionName = ef.region ?? null;
          const productCode = ef.productCode ?? null;
          const unitOfMeasure = ef.unitOfMeasure ?? null;
          const serviceCategory = ef.serviceFamily ?? null;
          const exchangeRate = this.parseNum(ef.exchangeRate ?? '');

          if (!productName && costBeforeTax == null) continue;

          items.push({
            invoiceId: invoiceId ?? null,
            linkedAccountId: accountId ?? null,
            productName,
            productCode,
            serviceCategory,
            usageQuantity,
            unitPrice,
            unitOfMeasure,
            costBeforeTax,
            taxAmount: taxAmount ?? null,
            currencyCode: currency,
            usageStartDate: billingStart,
            usageEndDate: billingEnd,
            regionName,
            rawLine: {
              expenseFields: ef,
              headers,
              row,
              exchangeRate,
            } as unknown as Record<string, unknown>,
          });
        }
      }
    }

    // --- Fallback: no table rows → build single receipt-style item from summary ---
    if (items.length === 0) {
      const totalAmount = this.parseNum(this.resolveSummaryField(flat, 'total') ?? '');
      const vendorName = this.resolveSummaryField(flat, 'vendorName');

      if (invoiceId ?? totalAmount ?? vendorName) {
        items.push({
          invoiceId: invoiceId ?? null,
          linkedAccountId: accountId ?? null,
          productName: vendorName ?? 'Cloud Invoice',
          usageQuantity: null,
          unitPrice: null,
          costBeforeTax: totalAmount,
          taxAmount: headerTax,
          currencyCode: currency,
          usageStartDate: billingStart,
          usageEndDate: billingEnd,
          rawLine: flat as unknown as Record<string, unknown>,
        });
      }
    }

    return items;
  }

  // ---------------------------------------------------------------------------
  // Table helpers
  // ---------------------------------------------------------------------------

  private parseTable(table: OciTable): { headers: string[]; dataRows: string[][] } {
    const headers: string[] = [];
    const dataRows: string[][] = [];

    for (const row of table.rows ?? []) {
      if (!row.cells?.length) continue;
      const sorted = [...row.cells].sort(
        (a, b) => (a.columnIndex ?? 0) - (b.columnIndex ?? 0),
      );
      const texts = sorted.map((c) => (c.text ?? '').trim());
      const isHeader = sorted.some((c) => (c.rowIndex ?? 0) === 0);

      if (isHeader && headers.length === 0) {
        headers.push(...texts);
      } else {
        dataRows.push(texts);
      }
    }

    return { headers, dataRows };
  }

  /**
   * Map each column header to a typed expense field key.
   * Equivalent to Textract identifying LineItemExpenseField.Type.Text per column.
   * AWS PDF PT: "Descrição" → description, "Quantidade de uso" → quantity, "Valor em USD" → amount
   * AWS PDF EN: "Description" → description, "Usage Quantity" → quantity, "Amount in USD" → amount
   * Azure PT:   "FAMÍLIA DO PRODUTO" → serviceFamily, "ENCARGOS/CRÉDITOS" → amount, etc.
   */
  private resolveColumnIndices(headers: string[]): Record<string, number> {
    const result: Record<string, number> = {};
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i]!.toLowerCase().trim();
      for (const [fieldType, candidates] of Object.entries(LINE_ITEM_COLUMN_MAP)) {
        if (!(fieldType in result) && candidates.some((c) => h === c || h.includes(c) || c.includes(h))) {
          result[fieldType] = i;
        }
      }
    }
    return result;
  }

  /**
   * Build typed expense fields for a single row.
   * Equivalent to Textract LineItemExpenseFields[] where each element has
   * Type.Text (ITEM, PRICE, QUANTITY, UNIT_PRICE…) + ValueDetection.Text.
   */
  private buildExpenseFields(
    row: string[],
    headers: string[],
    colIndex: Record<string, number>,
  ): Record<string, string> {
    const fields: Record<string, string> = {};

    for (const [fieldType, idx] of Object.entries(colIndex)) {
      fields[fieldType] = row[idx] ?? '';
    }

    // Fallback: if no description resolved, use the first non-empty cell
    if (!fields['description']) {
      const rawObj: Record<string, string> = {};
      headers.forEach((h, i) => { rawObj[h] = row[i] ?? ''; });
      const firstKey = Object.keys(rawObj).find((k) => rawObj[k]?.trim());
      if (firstKey) fields['description'] = rawObj[firstKey] ?? '';
    }

    return fields;
  }

  // ---------------------------------------------------------------------------
  // Provider inference — uses real provider strings from reference invoices
  // ---------------------------------------------------------------------------

  private inferProvider(response: OciAnalyzeResponse, fileName: string): string {
    const docType = response.detectedDocumentTypes?.[0]?.documentType?.toLowerCase() ?? '';
    const allKvs = response.keyValues ?? [];
    const allDocFields = (response.pages ?? []).flatMap((p) => p.documentFields ?? []);
    const flat = this.buildSummaryFields(allKvs, allDocFields);
    const vendor = (this.resolveSummaryField(flat, 'vendorName') ?? '').toLowerCase();

    // Combine all signals: document type, vendor name, file name, flat KV keys
    const allText = [docType, vendor, fileName, ...Object.keys(flat)].join(' ').toLowerCase();

    // AWS — "Amazon AWS Serviços Brasil Ltda.", "Amazon Web Services, Inc."
    if (/amazon|aws|aws-|lineitem/.test(allText)) return 'aws';
    // Azure — column headers like "encargos/créditos", "família do produto", "taxa de câmbio"
    if (
      /azure|microsoft|encargos|família do produto|familia do produto|taxa de câmbio/.test(allText)
    ) return 'azure';
    // GCP
    if (/google|gcp/.test(allText)) return 'gcp';
    // OCI
    if (/oracle|oci/.test(allText)) return 'oci';
    return 'unknown';
  }

  // ---------------------------------------------------------------------------
  // Date helpers
  // ---------------------------------------------------------------------------

  /**
   * Parse a billing period that may be:
   *   - A range: "Dec 1 - Dec 31, 2025"          (AWS EN)
   *   - A range: "1 de dez. - 31 de dez. de 2025" (AWS PT-BR)
   *   - A range: "01/12/2025 - 31/12/2025"        (Azure PT)
   *   - A single start date, with end in a separate field
   */
  private parseBillingPeriod(
    startRaw: string,
    endRaw: string,
  ): { start: Date | null; end: Date | null } {
    // Normalize separators in range strings
    const rangePattern = /(.+?)\s*[-–]\s*(.+)/;

    if (startRaw) {
      const match = startRaw.match(rangePattern);
      if (match) {
        const a = this.parseLocalizedDate(match[1]!.trim());
        const b = this.parseLocalizedDate(match[2]!.trim());
        if (a && b) return { start: a, end: b };
        if (a) return { start: a, end: this.parseDate(endRaw) };
      }
    }

    if (endRaw) {
      const match = endRaw.match(rangePattern);
      if (match) {
        const a = this.parseLocalizedDate(match[1]!.trim());
        const b = this.parseLocalizedDate(match[2]!.trim());
        if (a && b) return { start: a, end: b };
      }
    }

    return {
      start: this.parseDate(startRaw),
      end: this.parseDate(endRaw),
    };
  }

  /**
   * Parse dates including Portuguese month abbreviations used in AWS PT-BR invoices:
   *   "1 de dez. de 2025" → Dec 1 2025
   *   "31 de dez. de 2025" → Dec 31 2025
   *   "Dec 1, 2025" → standard
   *   "01/12/2025" → DD/MM/YYYY (Azure PT)
   */
  private parseLocalizedDate(s: string): Date | null {
    if (!s) return null;

    // DD/MM/YYYY or D/M/YYYY (Azure PT billing format)
    const dmyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (dmyMatch) {
      const d = new Date(
        parseInt(dmyMatch[3]!), parseInt(dmyMatch[2]!) - 1, parseInt(dmyMatch[1]!),
      );
      return isNaN(d.getTime()) ? null : d;
    }

    // Portuguese month abbreviations — AWS PT-BR: "1 de dez. de 2025"
    const ptMonths: Record<string, number> = {
      jan: 0, fev: 1, mar: 2, abr: 3, mai: 4, jun: 5,
      jul: 6, ago: 7, set: 8, out: 9, nov: 10, dez: 11,
    };
    const ptMatch = s.match(/(\d{1,2})\s+de\s+(\w+)\.?\s+(?:de\s+)?(\d{4})/i);
    if (ptMatch) {
      const month = ptMonths[ptMatch[2]!.toLowerCase().slice(0, 3)];
      if (month !== undefined) {
        const d = new Date(parseInt(ptMatch[3]!), month, parseInt(ptMatch[1]!));
        return isNaN(d.getTime()) ? null : d;
      }
    }

    // English month abbreviations — AWS EN: "Dec 1, 2025" or "Dec 31, 2025"
    const enMatch = s.match(/^([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})$/);
    if (enMatch) {
      const d = new Date(`${enMatch[1]} ${enMatch[2]}, ${enMatch[3]}`);
      return isNaN(d.getTime()) ? null : d;
    }

    return this.parseDate(s);
  }

  private parseDate(s: string): Date | null {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  private parseNum(s: string): number | null {
    if (!s) return null;
    // Strip currency prefix (e.g. "USD 9.629,19", "BRL 38.206,35")
    const stripped = s.replace(/^[A-Z]{3}\s*/i, '');
    const cleaned = stripped.replace(/\./g, '').replace(/,/g, '.').replace(/[^\d.-]/g, '');
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  }
}

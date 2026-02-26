import { Injectable, Logger } from '@nestjs/common';
import {
  TextractClient,
  AnalyzeExpenseCommand,
  AnalyzeExpenseCommandOutput,
} from '@aws-sdk/client-textract';
import { NormalizedLineItem } from './documents.types';

// ---------------------------------------------------------------------------
// Textract typed field maps — derived from REAL invoices in /references:
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
 * Textract SummaryFields typed field map.
 * Maps Textract Type.Text codes → internal summary key.
 */
const TX_SUMMARY: Record<string, string> = {
  INVOICE_RECEIPT_ID:   'invoiceId',
  VENDOR_NAME:          'vendorName',
  INVOICE_RECEIPT_DATE: 'invoiceDate',
  DUE_DATE:             'dueDate',
  TOTAL:                'total',
  SUBTOTAL:             'subtotal',
  TAX:                  'taxAmount',
  DISCOUNT:             'discount',
};

/**
 * Textract LineItemExpenseFields typed field map.
 * Maps Textract Type.Text codes → internal line-item key.
 */
const TX_LINE_ITEM: Record<string, string> = {
  ITEM:         'description',
  QUANTITY:     'quantity',
  UNIT_PRICE:   'unitPrice',
  PRICE:        'amount',
  PRODUCT_CODE: 'productCode',
};

/**
 * Document-level (SummaryFields) key-value names → typed field category.
 * Used as a fallback for Textract fields where Type.Text === 'OTHER',
 * matched against LabelDetection.Text.
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
 * Used as fallback for unrecognized Textract column types.
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
    'description', 'service', 'item', 'product', 'name', 'details',
    'line item', 'charge', 'product name', 'service name',
    'descrição', 'descricao',
    'tipo de produto', 'tipo de transação', 'tipo de transacao',
  ],
  quantity: [
    'usage quantity', 'quantity', 'qty', 'usage', 'units', 'hours', 'count',
    'quantidade de uso',
    'quantidade',
  ],
  unitPrice: [
    'unit price', 'unit cost', 'rate', 'price per unit', 'unit rate',
    'blended rate',
    'preço de payg', 'preco de payg',
    'preço efetivo', 'preco efetivo',
  ],
  amount: [
    'amount', 'cost', 'price', 'charge', 'line total',
    'extended price', 'extended amount',
    'valor em usd',
    'amount in usd',
    'pre-tax charges', 'post-tax charges',
    'encargos/créditos', 'encargos/creditos',
    'total',
  ],
  taxAmount: [
    'taxes', 'tax',
    'imposto',
  ],
  region: [
    'region', 'location', 'zone', 'area', 'availability domain',
    'aws region', 'armregionname',
    'localização', 'localizacao', 'local',
  ],
  productCode: [
    'product code', 'sku', 'service code', 'part number', 'code', 'item code',
    'sku do produto',
  ],
  unitOfMeasure: [
    'unit of measure', 'unit type', 'uom',
    'tipo de unidade',
  ],
  serviceFamily: [
    'service family', 'product family',
    'família do produto', 'familia do produto',
  ],
  exchangeRate: [
    'taxa de câmbio', 'taxa de cambio',
    'exchange rate',
  ],
};

// ---------------------------------------------------------------------------
// Required env vars:
//   TEXTRACT_ACCESS_KEY_ID, TEXTRACT_SECRET_ACCESS_KEY, TEXTRACT_REGION
//
// Optional (S3 source — equivalent to OCI Object Storage):
//   TEXTRACT_S3_BUCKET
// ---------------------------------------------------------------------------

@Injectable()
export class TextractService {
  private readonly logger = new Logger(TextractService.name);
  private client: TextractClient | null = null;

  isAvailable(): boolean {
    return !!(
      process.env.TEXTRACT_ACCESS_KEY_ID &&
      process.env.TEXTRACT_SECRET_ACCESS_KEY &&
      process.env.TEXTRACT_REGION
    );
  }

  // ---------------------------------------------------------------------------
  // process() — inline bytes source (equivalent to OCI INLINE / base64)
  // ---------------------------------------------------------------------------

  async process(
    buffer: Buffer,
    fileName: string,
  ): Promise<{ lineItems: NormalizedLineItem[]; providerDetected: string }> {
    const command = new AnalyzeExpenseCommand({
      Document: { Bytes: buffer },
    });
    const response = await this.getClient().send(command);
    return this.parseResponse(response, fileName);
  }

  // ---------------------------------------------------------------------------
  // processFromS3() — S3Object source (equivalent to OCI processFromObjectStorage)
  // ---------------------------------------------------------------------------

  async processFromS3(
    bucket: string,
    key: string,
    fileName?: string,
  ): Promise<{ lineItems: NormalizedLineItem[]; providerDetected: string }> {
    const command = new AnalyzeExpenseCommand({
      Document: { S3Object: { Bucket: bucket, Name: key } },
    });
    const response = await this.getClient().send(command);
    return this.parseResponse(response, fileName ?? key);
  }

  // ---------------------------------------------------------------------------
  // Internal — lazy TextractClient factory
  // ---------------------------------------------------------------------------

  private getClient(): TextractClient {
    if (!this.client) {
      this.client = new TextractClient({
        region: process.env.TEXTRACT_REGION ?? 'us-east-1',
        credentials: {
          accessKeyId: process.env.TEXTRACT_ACCESS_KEY_ID!,
          secretAccessKey: process.env.TEXTRACT_SECRET_ACCESS_KEY!,
        },
      });
    }
    return this.client;
  }

  // ---------------------------------------------------------------------------
  // Internal — parse Textract AnalyzeExpense response into NormalizedLineItem[]
  // Traversal: ExpenseDocuments → SummaryFields + LineItemGroups → LineItems
  //            → LineItemExpenseFields
  // ---------------------------------------------------------------------------

  private parseResponse(
    response: AnalyzeExpenseCommandOutput,
    fileName: string,
  ): { lineItems: NormalizedLineItem[]; providerDetected: string } {
    const lineItems: NormalizedLineItem[] = [];

    for (const expenseDoc of response.ExpenseDocuments ?? []) {
      // --- Build typed summary map from SummaryFields ---
      const summary: Record<string, string> = {};

      for (const field of expenseDoc.SummaryFields ?? []) {
        const typeText = field.Type?.Text ?? '';
        const value = (field.ValueDetection?.Text ?? '').trim();
        if (!value) continue;

        if (typeText in TX_SUMMARY) {
          const key = TX_SUMMARY[typeText]!;
          if (!summary[key]) summary[key] = value;
        } else if (typeText === 'OTHER') {
          // Fallback: match raw label text against SUMMARY_FIELD_MAP
          const label = (field.LabelDetection?.Text ?? '').toLowerCase().trim();
          for (const [fieldKey, candidates] of Object.entries(SUMMARY_FIELD_MAP)) {
            if (
              !(fieldKey in summary) &&
              candidates.some((c) => label === c || label.includes(c) || c.includes(label))
            ) {
              summary[fieldKey] = value;
              break;
            }
          }
        }
      }

      const invoiceId = summary['invoiceId'] ?? null;
      const vendorName = summary['vendorName'] ?? null;
      const currency = (summary['currency'] ?? 'USD').toUpperCase().slice(0, 3);
      const headerTax = this.parseNum(summary['taxAmount'] ?? '');

      const { start: billingStart, end: billingEnd } = this.parseBillingPeriod(
        summary['billingPeriodStart'] ?? '',
        summary['billingPeriodEnd'] ?? '',
      );

      // --- Extract line items from LineItemGroups ---
      const docItems: NormalizedLineItem[] = [];

      for (const group of expenseDoc.LineItemGroups ?? []) {
        for (const lineItem of group.LineItems ?? []) {
          const ef: Record<string, string> = {};

          for (const field of lineItem.LineItemExpenseFields ?? []) {
            const typeText = field.Type?.Text ?? '';
            if (typeText === 'EXPENSE_ROW') continue;
            const value = (field.ValueDetection?.Text ?? '').trim();

            if (typeText in TX_LINE_ITEM) {
              ef[TX_LINE_ITEM[typeText]!] = value;
            }
          }

          const productName = ef['description'] ?? null;
          const usageQuantity = this.parseNum(ef['quantity'] ?? '');
          const unitPrice = this.parseNum(ef['unitPrice'] ?? '');
          const costBeforeTax = this.parseNum(ef['amount'] ?? '');
          const productCode = ef['productCode'] ?? null;

          if (!productName && costBeforeTax == null) continue;

          docItems.push({
            invoiceId,
            linkedAccountId: null,
            productName,
            productCode,
            usageQuantity,
            unitPrice,
            costBeforeTax,
            taxAmount: null,
            currencyCode: currency,
            usageStartDate: billingStart,
            usageEndDate: billingEnd,
            rawLine: { expenseFields: ef } as unknown as Record<string, unknown>,
          });
        }
      }

      // --- Fallback: no line items → single receipt-style item from summary ---
      if (docItems.length === 0) {
        const totalAmount = this.parseNum(summary['total'] ?? '');
        if (invoiceId ?? totalAmount ?? vendorName) {
          docItems.push({
            invoiceId,
            linkedAccountId: null,
            productName: vendorName ?? 'Cloud Invoice',
            usageQuantity: null,
            unitPrice: null,
            costBeforeTax: totalAmount,
            taxAmount: headerTax,
            currencyCode: currency,
            usageStartDate: billingStart,
            usageEndDate: billingEnd,
            rawLine: summary as unknown as Record<string, unknown>,
          });
        }
      }

      lineItems.push(...docItems);
    }

    const providerDetected = this.inferProvider(
      lineItems.map((i) => i.productName ?? '').join(' '),
      fileName,
    );

    this.logger.log(
      `Amazon Textract extracted ${lineItems.length} line items from "${fileName}" ` +
        `(provider=${providerDetected})`,
    );

    return { lineItems, providerDetected };
  }

  // ---------------------------------------------------------------------------
  // Provider inference — uses real provider strings from reference invoices
  // ---------------------------------------------------------------------------

  private inferProvider(allText: string, fileName: string): string {
    const text = [allText, fileName].join(' ').toLowerCase();

    // AWS — "Amazon AWS Serviços Brasil Ltda.", "Amazon Web Services, Inc."
    if (/amazon|aws|aws-|lineitem/.test(text)) return 'aws';
    // Azure — column headers like "encargos/créditos", "família do produto", "taxa de câmbio"
    if (
      /azure|microsoft|encargos|família do produto|familia do produto|taxa de câmbio/.test(text)
    )
      return 'azure';
    // GCP
    if (/google|gcp/.test(text)) return 'gcp';
    // OCI
    if (/oracle|oci/.test(text)) return 'oci';
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
        parseInt(dmyMatch[3]!),
        parseInt(dmyMatch[2]!) - 1,
        parseInt(dmyMatch[1]!),
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
    const cleaned = stripped
      .replace(/\./g, '')
      .replace(/,/g, '.')
      .replace(/[^\d.-]/g, '');
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  }
}

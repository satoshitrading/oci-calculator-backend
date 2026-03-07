import { Injectable, Logger } from '@nestjs/common';
import { NormalizedLineItem } from './documents.types';
// @google/genai is loaded via dynamic import() to stay compatible with
// this CommonJS NestJS host. All types from that package are inlined below.

// ---------------------------------------------------------------------------
// Required env var:
//   GEMINI_API_KEY  – Google AI Studio API key (aistudio.google.com/app/apikey)
//
// Optional:
//   GEMINI_MODEL        – model name (default: gemini-2.5-flash)
//   GEMINI_MAX_RETRIES  – retries on ECONNRESET/network errors (default: 3)
//   GEMINI_RETRY_DELAY_MS – base delay in ms for exponential backoff (default: 2000)
//   GEMINI_TIMEOUT_MS       – request timeout in ms, 60s–300s (default: 120000)
//   GEMINI_PDF_PAGES_PER_CHUNK – max pages per Gemini request, 1–2 (default: 2); PDFs with more pages are split.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Structured output schema — uses the Type enum from @google/genai
// ---------------------------------------------------------------------------

// String literals match Type enum values exactly (verified: Type.OBJECT='OBJECT', etc.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const INVOICE_SCHEMA: Record<string, any> = {
  type: 'OBJECT',
  properties: {
    invoiceId:          { type: 'STRING',  description: 'Invoice / receipt / document ID' },
    vendorName:         { type: 'STRING',  description: 'Vendor / supplier / biller name' },
    accountId:          { type: 'STRING',  description: 'Payer / linked account ID' },
    currency:           { type: 'STRING',  description: '3-letter ISO currency code, e.g. USD' },
    invoiceDate:        { type: 'STRING',  description: 'Invoice issue date (ISO 8601 or as written)' },
    dueDate:            { type: 'STRING',  description: 'Payment due date (ISO 8601 or as written)' },
    billingPeriodStart: { type: 'STRING',  description: 'Billing period start date' },
    billingPeriodEnd:   { type: 'STRING',  description: 'Billing period end date' },
    total:              { type: 'NUMBER',  description: 'Grand total amount (after tax)' },
    subtotal:           { type: 'NUMBER',  description: 'Pre-tax subtotal' },
    taxAmount:          { type: 'NUMBER',  description: 'Total tax amount' },
    discount:           { type: 'NUMBER',  description: 'Total discount applied' },
    lineItems: {
      type: 'ARRAY',
      description: 'Individual charge line items from the invoice table(s)',
      items: {
        type: 'OBJECT',
        properties: {
          description:   { type: 'STRING', description: 'Service / product description' },
          productCode:   { type: 'STRING', description: 'SKU / product code' },
          serviceFamily: { type: 'STRING', description: 'Service family / product family' },
          region:        { type: 'STRING', description: 'Cloud region or location' },
          quantity:      { type: 'NUMBER', description: 'Usage quantity' },
          unitOfMeasure: { type: 'STRING', description: 'Unit of measure (e.g. Hrs, GB)' },
          unitPrice:     { type: 'NUMBER', description: 'Price per unit' },
          amount:        { type: 'NUMBER', description: 'Line item total (pre-tax)' },
          taxAmount:     { type: 'NUMBER', description: 'Tax for this line item' },
        },
        required: ['description'],
      },
    },
  },
  required: ['lineItems'],
};

// ---------------------------------------------------------------------------
// Extraction prompt — instructs Gemini on how to read a cloud invoice PDF.
// Language-agnostic: covers EN and PT-BR variants seen in real invoices.
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `
You are a precise financial document parser specialising in cloud provider invoices
(AWS, Azure, GCP, OCI) in English and Brazilian Portuguese.

YOUR TASK: Extract the structured data described below from the attached invoice PDF.

════════════════════════════════════════════════════════
BILLING PERIOD  (billingPeriodStart / billingPeriodEnd)
════════════════════════════════════════════════════════
Look for a header label such as:
  • "Billing period", "Período de faturamento"
  • A date range near the top of the invoice, e.g.:
      "December 1, 2024 – December 31, 2024"
      "Dec 1, 2024 – Jan 1, 2025"
      "01/12/2024 – 31/12/2024"
      "1 de dez. de 2024 – 31 de dez. de 2024"
Always set BOTH billingPeriodStart AND billingPeriodEnd.
Output each as YYYY-MM-DD (ISO 8601).
If only a single month/year is shown (e.g. "December 2024"),
  set billingPeriodStart = first day of that month,
  set billingPeriodEnd   = last day of that month.
NEVER copy the invoice-issued date or due date into the billing period fields.

════════════════════════════════════════════════════════
TOTAL TAX  (taxAmount — root level, not inside lineItems)
════════════════════════════════════════════════════════
Look for a SUMMARY row (not a charge row) labeled:
  • "Total tax", "Tax", "Taxes", "Total de impostos", "Imposto total"
This is a single document-level number, e.g. "USD 230.23" → 230.23.
Place it in the ROOT taxAmount field, NOT in any line item's taxAmount.

════════════════════════════════════════════════════════
LINE ITEMS  (lineItems array)
════════════════════════════════════════════════════════
Extract EVERY individual charge row from every service table.
Do NOT include summary rows (subtotal, total, taxes) as line items.
Each line item must have at minimum a description and an amount.
Line item taxAmount should only be filled if the row itself shows a per-item tax.
For AWS-style tables, amount is the authoritative charge per line; quantity is optional.

════════════════════════════════════════════════════════
AMOUNTS & CURRENCY
════════════════════════════════════════════════════════
Strip currency symbols and thousand separators — plain numbers only:
  "USD 1,234.56" → 1234.56
  "R$ 9.629,19"  → 9629.19
currency: 3-letter ISO code (USD, BRL, EUR…). Infer from context if not explicit.

════════════════════════════════════════════════════════
GENERAL RULES
════════════════════════════════════════════════════════
- Return ONLY valid JSON matching the schema. No markdown, no prose.
- Omit a field entirely if its value is not present in the document (do not output null).
`.trim();

/** Prompt suffix when sending a partial PDF (page range) so the model knows context. */
function extractionPromptForPageRange(startPage: number, endPage: number, totalPages: number): string {
  return `${EXTRACTION_PROMPT}\n\nThis PDF shows only pages ${startPage}–${endPage} of ${totalPages}. Extract all line items and any header/summary fields visible on these pages.`;
}

// ---------------------------------------------------------------------------
// Typed Gemini response — matches INVOICE_SCHEMA
// ---------------------------------------------------------------------------

interface GeminiLineItem {
  description?: string;
  productCode?: string;
  serviceFamily?: string;
  region?: string;
  quantity?: number;
  unitOfMeasure?: string;
  unitPrice?: number;
  amount?: number;
  taxAmount?: number;
}

interface GeminiInvoice {
  invoiceId?: string;
  vendorName?: string;
  accountId?: string;
  currency?: string;
  invoiceDate?: string;
  dueDate?: string;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  total?: number;
  subtotal?: number;
  taxAmount?: number;
  discount?: number;
  lineItems?: GeminiLineItem[];
}

@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private clientPromise: Promise<any> | null = null;

  isAvailable(): boolean {
    return !!process.env.GEMINI_API_KEY;
  }

  // ---------------------------------------------------------------------------
  // process() — send PDF buffer to Gemini and return NormalizedLineItem[]
  // ---------------------------------------------------------------------------

  /** Transient network errors that are worth retrying (ECONNRESET, timeouts, AbortError, etc.). */
  private isRetryableNetworkError(err: unknown): boolean {
    const e = err as { name?: string; message?: string; cause?: unknown };
    const msg = (e?.message ?? '').toLowerCase();
    if (msg.includes('fetch failed') || msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('aborted')) return true;
    if (e?.name === 'AbortError') return true;
    const cause = e?.cause as { code?: string } | undefined;
    return cause?.code === 'ECONNRESET' || cause?.code === 'ETIMEDOUT' || cause?.code === 'ECONNREFUSED';
  }

  private async delayMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Get PDF page count via pdf-lib. Returns 0 on failure so caller can fall back to single-doc. */
  private async getPdfPageCount(buffer: Buffer): Promise<number> {
    try {
      const { PDFDocument } = await import('pdf-lib');
      const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
      return doc.getPageCount();
    } catch {
      return 0;
    }
  }

  /** Extract a 1-based page range [startPage, endPage] into a new PDF buffer. */
  private async extractPdfPageRange(
    buffer: Buffer,
    startPage1Based: number,
    endPage1Based: number,
  ): Promise<Buffer> {
    const { PDFDocument } = await import('pdf-lib');
    const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const dest = await PDFDocument.create();
    const indices = Array.from(
      { length: endPage1Based - startPage1Based + 1 },
      (_, i) => startPage1Based - 1 + i,
    );
    const copied = await dest.copyPages(source, indices);
    for (const page of copied) {
      dest.addPage(page);
    }
    const bytes = await dest.save();
    return Buffer.from(bytes);
  }

  async process(
    buffer: Buffer,
    fileName: string,
    options?: { onProgress?: (processedPages: number, totalPages: number) => void },
  ): Promise<{
    lineItems: NormalizedLineItem[];
    providerDetected: string;
    totalTax: number | null;
    invoiceBillingPeriod: { start: Date | null; end: Date | null };
  }> {
    this.logger.log(`Gemini AI extraction started for "${fileName}"`);

    const pagesPerChunk = Math.min(2, Math.max(1, parseInt(process.env.GEMINI_PDF_PAGES_PER_CHUNK ?? '2', 10)));
    const totalPages = await this.getPdfPageCount(buffer);
    const useChunks = totalPages > pagesPerChunk;

    if (useChunks && totalPages > 0) {
      this.logger.log(`Splitting "${fileName}" into page ranges (${totalPages} pages, ${pagesPerChunk} per request)`);
      return this.processByPageRanges(buffer, fileName, totalPages, pagesPerChunk, options?.onProgress);
    }

    const result = await this.processSingleBuffer(buffer, fileName, EXTRACTION_PROMPT);
    options?.onProgress?.(1, 1);
    return result;
  }

  /**
   * Process a PDF in chunks of 1–2 pages, then merge results.
   * Invoice-level fields (billing period, total tax, provider) taken from the first chunk.
   */
  private async processByPageRanges(
    buffer: Buffer,
    fileName: string,
    totalPages: number,
    pagesPerChunk: number,
    onProgress?: (processedPages: number, totalPages: number) => void,
  ): Promise<{
    lineItems: NormalizedLineItem[];
    providerDetected: string;
    totalTax: number | null;
    invoiceBillingPeriod: { start: Date | null; end: Date | null };
  }> {
    const ranges: [number, number][] = [];
    for (let start = 1; start <= totalPages; start += pagesPerChunk) {
      const end = Math.min(start + pagesPerChunk - 1, totalPages);
      ranges.push([start, end]);
    }

    const totalChunks = ranges.length;
    const chunkResults: {
      lineItems: NormalizedLineItem[];
      providerDetected: string;
      totalTax: number | null;
      invoiceBillingPeriod: { start: Date | null; end: Date | null };
    }[] = [];

    for (let i = 0; i < ranges.length; i++) {
      const [start, end] = ranges[i]!;
      const chunkBuffer = await this.extractPdfPageRange(buffer, start, end);
      const prompt = extractionPromptForPageRange(start, end, totalPages);
      const label = `pages ${start}-${end}/${totalPages}`;
      this.logger.log(`Processing "${fileName}" (${label})`);
      const result = await this.processSingleBuffer(chunkBuffer, fileName, prompt);
      chunkResults.push(result);
      onProgress?.(i + 1, totalChunks);
    }

    const allLineItems = chunkResults.flatMap((r) => r.lineItems);
    const first = chunkResults[0]!;
    const providerDetected = first.providerDetected || chunkResults.find((r) => r.providerDetected)?.providerDetected || 'unknown';
    const totalTax = first.totalTax ?? chunkResults.find((r) => r.totalTax != null)?.totalTax ?? null;
    const invoiceBillingPeriod =
      (first.invoiceBillingPeriod.start != null || first.invoiceBillingPeriod.end != null)
        ? first.invoiceBillingPeriod
        : chunkResults.find(
            (r) => r.invoiceBillingPeriod.start != null || r.invoiceBillingPeriod.end != null,
          )?.invoiceBillingPeriod ?? first.invoiceBillingPeriod;

    this.logger.log(
      `Merged ${chunkResults.length} chunks for "${fileName}": ${allLineItems.length} line items (provider=${providerDetected})`,
    );
    return {
      lineItems: allLineItems,
      providerDetected,
      totalTax,
      invoiceBillingPeriod,
    };
  }

  /**
   * Single Gemini request with retries. Used for full PDF or one page-range chunk.
   */
  private async processSingleBuffer(
    buffer: Buffer,
    fileName: string,
    promptText: string,
  ): Promise<{
    lineItems: NormalizedLineItem[];
    providerDetected: string;
    totalTax: number | null;
    invoiceBillingPeriod: { start: Date | null; end: Date | null };
  }> {
    const ai = await this.getClient();
    const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
    const maxRetries = Math.max(1, parseInt(process.env.GEMINI_MAX_RETRIES ?? '3', 10));
    const baseDelayMs = Math.max(500, parseInt(process.env.GEMINI_RETRY_DELAY_MS ?? '2000', 10));

    const payload = {
      model: modelName,
      contents: [
        { inlineData: { data: buffer.toString('base64'), mimeType: 'application/pdf' } },
        { text: promptText },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: INVOICE_SCHEMA,
        toolConfig: { functionCallingConfig: { mode: 'NONE' } },
      },
    };

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await ai.models.generateContent(payload);
        return this.parseAndMapResponse(response, fileName);
      } catch (err: unknown) {
        lastErr = err;
        const e = err as { name?: string; message?: string; status?: number; cause?: unknown };
        const cause = e.cause as { code?: string } | undefined;
        this.logger.warn(
          `Gemini API attempt ${attempt}/${maxRetries} failed for "${fileName}": [${e.status ?? 'unknown'}] ${e.name} – ${e.message}` +
          (cause?.code ? ` (cause: ${cause.code})` : ''),
        );
        if (attempt < maxRetries && this.isRetryableNetworkError(err)) {
          const delay = baseDelayMs * Math.pow(2, attempt - 1);
          this.logger.log(`Retrying in ${delay}ms...`);
          await this.delayMs(delay);
        } else {
          this.logger.error(
            `Gemini API error for "${fileName}": [${e.status ?? 'unknown'}] ${e.name} – ${e.message}` +
            (cause?.code ? ` (cause: ${cause.code})` : ''),
          );
          throw err;
        }
      }
    }
    throw lastErr;
  }

  private parseAndMapResponse(
    response: { text?: string },
    fileName: string,
  ): {
    lineItems: NormalizedLineItem[];
    providerDetected: string;
    totalTax: number | null;
    invoiceBillingPeriod: { start: Date | null; end: Date | null };
  } {

    const raw = (response.text ?? '').trim();
    if (!raw) {
      throw new Error(`Gemini returned an empty response for "${fileName}"`);
    }

    let invoice: GeminiInvoice;
    try {
      invoice = JSON.parse(raw) as GeminiInvoice;
    } catch {
      this.logger.error(`Gemini returned invalid JSON for "${fileName}": ${raw.slice(0, 200)}`);
      throw new Error(`Gemini returned invalid JSON for "${fileName}"`);
    }

    return this.mapToLineItems(invoice, fileName);
  }

  // ---------------------------------------------------------------------------
  // Internal — lazy GoogleGenAI client via dynamic import (ESM package in CJS host)
  // ---------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getClient(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = import('@google/genai').then(({ GoogleGenAI }) => {
        const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
        if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
        const timeoutMs = Math.min(300_000, Math.max(60_000, parseInt(process.env.GEMINI_TIMEOUT_MS ?? '120000', 10)));
        return new GoogleGenAI({ apiKey, httpOptions: { timeout: timeoutMs } } as any);
      });
    }
    return this.clientPromise;
  }

  // ---------------------------------------------------------------------------
  // Internal — map GeminiInvoice → NormalizedLineItem[]
  // ---------------------------------------------------------------------------

  private mapToLineItems(
    invoice: GeminiInvoice,
    fileName: string,
  ): {
    lineItems: NormalizedLineItem[];
    providerDetected: string;
    totalTax: number | null;
    invoiceBillingPeriod: { start: Date | null; end: Date | null };
  } {
    const invoiceId = invoice.invoiceId ?? null;
    const accountId = invoice.accountId ?? null;
    const vendorName = invoice.vendorName ?? null;
    const currency = (invoice.currency ?? 'USD').toUpperCase().slice(0, 3);
    const totalTax = invoice.taxAmount ?? null;

    const invoiceBillingPeriod = this.parseBillingPeriod(
      invoice.billingPeriodStart ?? '',
      invoice.billingPeriodEnd ?? '',
    );

    const lineItems: NormalizedLineItem[] = [];

    for (const item of invoice.lineItems ?? []) {
      const productName = item.description?.trim() || null;
      const costBeforeTax = item.amount ?? null;

      if (!productName && costBeforeTax == null) continue;

      lineItems.push({
        invoiceId,
        linkedAccountId: accountId,
        productName,
        productCode: item.productCode?.trim() || null,
        serviceCategory: item.serviceFamily?.trim() || null,
        regionName: item.region?.trim() || null,
        usageQuantity: item.quantity ?? null,
        unitPrice: item.unitPrice ?? null,
        unitOfMeasure: item.unitOfMeasure?.trim() || null,
        costBeforeTax,
        taxAmount: item.taxAmount ?? null,
        currencyCode: currency,
        usageStartDate: null,
        usageEndDate: null,
        rawLine: { gemini: item } as unknown as Record<string, unknown>,
      });
    }

    // Fallback: no line items → single receipt-style item from summary
    if (lineItems.length === 0) {
      const totalAmount = invoice.total ?? null;
      if (invoiceId ?? totalAmount ?? vendorName) {
        lineItems.push({
          invoiceId,
          linkedAccountId: accountId,
          productName: vendorName ?? 'Cloud Invoice',
          usageQuantity: null,
          unitPrice: null,
          costBeforeTax: totalAmount,
          taxAmount: null,
          currencyCode: currency,
          usageStartDate: null,
          usageEndDate: null,
          rawLine: { gemini: invoice } as unknown as Record<string, unknown>,
        });
      }
    }

    const providerDetected = this.inferProvider(
      [vendorName ?? '', ...lineItems.map((i) => i.productName ?? '')].join(' '),
      fileName,
    );

    this.logger.log(
      `Gemini AI extracted ${lineItems.length} line items from "${fileName}" ` +
        `(provider=${providerDetected}, totalTax=${totalTax}, ` +
        `billingPeriod=${invoiceBillingPeriod.start?.toISOString().slice(0, 10)} – ` +
        `${invoiceBillingPeriod.end?.toISOString().slice(0, 10)})`,
    );

    return { lineItems, providerDetected, totalTax, invoiceBillingPeriod };
  }

  // ---------------------------------------------------------------------------
  // Provider inference
  // ---------------------------------------------------------------------------

  private inferProvider(allText: string, fileName: string): string {
    const text = [allText, fileName].join(' ').toLowerCase();
    if (/amazon|aws|aws-|lineitem/.test(text)) return 'aws';
    if (/azure|microsoft|encargos|família do produto|familia do produto|taxa de câmbio/.test(text))
      return 'azure';
    if (/google|gcp/.test(text)) return 'gcp';
    if (/oracle|oci/.test(text)) return 'oci';
    return 'unknown';
  }

  // ---------------------------------------------------------------------------
  // Date helpers
  // ---------------------------------------------------------------------------

  private parseBillingPeriod(
    startRaw: string,
    endRaw: string,
  ): { start: Date | null; end: Date | null } {
    const rangePattern = /(.+?)(?:\s+-\s+|\s*–\s*)(.+)/;

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

    // English month abbreviations — AWS EN: "Dec 1, 2025"
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
}

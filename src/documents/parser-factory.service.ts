import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { NormalizedLineItem } from './documents.types';
import { CsvExtractorService } from './csv-extractor.service';
import { PdfExtractorService } from './pdf-extractor.service';
import { XlsxExtractorService } from './xlsx-extractor.service';
import { TextractService } from './textract.service';
import { GeminiService } from './gemini.service';

export type SupportedFileType = 'pdf' | 'csv' | 'xlsx';
/** Explicit PDF extractor override. 'auto' applies the default priority chain. */
export type PdfExtractor = 'textract' | 'gemini' | 'auto';

export interface ParserResult {
  lineItems: NormalizedLineItem[];
  providerDetected: string;
  fileType: SupportedFileType;
  /** Invoice-level total tax (from summary row, not line items). */
  totalTax?: number | null;
  /** Billing period extracted directly from the invoice header. */
  invoiceBillingPeriod?: { start: Date | null; end: Date | null };
}

const PDF_MAGIC = Buffer.from('%PDF');
const XLSX_ZIP_MAGIC = Buffer.from('PK');
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV_MIMES = new Set(['text/csv', 'text/plain', 'application/csv']);

/**
 * ParserFactory acts as the single entry-point for all file-type routing.
 * It detects the format from magic bytes (preferred), MIME type, and extension,
 * then delegates to the appropriate extractor service.
 *
 * Decision chain for PDF (auto mode):
 *   1. Gemini AI (when GEMINI_API_KEY configured) – AI-powered invoice extraction (default).
 *   2. Amazon Textract (when credentials configured) – structured invoice extraction.
 *   3. pdf-parse + OCR fallback – text heuristic extraction.
 */
@Injectable()
export class ParserFactory {
  private readonly logger = new Logger(ParserFactory.name);

  constructor(
    private readonly csvExtractor: CsvExtractorService,
    private readonly pdfExtractor: PdfExtractorService,
    private readonly xlsxExtractor: XlsxExtractorService,
    private readonly textract: TextractService,
    private readonly gemini: GeminiService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Parse a file received via HTTP multipart upload. */
  async parse(
    file: Express.Multer.File,
    providerHint?: string,
    extractor: PdfExtractor = 'auto',
  ): Promise<ParserResult> {
    const buffer = this.toBuffer(file);
    return this.parseFromBuffer(buffer, file.originalname ?? '', file.mimetype ?? '', providerHint, extractor);
  }

  /**
   * Parse a raw buffer — used by CollectorService when streaming files directly
   * from cloud storage (S3 / OCI Object Storage) without a Multer file wrapper.
   *
   * @param buffer       Full file content as a Buffer
   * @param fileName     Original file name (used for extension/magic-byte detection)
   * @param mimeType     MIME type hint (may be empty; magic bytes take precedence)
   * @param providerHint Optional cloud provider override
   * @param extractor    Force a specific PDF extractor ('textract' | 'gemini' | 'auto')
   */
  async parseFromBuffer(
    buffer: Buffer,
    fileName: string,
    mimeType: string,
    providerHint?: string,
    extractor: PdfExtractor = 'auto',
  ): Promise<ParserResult> {
    const fileType = this.detectFileType(buffer, fileName, mimeType);
    this.logger.debug(`Routing buffer "${fileName}" → parser: ${fileType}`);

    switch (fileType) {
      case 'csv':
        return this.parseCsv(buffer, fileName, providerHint);
      case 'xlsx':
        return this.parseXlsx(buffer, fileName, providerHint);
      case 'pdf':
        return this.parsePdf(buffer, fileName, providerHint, extractor);
    }
  }

  detectFileType(buffer: Buffer, fileName: string, mimeType: string): SupportedFileType {
    // --- Magic bytes (most reliable) ---
    if (buffer.length >= 4 && buffer.subarray(0, 4).equals(PDF_MAGIC)) {
      return 'pdf';
    }
    if (
      buffer.length >= 2 &&
      buffer.subarray(0, 2).equals(XLSX_ZIP_MAGIC) &&
      (mimeType === XLSX_MIME || /\.xlsx$/i.test(fileName))
    ) {
      return 'xlsx';
    }

    // --- MIME type ---
    if (mimeType === 'application/pdf' || /\.pdf$/i.test(fileName)) return 'pdf';
    if (mimeType === XLSX_MIME || /\.xlsx$/i.test(fileName)) return 'xlsx';
    if (CSV_MIMES.has(mimeType) || /\.csv$/i.test(fileName)) return 'csv';

    // --- Content sniff (last resort) ---
    const preview = buffer.slice(0, 1024).toString('utf8');
    if (!preview.includes('%PDF') && /[,;\t]/.test(preview)) return 'csv';

    throw new BadRequestException(
      'Unsupported file type. Upload a PDF invoice, a CSV billing export, or an XLSX workbook.',
    );
  }

  // ---------------------------------------------------------------------------
  // Private parsers
  // ---------------------------------------------------------------------------

  private parseCsv(
    buffer: Buffer,
    fileName: string,
    providerHint?: string,
  ): ParserResult {
    const { rows, providerDetected } = this.csvExtractor.extract(buffer, fileName);
    const resolved = providerHint ?? providerDetected;
    const lineItems = this.csvExtractor.normalizeRows(rows, resolved);
    return { lineItems, providerDetected: resolved, fileType: 'csv' };
  }

  private async parseXlsx(
    buffer: Buffer,
    fileName: string,
    providerHint?: string,
  ): Promise<ParserResult> {
    const { rows, providerDetected } = await this.xlsxExtractor.extract(buffer, fileName);
    const resolved = providerHint ?? providerDetected;
    const lineItems = this.xlsxExtractor.normalizeRows(rows, resolved);
    return { lineItems, providerDetected: resolved, fileType: 'xlsx' };
  }

  private async parsePdf(
    buffer: Buffer,
    fileName: string,
    providerHint?: string,
    extractor: PdfExtractor = 'auto',
  ): Promise<ParserResult> {
    // --- Explicit extractor: textract ---
    if (extractor === 'textract') {
      if (!this.textract.isAvailable()) {
        throw new BadRequestException(
          'Amazon Textract is not configured. Set TEXTRACT_ACCESS_KEY_ID, ' +
            'TEXTRACT_SECRET_ACCESS_KEY, and TEXTRACT_REGION.',
        );
      }
      this.logger.log('Using Amazon Textract for PDF processing (explicit)');
      const { lineItems, providerDetected } = await this.textract.process(buffer, fileName);
      return { lineItems, providerDetected: providerHint ?? providerDetected, fileType: 'pdf' };
    }

    // --- Explicit extractor: gemini ---
    if (extractor === 'gemini') {
      if (!this.gemini.isAvailable()) {
        throw new BadRequestException(
          'Gemini AI is not configured. Set GEMINI_API_KEY.',
        );
      }
      this.logger.log('Using Gemini AI for PDF processing (explicit)');
      const { lineItems, providerDetected, totalTax, invoiceBillingPeriod } =
        await this.gemini.process(buffer, fileName);
      return {
        lineItems,
        providerDetected: providerHint ?? providerDetected,
        fileType: 'pdf',
        totalTax,
        invoiceBillingPeriod,
      };
    }

    // --- Auto: try Gemini → Textract → pdf-parse + OCR ---
    if (this.gemini.isAvailable()) {
      this.logger.log('Using Gemini AI for PDF processing');
      const { lineItems, providerDetected, totalTax, invoiceBillingPeriod } =
        await this.gemini.process(buffer, fileName);
      return {
        lineItems,
        providerDetected: providerHint ?? providerDetected,
        fileType: 'pdf',
        totalTax,
        invoiceBillingPeriod,
      };
    }

    if (this.textract.isAvailable()) {
      this.logger.log('Using Amazon Textract for PDF processing');
      const { lineItems, providerDetected } = await this.textract.process(buffer, fileName);
      return { lineItems, providerDetected: providerHint ?? providerDetected, fileType: 'pdf' };
    }

    this.logger.debug('No AI extractor configured (GEMINI_API_KEY / Textract creds); falling back to pdf-parse + OCR');
    const { text, providerDetected } = await this.pdfExtractor.extract(buffer, fileName);
    const lineItems = this.pdfExtractor.normalizeTextToLineItems(text, fileName);
    return {
      lineItems,
      providerDetected: providerHint ?? providerDetected,
      fileType: 'pdf',
    };
  }

  private toBuffer(file: Express.Multer.File): Buffer {
    return Buffer.isBuffer(file.buffer)
      ? file.buffer
      : Buffer.from(file.buffer as unknown as ArrayBuffer);
  }
}

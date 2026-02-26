import { Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse');
import { NormalizedLineItem } from './documents.types';
import { OcrService } from './ocr.service';
import { ProviderDetectionService } from './provider-detection.service';

function parseNum(s: string): number | null {
  const cleaned = s.replace(/,/g, '.').replace(/[^\d.-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

function parseDate(s: string): Date | null {
  const d = new Date(s.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

function extractInvoiceFieldsFromText(text: string): {
  invoiceId: string | null;
  usageStartDate: Date | null;
  usageEndDate: Date | null;
} {
  let invoiceId: string | null = null;
  let usageStartDate: Date | null = null;
  let usageEndDate: Date | null = null;
  const invoiceIdMatch = text.match(
    /(?:invoice\s*#?\s*|invoice\s*id\s*:?\s*|bill[/\s]invoiceid\s*:?\s*)([A-Za-z0-9\-_]+)/i,
  );
  if (invoiceIdMatch?.[1]) invoiceId = invoiceIdMatch[1].trim();
  const periodMatch = text.match(
    /(?:billing\s*period\s*:?\s*|periodo\s*:?\s*)(\d{4}-\d{2}-\d{2}|\d{2}[/\-]\d{2}[/\-]\d{4})\s*[-–to]+\s*(\d{4}-\d{2}-\d{2}|\d{2}[/\-]\d{2}[/\-]\d{4})/i,
  );
  if (periodMatch?.[1]) usageStartDate = parseDate(periodMatch[1].trim());
  if (periodMatch?.[2]) usageEndDate = parseDate(periodMatch[2].trim());
  const singleDateMatch = text.match(
    /(?:billing\s*period\s*start\s*:?\s*|usage\s*start\s*:?\s*)(\d{4}-\d{2}-\d{2}|\d{2}[/\-]\d{2}[/\-]\d{4})/i,
  );
  if (singleDateMatch?.[1] && !usageStartDate) usageStartDate = parseDate(singleDateMatch[1].trim());
  return { invoiceId, usageStartDate, usageEndDate };
}

@Injectable()
export class PdfExtractorService {
  constructor(
    private readonly providerDetection: ProviderDetectionService,
    private readonly ocrService: OcrService,
  ) {}

  async extract(buffer: Buffer, fileName: string): Promise<{ text: string; numPages: number; providerDetected: string }> {
    const data = await pdfParse(buffer);
    let text = data.text || '';
    const numPages = data.numpages || 0;

    if (this.ocrService.isTextInsufficient(text) && numPages > 0) {
      try {
        const ocrText = await this.ocrService.extractTextFromPdfPages(buffer, numPages);
        if (ocrText.trim()) text = ocrText;
      } catch {
        throw new Error(
          'Document could not be read. Please verify the file is not corrupted or password-protected. Scanned PDFs require ImageMagick or GraphicsMagick and Ghostscript for OCR.',
        );
      }
    }

    const providerDetected = this.providerDetection.detectFromFileName(fileName);
    const fromText = this.providerDetection.detectFromColumnNames([]);
    const lower = text.toLowerCase();
    let fromContent: 'aws' | 'azure' | 'gcp' | 'oci' | 'unknown' = 'unknown';
    if (lower.includes('amazon') || lower.includes('lineitem')) fromContent = 'aws';
    else if (lower.includes('azure') || lower.includes('microsoft') || lower.includes('meter')) fromContent = 'azure';
    else if (lower.includes('google') || lower.includes('gcp')) fromContent = 'gcp';
    else if (lower.includes('oracle') || lower.includes('oci')) fromContent = 'oci';
    const provider = providerDetected !== 'unknown' ? providerDetected : fromContent !== 'unknown' ? fromContent : fromText;
    return { text, numPages, providerDetected: provider };
  }

  normalizeTextToLineItems(text: string, fileName: string): NormalizedLineItem[] {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const items: NormalizedLineItem[] = [];
    const costPattern = /[\d.,]+\s*(USD|BRL|EUR|usd|brl|eur)?/g;
    for (const line of lines) {
      const numbers = line.match(/\d+[.,]\d+/g);
      const costs = line.match(costPattern);
      let costBeforeTax: number | null = null;
      if (numbers && numbers.length > 0) {
        const lastNum = numbers[numbers.length - 1];
        costBeforeTax = parseNum(lastNum ?? '');
      }
      if (costBeforeTax == null && costs && costs.length > 0) {
        costBeforeTax = parseNum(costs[costs.length - 1] ?? '');
      }
      const dateMatch = line.match(/\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}|\d{2}-\d{2}-\d{4}/);
      const usageStartDate = dateMatch ? parseDate(dateMatch[0]) : null;
      const currencyMatch = line.match(/\b(USD|BRL|EUR)\b/i);
      const currencyCode = (currencyMatch?.[1] ?? 'USD').toUpperCase().slice(0, 3);
      items.push({
        productName: line.length > 200 ? line.slice(0, 200) : line || null,
        usageStartDate,
        usageEndDate: null,
        usageQuantity: null,
        costBeforeTax,
        taxAmount: null,
        currencyCode,
        rawLine: { line } as unknown as Record<string, unknown>,
      });
    }
    if (items.length === 0 && text.trim()) {
      items.push({
        productName: 'Full text extraction (no table structure detected)',
        usageStartDate: null,
        usageEndDate: null,
        usageQuantity: null,
        costBeforeTax: null,
        taxAmount: null,
        currencyCode: 'USD',
        rawLine: { text: text.slice(0, 2000) } as unknown as Record<string, unknown>,
      });
    }
    const { invoiceId, usageStartDate: docStart, usageEndDate: docEnd } = extractInvoiceFieldsFromText(text);
    if (items.length > 0 && (invoiceId ?? docStart ?? docEnd)) {
      const first = items[0]!;
      if (invoiceId) first.invoiceId = invoiceId;
      if (docStart) first.usageStartDate = docStart;
      if (docEnd) first.usageEndDate = docEnd;
    }
    return items;
  }
}

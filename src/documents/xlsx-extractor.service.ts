import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { NormalizedLineItem } from './documents.types';
import { CsvExtractorService } from './csv-extractor.service';
import { ProviderDetectionService } from './provider-detection.service';

function cellToString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && !Number.isNaN(value)) return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

@Injectable()
export class XlsxExtractorService {
  constructor(
    private readonly csvExtractor: CsvExtractorService,
    private readonly providerDetection: ProviderDetectionService,
  ) {}

  async extract(
    buffer: Buffer,
    fileName: string,
  ): Promise<{ rows: Record<string, string>[]; providerDetected: string }> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const allRows: Record<string, string>[] = [];
    let providerDetected = this.providerDetection.detectFromFileName(fileName);

    for (const sheet of workbook.worksheets) {
      if (!sheet || sheet.rowCount === 0) continue;
      const headerRow = sheet.getRow(1);
      const headers: string[] = [];
      headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const header = cellToString(cell.value);
        headers[colNumber - 1] = header || `Column${colNumber}`;
      });
      const hasDataColumns = headers.some((h) => h && h.length > 0);
      if (!hasDataColumns) continue;

      const fromCols = this.providerDetection.detectFromColumnNames(headers);
      if (providerDetected === 'unknown' && fromCols !== 'unknown') {
        providerDetected = fromCols;
      }

      for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex++) {
        const row = sheet.getRow(rowIndex);
        const record: Record<string, string> = {};
        let hasAnyValue = false;
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          const key = headers[colNumber - 1] ?? `Column${colNumber}`;
          const str = cellToString(cell.value);
          record[key] = str;
          if (str) hasAnyValue = true;
        });
        if (hasAnyValue) {
          allRows.push(record);
        }
      }
    }

    if (allRows.length === 0 && workbook.worksheets.length > 0) {
      const firstSheet = workbook.worksheets[0];
      const headerRow = firstSheet.getRow(1);
      const headers: string[] = [];
      headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        headers[colNumber - 1] = cellToString(cell.value) || `Column${colNumber}`;
      });
      const fromCols = this.providerDetection.detectFromColumnNames(headers);
      if (providerDetected === 'unknown') providerDetected = fromCols;
    }

    return { rows: allRows, providerDetected };
  }

  normalizeRows(rows: Record<string, string>[], providerDetected: string): NormalizedLineItem[] {
    return this.csvExtractor.normalizeRows(rows, providerDetected);
  }
}

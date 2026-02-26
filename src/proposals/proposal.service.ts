import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import * as ExcelJS from 'exceljs';
import { CalculationResult } from '../calculate/calculation.service';
import { LiftAndShiftResult } from '../oci-cost-modeling/oci-cost-modeling.service';

@Injectable()
export class ProposalService {
  async generatePdfProposal(params: {
    customerName?: string;
    projectName?: string;
    calculationResult: CalculationResult;
  }): Promise<Buffer> {
    const { customerName, projectName, calculationResult } = params;
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 40 });
        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        doc.fontSize(18).text('OCI Price Proposal', { align: 'center' });
        doc.moveDown();
        if (projectName) doc.fontSize(12).text(`Project: ${projectName}`);
        if (customerName) doc.fontSize(12).text(`Customer: ${customerName}`);
        doc.moveDown();

        const { totals, currencyCode, billingCountry } = calculationResult;
        doc.fontSize(12).text(`Currency: ${currencyCode}`);
        if (billingCountry) doc.text(`Billing Country: ${billingCountry}`);
        doc.moveDown();

        if (totals) {
          doc.text(`Compute total: ${totals.computeTotal.toFixed(4)} ${currencyCode}`);
          doc.text(`Storage total: ${totals.storageTotal.toFixed(4)} ${currencyCode}`);
          doc.text(`Network total: ${totals.networkTotal.toFixed(4)} ${currencyCode}`);
          doc.text(`License/other total: ${totals.licenseTotal.toFixed(4)} ${currencyCode}`);
          doc.text(`Total before tax: ${totals.totalBeforeTax.toFixed(4)} ${currencyCode}`);
          if (totals.totalAfterTax !== totals.totalBeforeTax) {
            doc.text(`Total after tax: ${totals.totalAfterTax.toFixed(4)} ${currencyCode}`);
          }
          doc.moveDown();
        }

        doc.text('Line items:', { underline: true });
        doc.moveDown(0.5);
        (calculationResult.lineItems ?? []).forEach((item) => {
          doc
            .fontSize(10)
            .text(
              `- ${item.description ?? item.partNumber ?? item.id}: ${item.baseCost.toFixed(4)} ${currencyCode} (${item.formula})`,
            );
        });
        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  async generateExcelProposal(params: {
    customerName?: string;
    projectName?: string;
    calculationResult: CalculationResult;
  }): Promise<{ buffer: Buffer; mimeType: string; extension: string }> {
    const { customerName, projectName, calculationResult } = params;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Proposal');
    const { totals, currencyCode, billingCountry } = calculationResult;
    let rowIndex = 1;

    sheet.getCell(`A${rowIndex}`).value = 'OCI Price Proposal';
    sheet.mergeCells(`A${rowIndex}:D${rowIndex}`);
    rowIndex += 2;
    if (projectName) {
      sheet.getCell(`A${rowIndex}`).value = 'Project';
      sheet.getCell(`B${rowIndex}`).value = projectName;
      rowIndex++;
    }
    if (customerName) {
      sheet.getCell(`A${rowIndex}`).value = 'Customer';
      sheet.getCell(`B${rowIndex}`).value = customerName;
      rowIndex++;
    }
    sheet.getCell(`A${rowIndex}`).value = 'Currency';
    sheet.getCell(`B${rowIndex}`).value = currencyCode;
    rowIndex++;
    if (billingCountry) {
      sheet.getCell(`A${rowIndex}`).value = 'Billing Country';
      sheet.getCell(`B${rowIndex}`).value = billingCountry;
      rowIndex++;
    }
    rowIndex++;
    if (totals) {
      sheet.getCell(`A${rowIndex}`).value = 'Compute total';
      sheet.getCell(`B${rowIndex}`).value = totals.computeTotal;
      rowIndex++;
      sheet.getCell(`A${rowIndex}`).value = 'Storage total';
      sheet.getCell(`B${rowIndex}`).value = totals.storageTotal;
      rowIndex++;
      sheet.getCell(`A${rowIndex}`).value = 'Network total';
      sheet.getCell(`B${rowIndex}`).value = totals.networkTotal;
      rowIndex++;
      sheet.getCell(`A${rowIndex}`).value = 'License/other total';
      sheet.getCell(`B${rowIndex}`).value = totals.licenseTotal;
      rowIndex++;
      sheet.getCell(`A${rowIndex}`).value = 'Total before tax';
      sheet.getCell(`B${rowIndex}`).value = totals.totalBeforeTax;
      rowIndex++;
      if (totals.totalAfterTax !== totals.totalBeforeTax) {
        sheet.getCell(`A${rowIndex}`).value = 'Total after tax';
        sheet.getCell(`B${rowIndex}`).value = totals.totalAfterTax;
        rowIndex++;
      }
    }
    rowIndex += 2;
    sheet.getCell(`A${rowIndex}`).value = 'Line Items';
    rowIndex++;
    sheet.getRow(rowIndex).values = [
      'ID/Part',
      'Description',
      'Metric',
      'Quantity',
      'Hours/Month',
      'Unit Price',
      'Category',
      'Base Cost',
    ];
    rowIndex++;
    (calculationResult.lineItems ?? []).forEach((item) => {
      sheet.getRow(rowIndex).values = [
        item.partNumber ?? item.id,
        item.description,
        item.metric,
        item.quantity,
        item.hoursPerMonth,
        item.unitPrice,
        item.costCategory,
        item.baseCost,
      ];
      rowIndex++;
    });

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return {
      buffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: 'xlsx',
    };
  }

  // ---------------------------------------------------------------------------
  // OCI Migration Proposal — PDF
  // ---------------------------------------------------------------------------

  async generateMigrationPdf(params: {
    customerName?: string;
    projectName?: string;
    modelingResult: LiftAndShiftResult;
  }): Promise<Buffer> {
    const { customerName, projectName, modelingResult } = params;
    const { summary, rows, sourceProvider, currencyCode } = modelingResult;

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 40 });
        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const fmt = (n: number) => n.toFixed(2);

        // Header
        doc.fontSize(20).text('OCI Migration Proposal', { align: 'center' });
        doc.fontSize(10).text('Lift-and-Shift Cost Analysis', { align: 'center' });
        doc.moveDown();

        if (projectName) doc.fontSize(12).text(`Project: ${projectName}`);
        if (customerName) doc.fontSize(12).text(`Customer: ${customerName}`);
        doc.text(`Source Provider: ${sourceProvider.toUpperCase()}`);
        doc.text(`Currency: ${currencyCode}`);
        doc.text(`Generated: ${new Date().toLocaleDateString()}`);
        doc.moveDown();

        // Executive Summary
        doc.fontSize(14).text('Executive Summary', { underline: true });
        doc.moveDown(0.5);
        doc.fontSize(11);
        doc.text(`Total Current Cloud Cost:       ${fmt(summary.totalSourceCost)} ${currencyCode}`);
        doc.text(`Total OCI Estimated Cost:       ${fmt(summary.totalOciEstimatedCost)} ${currencyCode}`);
        doc.text(`Projected Annual Savings:       ${fmt(summary.totalSavings * 12)} ${currencyCode}`);
        doc.text(`Savings Percentage:             ${summary.totalSavingsPct.toFixed(1)}%`);
        doc.moveDown();

        // By Category
        doc.fontSize(14).text('Cost Breakdown by Service Category', { underline: true });
        doc.moveDown(0.5);
        doc.fontSize(10);
        for (const [cat, data] of Object.entries(summary.byCategory)) {
          const savings = data.sourceCost > 0
            ? ((data.savings / data.sourceCost) * 100).toFixed(1)
            : '0.0';
          doc.text(
            `${cat.padEnd(12)}  Source: ${fmt(data.sourceCost).padStart(12)} ${currencyCode}  ` +
            `OCI: ${fmt(data.ociCost).padStart(12)} ${currencyCode}  Savings: ${savings}%`,
          );
        }
        doc.moveDown();

        // Line Items
        doc.fontSize(14).text('Detailed Line Items', { underline: true });
        doc.moveDown(0.5);
        doc.fontSize(8);
        rows.slice(0, 100).forEach((row) => {
          doc.text(
            `${row.sourceService.slice(0, 40).padEnd(40)}  ` +
            `[${row.serviceCategory.slice(0, 8).padEnd(8)}]  ` +
            `Source: ${fmt(row.sourceCost).padStart(10)} ${currencyCode}  ` +
            `OCI (${row.ociSkuPartNumber}): ${fmt(row.ociEstimatedCost).padStart(10)} ${currencyCode}  ` +
            `Save: ${row.savingsPct.toFixed(1)}%`,
          );
        });
        if (rows.length > 100) {
          doc.moveDown(0.5).fontSize(9).text(`... and ${rows.length - 100} more line items`);
        }

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // OCI Migration Proposal — Excel
  // ---------------------------------------------------------------------------

  async generateMigrationExcel(params: {
    customerName?: string;
    projectName?: string;
    modelingResult: LiftAndShiftResult;
  }): Promise<{ buffer: Buffer; mimeType: string; extension: string }> {
    const { customerName, projectName, modelingResult } = params;
    const { summary, rows, sourceProvider, currencyCode } = modelingResult;

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'OCI Price Calculator';
    workbook.created = new Date();

    // ── Summary sheet ──────────────────────────────────────────────────────────
    const summarySheet = workbook.addWorksheet('Executive Summary');
    let r = 1;

    const setHeader = (sheet: ExcelJS.Worksheet, row: number, value: string) => {
      const cell = sheet.getCell(`A${row}`);
      cell.value = value;
      cell.font = { bold: true, size: 14 };
    };

    setHeader(summarySheet, r, 'OCI Migration Proposal');
    summarySheet.mergeCells(`A${r}:D${r}`);
    r += 2;

    if (projectName) { summarySheet.getCell(`A${r}`).value = 'Project'; summarySheet.getCell(`B${r}`).value = projectName; r++; }
    if (customerName) { summarySheet.getCell(`A${r}`).value = 'Customer'; summarySheet.getCell(`B${r}`).value = customerName; r++; }
    summarySheet.getCell(`A${r}`).value = 'Source Provider'; summarySheet.getCell(`B${r}`).value = sourceProvider.toUpperCase(); r++;
    summarySheet.getCell(`A${r}`).value = 'Currency'; summarySheet.getCell(`B${r}`).value = currencyCode; r++;
    summarySheet.getCell(`A${r}`).value = 'Generated'; summarySheet.getCell(`B${r}`).value = new Date().toLocaleDateString(); r += 2;

    setHeader(summarySheet, r, 'Financial Summary');
    summarySheet.mergeCells(`A${r}:D${r}`);
    r++;
    summarySheet.getRow(r).values = ['Metric', 'Monthly', 'Annual'];
    summarySheet.getRow(r).font = { bold: true };
    r++;
    summarySheet.getRow(r).values = ['Current Cloud Cost', summary.totalSourceCost, summary.totalSourceCost * 12]; r++;
    summarySheet.getRow(r).values = ['OCI Estimated Cost', summary.totalOciEstimatedCost, summary.totalOciEstimatedCost * 12]; r++;
    summarySheet.getRow(r).values = ['Projected Savings', summary.totalSavings, summary.totalSavings * 12]; r++;
    summarySheet.getRow(r).values = ['Savings %', `${summary.totalSavingsPct.toFixed(1)}%`, '']; r += 2;

    setHeader(summarySheet, r, 'Breakdown by Service Category');
    summarySheet.mergeCells(`A${r}:F${r}`);
    r++;
    summarySheet.getRow(r).values = ['Category', 'Source Cost', 'OCI Cost', 'Savings', 'Savings %'];
    summarySheet.getRow(r).font = { bold: true };
    r++;
    for (const [cat, data] of Object.entries(summary.byCategory)) {
      const pct = data.sourceCost > 0 ? (data.savings / data.sourceCost) * 100 : 0;
      summarySheet.getRow(r).values = [cat, data.sourceCost, data.ociCost, data.savings, `${pct.toFixed(1)}%`];
      r++;
    }
    summarySheet.getColumn(1).width = 22;
    summarySheet.getColumn(2).width = 18;
    summarySheet.getColumn(3).width = 18;
    summarySheet.getColumn(4).width = 18;

    // ── Line Items sheet ───────────────────────────────────────────────────────
    const itemsSheet = workbook.addWorksheet('Line Items');
    itemsSheet.getRow(1).values = [
      'Source Service',
      'Category',
      'Source Provider',
      'Source Cost',
      'Currency',
      'OCI SKU',
      'OCI SKU Name',
      'OCI Qty',
      'OCI Unit',
      'OCI Unit Price',
      'OCI Est. Cost',
      'Savings',
      'Savings %',
    ];
    itemsSheet.getRow(1).font = { bold: true };

    rows.forEach((row, idx) => {
      itemsSheet.getRow(idx + 2).values = [
        row.sourceService,
        row.serviceCategory,
        row.sourceProvider,
        row.sourceCost,
        row.sourceCurrencyCode,
        row.ociSkuPartNumber,
        row.ociSkuName,
        row.ociEquivalentQuantity ?? '',
        row.ociUnit,
        row.ociUnitPrice,
        row.ociEstimatedCost,
        row.savingsAmount,
        `${row.savingsPct.toFixed(1)}%`,
      ];
    });
    itemsSheet.getColumn(1).width = 40;
    itemsSheet.getColumn(2).width = 14;
    itemsSheet.getColumn(7).width = 36;

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return {
      buffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: 'xlsx',
    };
  }
}

import { Injectable } from '@nestjs/common';
import { CloudProviderDetected } from './documents.types';

const AWS_INDICATORS = [
  'lineitem/usagetype',
  'lineitem/unblendedcost',
  'product/region',
  'product/sku',
  'bill/billingperiod',
  'aws_cur',
  'amazon',
];
const AZURE_INDICATORS = [
  'metercategory',
  'pretaxcost',
  'resourcegroup',
  'armregionname',
  'armskuname',
  'azure',
  'microsoft',
  // Azure Portuguese billing invoice columns
  'encargos/cr',       // ENCARGOS/CRÉDITOS
  'preço de payg',     // PAYG pricing column
  'taxa de câmbio',    // Exchange rate – only present in Azure PT invoices
  'seção de fatura',   // Invoice section
];
const GCP_INDICATORS = [
  'service.description',
  'cost.amount',
  'project.id',
  'gcp',
  'google cloud',
];
const OCI_INDICATORS = ['oracle', 'oci', 'compartment', 'ocpu'];

@Injectable()
export class ProviderDetectionService {
  detectFromFileName(fileName: string): CloudProviderDetected {
    const lower = fileName.toLowerCase();
    if (AWS_INDICATORS.some((i) => lower.includes(i))) return 'aws';
    if (AZURE_INDICATORS.some((i) => lower.includes(i))) return 'azure';
    if (GCP_INDICATORS.some((i) => lower.includes(i))) return 'gcp';
    if (OCI_INDICATORS.some((i) => lower.includes(i))) return 'oci';
    return 'unknown';
  }

  detectFromColumnNames(columns: string[]): CloudProviderDetected {
    const lower = columns.map((c) => c.toLowerCase().trim());
    const has = (arr: string[]) =>
      arr.some((ind) => lower.some((col) => col.includes(ind) || ind.includes(col)));
    if (has(['lineitem/usagetype', 'lineitem/unblendedcost', 'product/region'])) return 'aws';
    if (has(['metercategory', 'pretaxcost', 'armregionname'])) return 'azure';
    if (has(['service.description', 'cost.amount', 'project.id'])) return 'gcp';
    if (has(['compartment', 'ocpu', 'oracle'])) return 'oci';
    return 'unknown';
  }

  detectFromFirstRow(row: Record<string, unknown>): CloudProviderDetected {
    return this.detectFromColumnNames(Object.keys(row));
  }
}

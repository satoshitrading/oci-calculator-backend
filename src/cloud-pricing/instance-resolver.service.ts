import { Injectable, Logger } from '@nestjs/common';
import {
  OciSkuDescriptor,
  OCI_E4_FLEX,
  OCI_A1_FLEX,
  OCI_MYSQL,
  AWS_FAMILY_TO_OCI_SKU,
  AWS_SIZE_TO_VCPU,
  AZURE_FAMILY_TO_OCI_SKU,
  GCP_FAMILY_TO_OCI_SKU,
  DB_ENGINE_TO_OCI_SKU,
} from './instance-sku-map';
import { OciServiceCategory } from '../documents/ingestion.types';

// ──────────────────────────────────────────────────────────────────────────────
// Per-Instance OCI SKU Resolver
//
// Extracts the source instance type from a billing record's productCode /
// productName / rawData, resolves vCPU count, converts to OCPUs, and returns
// the correct OCI Paid SKU + billing quantity so OciCostModelingService can
// compute an accurate cost formula.
//
// Resolution hierarchy (most specific wins):
//   1. instance-level  — exact instance type matched and vCPU count known
//   2. family-level    — instance family matched but vCPU count unknown
//   3. (null)          — caller falls back to category-level CATEGORY_SKU_MAP
// ──────────────────────────────────────────────────────────────────────────────

/** Result returned by resolveForRecord() */
export interface InstanceResolution {
  /** Detected source instance type, e.g. "m5.xlarge" */
  instanceType: string;
  /** Raw vCPU count for the instance (null if only family-level match) */
  vcpuCount: number | null;
  /**
   * OCI OCPU count to use as the billing quantity multiplier.
   * For x86: vcpuCount / 2 (1 OCPU = 2 vCPUs).
   * For ARM: vcpuCount (OCI A1.Flex is native OCPU billing).
   * When vcpuCount is null: 1 (family-level fallback — multiply by usageQuantity directly).
   */
  ocpuCount: number;
  /** OCI paid SKU descriptor (part number, name, unit, fallback price) */
  ociSku: OciSkuDescriptor;
  /** How granular the resolution was — for transparency in formula strings */
  resolutionMethod: 'instance-level' | 'family-level';
}

// ── Regex helpers ─────────────────────────────────────────────────────────────

/**
 * Extracts an AWS-style instance type from a raw string.
 * Handles patterns like:
 *   "BoxUsage:m5.xlarge"          → "m5.xlarge"
 *   "SpotUsage:c5.2xlarge"        → "c5.2xlarge"
 *   "Amazon EC2 - m5.xlarge"      → "m5.xlarge"
 *   "m5.xlarge"                   → "m5.xlarge"
 */
const AWS_INSTANCE_PATTERN =
  /(?:(?:BoxUsage|SpotUsage|HeavyUsage|UnusedBox|DedicatedUsage|InstanceUsage|HostUsage)[:\s]+)?([a-z][a-z0-9]*\.[0-9]*(?:nano|micro|small|medium|large|xlarge|metal[a-z0-9-]*))/i;

/** Extracts Azure ARM SKU name, e.g. "Standard_D4s_v3" */
const AZURE_SKU_PATTERN =
  /\b(Standard_[A-Z][A-Za-z0-9]+_v\d+|Standard_[A-Z][A-Za-z0-9]+)\b/;

/** Extracts a GCP machine type, e.g. "n2-standard-8" */
const GCP_MACHINE_PATTERN =
  /\b([a-z][a-z0-9]*(?:-[a-z]+)*-\d+)\b/i;

/** Extracts the size suffix from an AWS instance type, e.g. "m5.xlarge" → "xlarge" */
const AWS_SIZE_SUFFIX_PATTERN = /\.(\d*(?:nano|micro|small|medium|large|xlarge|metal[a-z0-9-]*))\s*$/i;

@Injectable()
export class InstanceResolverService {
  private readonly logger = new Logger(InstanceResolverService.name);

  // ──────────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Main entry point — resolves OCI SKU and OCPU count for a billing record.
   * Returns null when the record cannot be resolved to a known instance type
   * (caller falls back to category-level CATEGORY_SKU_MAP).
   *
   * @param record - lean UnifiedBilling document from MongoDB
   */
  resolveForRecord(record: {
    provider?: string | null;
    productCode?: string | null;
    productName?: string | null;
    serviceCategory?: string | null;
    rawData?: Record<string, unknown> | null;
  }): InstanceResolution | null {
    const provider = (record.provider ?? '').toLowerCase();
    const productCode = record.productCode ?? '';
    const productName = record.productName ?? '';
    const category = record.serviceCategory ?? '';

    // ── Database resolution (provider-agnostic, runs before compute) ──────────
    if (category === OciServiceCategory.DATABASE) {
      return this.resolveDatabase(productCode, productName);
    }

    // ── Provider-specific compute resolution ───────────────────────────────────
    switch (provider) {
      case 'aws':
        return this.resolveAws(productCode, productName, record.rawData);
      case 'azure':
        return this.resolveAzure(productCode, productName);
      case 'gcp':
        return this.resolveGcp(productCode, productName);
      default:
        // Unknown provider — try generic AWS-style instance type detection
        return this.resolveGenericCompute(productCode, productName);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // AWS Resolution
  // ──────────────────────────────────────────────────────────────────────────

  resolveAws(
    productCode: string,
    productName: string,
    rawData?: Record<string, unknown> | null,
  ): InstanceResolution | null {
    // 1. Try productCode first (most reliable for AWS CUR: "BoxUsage:m5.xlarge")
    let instanceType = this.matchPattern(productCode, AWS_INSTANCE_PATTERN, 1);

    // 2. Try productName: "Amazon EC2 - m5.xlarge"
    if (!instanceType) {
      instanceType = this.matchPattern(productName, AWS_INSTANCE_PATTERN, 1);
    }

    // 3. Try rawData AWS CUR fields
    if (!instanceType && rawData) {
      const curFields = [
        rawData['lineItem/UsageType'],
        rawData['product/instanceType'],
        rawData['usageType'],
        rawData['instanceType'],
      ];
      for (const field of curFields) {
        if (typeof field === 'string') {
          instanceType = this.matchPattern(field, AWS_INSTANCE_PATTERN, 1);
          if (instanceType) break;
        }
      }
    }

    if (!instanceType) return null;

    const isArm = this.isArmInstance(instanceType);
    const sku = this.matchAwsFamily(instanceType);
    if (!sku) return null;

    const vcpuCount = this.extractAwsVcpuCount(instanceType);
    const ocpuCount = this.toOcpuCount(vcpuCount, isArm || sku.isArm);

    return {
      instanceType,
      vcpuCount,
      ocpuCount,
      ociSku: sku,
      resolutionMethod: vcpuCount != null ? 'instance-level' : 'family-level',
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Azure Resolution
  // ──────────────────────────────────────────────────────────────────────────

  resolveAzure(productCode: string, productName: string): InstanceResolution | null {
    const combined = `${productCode} ${productName}`;

    const armSkuName =
      this.matchPattern(productCode, AZURE_SKU_PATTERN, 1) ??
      this.matchPattern(productName, AZURE_SKU_PATTERN, 1) ??
      this.matchPattern(combined, AZURE_SKU_PATTERN, 1);

    if (!armSkuName) return null;

    const sku = this.matchAzureFamily(armSkuName);
    if (!sku) return null;

    const vcpuCount = this.extractAzureVcpuCount(armSkuName);
    const ocpuCount = this.toOcpuCount(vcpuCount, sku.isArm);

    return {
      instanceType: armSkuName,
      vcpuCount,
      ocpuCount,
      ociSku: sku,
      resolutionMethod: vcpuCount != null ? 'instance-level' : 'family-level',
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GCP Resolution
  // ──────────────────────────────────────────────────────────────────────────

  resolveGcp(productCode: string, productName: string): InstanceResolution | null {
    const combined = `${productCode} ${productName}`;

    const machineType =
      this.matchPattern(productCode, GCP_MACHINE_PATTERN, 1) ??
      this.matchPattern(productName, GCP_MACHINE_PATTERN, 1) ??
      this.matchPattern(combined, GCP_MACHINE_PATTERN, 1);

    if (!machineType) return null;

    const sku = this.matchGcpFamily(machineType);
    if (!sku) return null;

    const vcpuCount = this.extractGcpVcpuCount(machineType);
    const ocpuCount = this.toOcpuCount(vcpuCount, sku.isArm);

    return {
      instanceType: machineType,
      vcpuCount,
      ocpuCount,
      ociSku: sku,
      resolutionMethod: vcpuCount != null ? 'instance-level' : 'family-level',
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Database Resolution (provider-agnostic)
  // ──────────────────────────────────────────────────────────────────────────

  resolveDatabase(productCode: string, productName: string): InstanceResolution | null {
    const combined = `${productName} ${productCode}`;

    for (const { pattern, sku } of DB_ENGINE_TO_OCI_SKU) {
      if (pattern.test(combined)) {
        // Try to extract a DB instance class for vCPU count:
        // AWS: "db.m5.large" → 2 vCPU; Azure: "General Purpose, 4 vCores"
        const dbInstanceClass = /\bdb\.[a-z][a-z0-9]*\.[a-z0-9]+\b/i.exec(combined)?.[0];
        const vcoreMatch = /(\d+)\s*v[Cc]ore/i.exec(combined);

        let vcpuCount: number | null = null;
        if (dbInstanceClass) {
          // Extract size suffix from "db.m5.large" → "large"
          const sizeMatch = /\.([^.]+)$/.exec(dbInstanceClass);
          if (sizeMatch) vcpuCount = AWS_SIZE_TO_VCPU[sizeMatch[1].toLowerCase()] ?? null;
        } else if (vcoreMatch) {
          vcpuCount = parseInt(vcoreMatch[1], 10);
        }

        const ocpuCount = vcpuCount != null ? Math.max(1, Math.ceil(vcpuCount / 2)) : 1;

        return {
          instanceType: dbInstanceClass ?? combined.slice(0, 60),
          vcpuCount,
          ocpuCount,
          ociSku: sku,
          resolutionMethod: vcpuCount != null ? 'instance-level' : 'family-level',
        };
      }
    }

    // No DB engine pattern matched — fall back to MySQL as default
    return {
      instanceType: productCode || productName,
      vcpuCount: null,
      ocpuCount: 1,
      ociSku: OCI_MYSQL,
      resolutionMethod: 'family-level',
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Generic (unknown provider) — try AWS pattern as best-effort
  // ──────────────────────────────────────────────────────────────────────────

  private resolveGenericCompute(productCode: string, productName: string): InstanceResolution | null {
    const combined = `${productCode} ${productName}`;
    const instanceType = this.matchPattern(combined, AWS_INSTANCE_PATTERN, 1);
    if (!instanceType) return null;

    const isArm = this.isArmInstance(instanceType);
    const sku = this.matchAwsFamily(instanceType) ?? OCI_E4_FLEX;
    const vcpuCount = this.extractAwsVcpuCount(instanceType);
    const ocpuCount = this.toOcpuCount(vcpuCount, isArm || sku.isArm);

    return {
      instanceType,
      vcpuCount,
      ocpuCount,
      ociSku: sku,
      resolutionMethod: vcpuCount != null ? 'instance-level' : 'family-level',
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // vCPU Extraction
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Extracts vCPU count from an AWS instance type string.
   * Uses the canonical AWS_SIZE_TO_VCPU table keyed by size suffix.
   * Examples: "m5.xlarge" → 4, "c5.2xlarge" → 8, "r5.metal" → 96
   */
  extractAwsVcpuCount(instanceType: string): number | null {
    const sizeMatch = AWS_SIZE_SUFFIX_PATTERN.exec(instanceType.toLowerCase());
    if (!sizeMatch) return null;
    const suffix = sizeMatch[1];
    return AWS_SIZE_TO_VCPU[suffix] ?? null;
  }

  /**
   * Extracts vCPU count from an Azure ARM SKU name.
   * Pattern: Standard_D{n}s_v{ver} → n
   * Examples: "Standard_D4s_v3" → 4, "Standard_E16s_v4" → 16
   */
  extractAzureVcpuCount(armSkuName: string): number | null {
    // Standard_D4s_v3 → 4, Standard_F2s_v2 → 2, Standard_B8ms → 8
    const match = /Standard_[A-Z]+(\d+)/i.exec(armSkuName);
    if (!match) return null;
    const n = parseInt(match[1], 10);
    return isNaN(n) ? null : n;
  }

  /**
   * Extracts vCPU count from a GCP machine type string.
   * Pattern: {family}-{type}-{vcpus}
   * Examples: "n2-standard-8" → 8, "c2-standard-4" → 4, "e2-micro" → 2
   */
  extractGcpVcpuCount(machineType: string): number | null {
    // Micro / small / medium → fixed counts
    if (/e2-micro/i.test(machineType)) return 2;
    if (/e2-small/i.test(machineType)) return 2;
    if (/e2-medium/i.test(machineType)) return 2;

    // Standard pattern: family-type-{n}
    const match = /-(\d+)$/.exec(machineType);
    if (!match) return null;
    const n = parseInt(match[1], 10);
    return isNaN(n) ? null : n;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Family Matching
  // ──────────────────────────────────────────────────────────────────────────

  private matchAwsFamily(instanceType: string): OciSkuDescriptor | null {
    for (const { pattern, sku } of AWS_FAMILY_TO_OCI_SKU) {
      if (pattern.test(instanceType)) return sku;
    }
    return OCI_E4_FLEX; // safe fallback for unknown families
  }

  private matchAzureFamily(armSkuName: string): OciSkuDescriptor | null {
    for (const { pattern, sku } of AZURE_FAMILY_TO_OCI_SKU) {
      if (pattern.test(armSkuName)) return sku;
    }
    return OCI_E4_FLEX;
  }

  private matchGcpFamily(machineType: string): OciSkuDescriptor | null {
    for (const { pattern, sku } of GCP_FAMILY_TO_OCI_SKU) {
      if (pattern.test(machineType)) return sku;
    }
    return OCI_E4_FLEX;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // OCPU Conversion
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Converts vCPU count to OCI OCPU count.
   * Rule (requirements.md): 1 OCI OCPU = 2 AWS vCPUs.
   * ARM instances (OCI A1.Flex) are billed natively per OCPU — no division.
   *
   * When vcpuCount is null (family-level resolution), returns 1 so the
   * quantity multiplier is effectively a pass-through (usageQuantity × 1).
   */
  private toOcpuCount(vcpuCount: number | null, isArm: boolean): number {
    if (vcpuCount == null) return 1;
    if (isArm) return vcpuCount; // A1.Flex: 1 OCPU = 1 ARM vCPU
    return Math.max(1, Math.ceil(vcpuCount / 2));
  }

  /**
   * Detect ARM-based instance types from name alone (before family lookup).
   * This covers cases where the pattern matching hasn't run yet.
   */
  private isArmInstance(instanceType: string): boolean {
    return /\b(graviton|ampere|a1\.|aarch64|arm64|t4g\.|m6g\.|c6g\.|r6g\.|t2a)/i.test(instanceType);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Utility
  // ──────────────────────────────────────────────────────────────────────────

  private matchPattern(input: string, pattern: RegExp, group: number): string | null {
    const match = pattern.exec(input);
    return match ? (match[group] ?? null) : null;
  }

  /**
   * Build a human-readable formula string for audit/transparency.
   * Example: "2 OCPU (m5.xlarge: 4vCPU÷2) × 744h × $0.025 USD/OCPU-h [B88298 VM.Standard.E4.Flex]"
   */
  buildFormula(
    resolution: InstanceResolution,
    usageHours: number,
    unitPrice: number,
    currencyCode: string,
  ): string {
    const ocpuPart = resolution.vcpuCount != null
      ? `${resolution.ocpuCount} OCPU (${resolution.instanceType}: ${resolution.vcpuCount}vCPU${resolution.ociSku.isArm ? '' : '÷2'})`
      : `${resolution.ocpuCount} OCPU (${resolution.instanceType}, family-level)`;

    return (
      `${ocpuPart} × ${usageHours}h × ${unitPrice} ${currencyCode}/OCPU-h` +
      ` [${resolution.ociSku.partNumber} ${resolution.ociSku.instanceFamily}]` +
      ` [${resolution.resolutionMethod}]`
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Per-Instance OCI SKU Mapping Tables
//
// All prices are USD Pay-As-You-Go (PAID SKU default — Free Tier never applied).
// Sources: OCI Public Pricing API / Oracle Cloud Price List 2025
// ──────────────────────────────────────────────────────────────────────────────

/** Canonical OCI SKU descriptor returned by all mapping lookups */
export interface OciSkuDescriptor {
  /** OCI part number — used to fetch live price from Oracle API */
  partNumber: string;
  /** Human-readable SKU name shown in formulas and reports */
  skuName: string;
  /** Billing unit: 'OCPU-hours' | 'GB-month' | 'GB' | 'units' */
  unit: string;
  /** USD fallback price when the OCI API is unavailable */
  fallbackUnitPrice: number;
  /** OCI instance family / shape name (used in formula strings) */
  instanceFamily: string;
  /** True for ARM-native shapes — no vCPU÷2 conversion needed */
  isArm: boolean;
}

// ── OCI Paid Compute SKUs (PAID, Pay-As-You-Go) ───────────────────────────────

/** VM.Standard.E4.Flex — AMD EPYC, General Purpose, $0.025/OCPU-h */
export const OCI_E4_FLEX: OciSkuDescriptor = {
  partNumber: 'B88298',
  skuName: 'VM.Standard.E4.Flex — OCPU per Hour',
  unit: 'OCPU-hours',
  fallbackUnitPrice: 0.025,
  instanceFamily: 'VM.Standard.E4.Flex',
  isArm: false,
};

/** VM.Optimized3.Flex — Intel Xeon, Compute Optimized, $0.054/OCPU-h */
export const OCI_OPT3_FLEX: OciSkuDescriptor = {
  partNumber: 'B89878',
  skuName: 'VM.Optimized3.Flex — OCPU per Hour',
  unit: 'OCPU-hours',
  fallbackUnitPrice: 0.054,
  instanceFamily: 'VM.Optimized3.Flex',
  isArm: false,
};

/** VM.Standard.A1.Flex — Ampere ARM, $0.01/OCPU-h */
export const OCI_A1_FLEX: OciSkuDescriptor = {
  partNumber: 'B94073',
  skuName: 'VM.Standard.A1.Flex — OCPU per Hour',
  unit: 'OCPU-hours',
  fallbackUnitPrice: 0.01,
  instanceFamily: 'VM.Standard.A1.Flex',
  isArm: true,
};

// ── OCI Paid Database SKUs ────────────────────────────────────────────────────

/** MySQL HeatWave / MySQL Database Service, $0.0544/OCPU-h */
export const OCI_MYSQL: OciSkuDescriptor = {
  partNumber: 'B89021',
  skuName: 'MySQL Database Service — OCPU per Hour',
  unit: 'OCPU-hours',
  fallbackUnitPrice: 0.0544,
  instanceFamily: 'MySQL Database Service',
  isArm: false,
};

/** PostgreSQL Database Service, $0.0544/OCPU-h */
export const OCI_POSTGRESQL: OciSkuDescriptor = {
  partNumber: 'B91399',
  skuName: 'PostgreSQL Database Service — OCPU per Hour',
  unit: 'OCPU-hours',
  fallbackUnitPrice: 0.0544,
  instanceFamily: 'PostgreSQL Database Service',
  isArm: false,
};

/** SQL Server Standard License + Windows Server (combined), $0.37/OCPU-h */
export const OCI_SQL_SERVER_STANDARD: OciSkuDescriptor = {
  partNumber: 'B91600',
  skuName: 'SQL Server Standard License — OCPU per Hour',
  unit: 'OCPU-hours',
  fallbackUnitPrice: 0.37,
  instanceFamily: 'SQL Server Standard',
  isArm: false,
};

/** Oracle Database Standard Edition 2, $0.2188/OCPU-h */
export const OCI_ORACLE_DB_SE2: OciSkuDescriptor = {
  partNumber: 'B87905',
  skuName: 'Oracle Database Standard Edition 2 — OCPU per Hour',
  unit: 'OCPU-hours',
  fallbackUnitPrice: 0.2188,
  instanceFamily: 'Oracle Database SE2',
  isArm: false,
};

// ──────────────────────────────────────────────────────────────────────────────
// AWS Instance Family → OCI SKU
//
// Mapping rule: match the first character(s) of the instance family prefix
// (the part before the generation number, e.g. "m" from "m5", "c" from "c6i").
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Maps AWS instance family letter prefix(es) to the best-matching OCI compute SKU.
 *
 * Key = lowercase family prefix (regex-safe, no numbers).
 * Order matters — more specific prefixes first.
 */
export const AWS_FAMILY_TO_OCI_SKU: Array<{ pattern: RegExp; sku: OciSkuDescriptor }> = [
  // ── ARM / Graviton ──────────────────────────────────────────────────────────
  { pattern: /^(a1|t4g|m6g|m7g|c6g|c7g|r6g|r7g|g\d+g|inf\d+|trn\d+)/i, sku: OCI_A1_FLEX },

  // ── Compute Optimized ──────────────────────────────────────────────────────
  { pattern: /^(c\d|hpc\d)/i, sku: OCI_OPT3_FLEX },

  // ── General / Memory / Storage / GPU / Accelerated ────────────────────────
  // (t-burstable, m-general, r-memory, x-high-memory, i-storage, d-dense,
  //  f-FPGA, g-GPU, p-ML-GPU, inf-Inferentia, trn-Trainium → E4.Flex fallback)
  { pattern: /^(t|m|r|x|z|i|d|f|g|p|vt|dl|im|is|u)/i, sku: OCI_E4_FLEX },
];

// ──────────────────────────────────────────────────────────────────────────────
// AWS Instance Size Suffix → vCPU Count
//
// Based on AWS documentation: https://aws.amazon.com/ec2/instance-types/
// These counts apply to the majority of families. ARM families use the same
// size naming convention.
// ──────────────────────────────────────────────────────────────────────────────
export const AWS_SIZE_TO_VCPU: Record<string, number> = {
  nano:      2,
  micro:     2,
  small:     2,
  medium:    2,
  large:     2,
  xlarge:    4,
  '2xlarge':  8,
  '3xlarge':  12,
  '4xlarge':  16,
  '6xlarge':  24,
  '8xlarge':  32,
  '9xlarge':  36,
  '10xlarge': 40,
  '12xlarge': 48,
  '16xlarge': 64,
  '18xlarge': 72,
  '24xlarge': 96,
  '32xlarge': 128,
  '48xlarge': 192,
  '56xlarge': 224,
  '96xlarge': 384,
  // Metal variants (bare metal — vCPU count varies, use largest standard as baseline)
  'metal':       96,
  'metal-24xl':  96,
  'metal-32xl': 128,
  'metal-48xl': 192,
};

// ──────────────────────────────────────────────────────────────────────────────
// Azure ARM SKU Family → OCI SKU
//
// Pattern matches the shape prefix before the core count number.
// e.g. "Standard_D4s_v3" → prefix "D" → General Purpose → E4.Flex
// ──────────────────────────────────────────────────────────────────────────────
export const AZURE_FAMILY_TO_OCI_SKU: Array<{ pattern: RegExp; sku: OciSkuDescriptor }> = [
  // ── Compute Optimized ──────────────────────────────────────────────────────
  { pattern: /^Standard_F/i, sku: OCI_OPT3_FLEX },

  // ── ARM (Ampere Altra) ─────────────────────────────────────────────────────
  { pattern: /^Standard_D(\d+)p/i, sku: OCI_A1_FLEX },
  { pattern: /^Standard_E(\d+)p/i, sku: OCI_A1_FLEX },

  // ── General Purpose / Memory / Burstable / Storage ────────────────────────
  { pattern: /^Standard_(D|E|B|A|L|M|N|H|G|ND|NC|NV|DC|Eb|Ep|Db|Dp|Lsv|Msv|Mv)/i, sku: OCI_E4_FLEX },
];

// ──────────────────────────────────────────────────────────────────────────────
// GCP Machine Family → OCI SKU
//
// GCP machine type format: {family}-{type}-{vcpus}
// e.g. "n2-standard-8", "c2-standard-4", "t2a-standard-1"
// ──────────────────────────────────────────────────────────────────────────────
export const GCP_FAMILY_TO_OCI_SKU: Array<{ pattern: RegExp; sku: OciSkuDescriptor }> = [
  // ── ARM (Ampere) ───────────────────────────────────────────────────────────
  { pattern: /^t2a/i, sku: OCI_A1_FLEX },

  // ── Compute Optimized ──────────────────────────────────────────────────────
  { pattern: /^(c2|c2d|c3|h3|n2-highcpu)/i, sku: OCI_OPT3_FLEX },

  // ── General / Memory / Storage ────────────────────────────────────────────
  { pattern: /^(n1|n2|n4|e2|m1|m2|m3|a2|g2|t2d)/i, sku: OCI_E4_FLEX },
];

// ──────────────────────────────────────────────────────────────────────────────
// Database Engine → OCI Database SKU
//
// Matched against productName / productCode (case-insensitive).
// ──────────────────────────────────────────────────────────────────────────────
export const DB_ENGINE_TO_OCI_SKU: Array<{ pattern: RegExp; sku: OciSkuDescriptor }> = [
  // SQL Server Standard (takes priority — has special combined pricing)
  { pattern: /sql[\s_-]?server[\s_-]?standard|sqlstd|mssql.?std/i,         sku: OCI_SQL_SERVER_STANDARD },

  // Oracle Database
  { pattern: /\boracle[\s_-]?db|oracle[\s_-]?database|oracle.?standard/i,  sku: OCI_ORACLE_DB_SE2 },

  // PostgreSQL
  { pattern: /postgres|pgsql|aurora[\s_-]?postgres/i,                       sku: OCI_POSTGRESQL },

  // MySQL / Aurora MySQL / MariaDB (MariaDB → MySQL as closest OCI equivalent)
  { pattern: /mysql|mariadb|aurora[\s_-]?mysql|aurora(?!.*postgres)/i,      sku: OCI_MYSQL },

  // Fallback for other DB engines (DynamoDB, Redis, Cassandra, etc.)
  { pattern: /dynamo|redis|elasticache|cosmos|cassandra|mongo|docdb|neptune|bigtable|spanner|firestore/i, sku: OCI_MYSQL },
];

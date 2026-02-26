import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { CloudProvider } from '../ingestion.types';

/** Which cloud storage backend to pull billing files from */
export enum StorageBackend {
  AWS_S3 = 'aws-s3',
  OCI_OBJECT_STORAGE = 'oci-object-storage',
}

export class CollectBillingDto {
  /**
   * Force a specific storage backend.
   * If omitted the CollectorService auto-detects based on which env vars are present.
   *   AWS S3  → FINOPS_ACCESS_KEY_ID + FINOPS_SECRET_ACCESS_KEY + FINOPS_S3_BUCKET
   *   OCI OS  → FINOPS_OCI_NAMESPACE + FINOPS_OCI_BUCKET + OCI_* auth vars
   */
  @IsOptional()
  @IsEnum(StorageBackend)
  backend?: StorageBackend;

  /**
   * Override the cloud provider detected from file content.
   * Useful when the file name does not contain a recognisable provider token.
   */
  @IsOptional()
  @IsEnum(CloudProvider)
  providerHint?: CloudProvider;

  /**
   * Object key prefix to filter files in the bucket.
   * Example: "billing/2025/" or "CUR/my-report/"
   */
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  prefix?: string;

  /**
   * When true, only list available billing files and return metadata.
   * Nothing is downloaded, parsed, or persisted.
   */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  dryRun?: boolean;
}

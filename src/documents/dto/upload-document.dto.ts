import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { CloudProvider } from '../ingestion.types';

export class UploadDocumentDto {
  /**
   * Optional hint to force a specific cloud provider instead of auto-detecting.
   * Useful when the file name/columns do not clearly identify the source.
   */
  @IsOptional()
  @IsEnum(CloudProvider, {
    message: `providerHint must be one of: ${Object.values(CloudProvider).join(', ')}`,
  })
  providerHint?: CloudProvider;

  /**
   * Optional human-readable label for this upload batch.
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  label?: string;
}

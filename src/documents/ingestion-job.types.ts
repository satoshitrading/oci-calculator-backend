import type { PdfExtractor } from './parser-factory.service';

/** Payload for `upload` jobs — file already on disk at `absolutePath` (not stored in Redis). */
export interface UploadIngestionJobData {
  uploadId: string;
  absolutePath: string;
  originalName: string;
  mimeType: string;
  dto: { providerHint?: string; label?: string };
  extractor: PdfExtractor;
}

/** Payload for `collect` jobs — worker runs the collector + parse pipeline. */
export interface CollectIngestionJobData {
  uploadId: string;
  dto: {
    backend?: string;
    providerHint?: string;
    prefix?: string;
    dryRun?: boolean;
  };
}

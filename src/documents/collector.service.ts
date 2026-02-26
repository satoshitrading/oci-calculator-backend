import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Readable } from 'stream';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import axios from 'axios';
import {
  buildOciSignedHeaders,
  isOciConfigured,
  loadOciSigningConfig,
} from '../utils/oci-signing.util';
import { CollectBillingDto, StorageBackend } from './dto/collect-billing.dto';

// ---------------------------------------------------------------------------
// Environment variables
//
// AWS S3:
//   FINOPS_ACCESS_KEY_ID      – AWS Access Key ID
//   FINOPS_SECRET_ACCESS_KEY  – AWS Secret Access Key
//   FINOPS_S3_BUCKET          – S3 bucket name
//   FINOPS_S3_REGION          – AWS region (default: us-east-1)
//   FINOPS_S3_PREFIX          – optional object key prefix
//
// OCI Object Storage:
//   FINOPS_OCI_NAMESPACE      – OCI Object Storage namespace
//   FINOPS_OCI_BUCKET         – OCI bucket name
//   FINOPS_OCI_PREFIX         – optional object name prefix
//   OCI_TENANCY_OCID / OCI_USER_OCID / OCI_FINGERPRINT /
//   OCI_PRIVATE_KEY / OCI_REGION   – standard OCI auth vars (shared with Document AI)
// ---------------------------------------------------------------------------

const BILLING_EXTENSIONS = /\.(csv|xlsx)$/i;

export interface RemoteBillingFile {
  key: string;
  lastModified: Date;
  sizeBytes: number;
  backend: StorageBackend;
  bucket: string;
}

export interface FetchedBillingFile extends RemoteBillingFile {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
}

@Injectable()
export class CollectorService {
  private readonly logger = new Logger(CollectorService.name);

  // ---------------------------------------------------------------------------
  // Backend auto-detection & availability
  // ---------------------------------------------------------------------------

  detectBackend(hint?: StorageBackend): StorageBackend {
    if (hint) return hint;
    if (this.isS3Configured()) return StorageBackend.AWS_S3;
    if (this.isOciOsConfigured()) return StorageBackend.OCI_OBJECT_STORAGE;
    throw new ServiceUnavailableException(
      'No cloud storage backend configured. ' +
        'Set FINOPS_ACCESS_KEY_ID + FINOPS_SECRET_ACCESS_KEY + FINOPS_S3_BUCKET for S3, ' +
        'or FINOPS_OCI_NAMESPACE + FINOPS_OCI_BUCKET + OCI_* auth vars for OCI Object Storage.',
    );
  }

  isS3Configured(): boolean {
    return !!(
      process.env.FINOPS_ACCESS_KEY_ID &&
      process.env.FINOPS_SECRET_ACCESS_KEY &&
      process.env.FINOPS_S3_BUCKET
    );
  }

  isOciOsConfigured(): boolean {
    return !!(
      isOciConfigured() &&
      process.env.FINOPS_OCI_NAMESPACE &&
      process.env.FINOPS_OCI_BUCKET
    );
  }

  // ---------------------------------------------------------------------------
  // List available billing files (used for dry-run)
  // ---------------------------------------------------------------------------

  async listBillingFiles(dto: CollectBillingDto): Promise<RemoteBillingFile[]> {
    const backend = this.detectBackend(dto.backend);
    this.logger.log(`Listing billing files on ${backend}`);

    return backend === StorageBackend.AWS_S3
      ? this.listS3(dto.prefix)
      : this.listOciOs(dto.prefix);
  }

  // ---------------------------------------------------------------------------
  // Fetch the most-recently modified billing CSV/XLSX
  // ---------------------------------------------------------------------------

  async fetchLatestBillingFile(dto: CollectBillingDto): Promise<FetchedBillingFile> {
    const files = await this.listBillingFiles(dto);

    if (files.length === 0) {
      throw new ServiceUnavailableException(
        'No billing CSV or XLSX files found in the configured bucket.',
      );
    }

    const latest = files.sort(
      (a, b) => b.lastModified.getTime() - a.lastModified.getTime(),
    )[0]!;

    this.logger.log(
      `Fetching latest billing file: "${latest.key}" (${latest.backend}, ` +
        `${(latest.sizeBytes / 1024).toFixed(1)} KB, modified ${latest.lastModified.toISOString()})`,
    );

    const buffer =
      latest.backend === StorageBackend.AWS_S3
        ? await this.downloadS3(latest.key)
        : await this.downloadOciOs(latest.key);

    const fileName = latest.key.split('/').pop() ?? latest.key;
    const mimeType = /\.xlsx$/i.test(fileName)
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'text/csv';

    return { ...latest, buffer, fileName, mimeType };
  }

  // ---------------------------------------------------------------------------
  // AWS S3 – list
  // ---------------------------------------------------------------------------

  private async listS3(prefixOverride?: string): Promise<RemoteBillingFile[]> {
    const client = this.buildS3Client();
    const bucket = process.env.FINOPS_S3_BUCKET!;
    const prefix = prefixOverride ?? process.env.FINOPS_S3_PREFIX ?? '';

    const files: RemoteBillingFile[] = [];
    let continuationToken: string | undefined;

    do {
      const cmd = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });

      const resp: ListObjectsV2CommandOutput = await client.send(cmd);

      for (const obj of resp.Contents ?? []) {
        if (!obj.Key || !BILLING_EXTENSIONS.test(obj.Key)) continue;
        files.push({
          key: obj.Key,
          lastModified: obj.LastModified ?? new Date(0),
          sizeBytes: obj.Size ?? 0,
          backend: StorageBackend.AWS_S3,
          bucket,
        });
      }

      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);

    this.logger.debug(`S3 list: found ${files.length} billing files in s3://${bucket}/${prefix}`);
    return files;
  }

  // ---------------------------------------------------------------------------
  // AWS S3 – download
  // ---------------------------------------------------------------------------

  private async downloadS3(key: string): Promise<Buffer> {
    const client = this.buildS3Client();
    const resp = await client.send(
      new GetObjectCommand({ Bucket: process.env.FINOPS_S3_BUCKET!, Key: key }),
    );

    if (!resp.Body) throw new Error(`S3 returned empty body for key: ${key}`);
    return this.streamToBuffer(resp.Body as Readable);
  }

  private buildS3Client(): S3Client {
    return new S3Client({
      region: process.env.FINOPS_S3_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.FINOPS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.FINOPS_SECRET_ACCESS_KEY!,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // OCI Object Storage – list
  // Ref: https://docs.oracle.com/en-us/iaas/api/#/en/objectstorage/latest/Object/ListObjects
  // ---------------------------------------------------------------------------

  private async listOciOs(prefixOverride?: string): Promise<RemoteBillingFile[]> {
    const config = loadOciSigningConfig();
    const namespace = process.env.FINOPS_OCI_NAMESPACE!;
    const bucket = process.env.FINOPS_OCI_BUCKET!;
    const prefix = prefixOverride ?? process.env.FINOPS_OCI_PREFIX ?? '';
    const host = `objectstorage.${config.region}.oraclecloud.com`;
    const files: RemoteBillingFile[] = [];
    let start: string | undefined;

    do {
      const params = new URLSearchParams({ fields: 'name,size,timeModified', limit: '1000' });
      if (prefix) params.set('prefix', prefix);
      if (start) params.set('start', start);

      const path = `/n/${encodeURIComponent(namespace)}/b/${encodeURIComponent(bucket)}/o?${params.toString()}`;
      const headers = buildOciSignedHeaders('GET', host, path, null, config);

      const resp = await axios.get<{
        objects?: Array<{ name: string; size: number; timeModified: string }>;
        nextStartWith?: string;
      }>(`https://${host}${path}`, { headers });

      for (const obj of resp.data.objects ?? []) {
        if (!obj.name || !BILLING_EXTENSIONS.test(obj.name)) continue;
        files.push({
          key: obj.name,
          lastModified: new Date(obj.timeModified),
          sizeBytes: obj.size ?? 0,
          backend: StorageBackend.OCI_OBJECT_STORAGE,
          bucket,
        });
      }

      start = resp.data.nextStartWith;
    } while (start);

    this.logger.debug(
      `OCI OS list: found ${files.length} billing files in oci://${namespace}/${bucket}/${prefix}`,
    );
    return files;
  }

  // ---------------------------------------------------------------------------
  // OCI Object Storage – download
  // ---------------------------------------------------------------------------

  private async downloadOciOs(objectName: string): Promise<Buffer> {
    const config = loadOciSigningConfig();
    const namespace = process.env.FINOPS_OCI_NAMESPACE!;
    const bucket = process.env.FINOPS_OCI_BUCKET!;
    const host = `objectstorage.${config.region}.oraclecloud.com`;
    const path = `/n/${encodeURIComponent(namespace)}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`;

    const headers = buildOciSignedHeaders('GET', host, path, null, config);
    const resp = await axios.get<ArrayBuffer>(`https://${host}${path}`, {
      headers,
      responseType: 'arraybuffer',
    });

    return Buffer.from(resp.data);
  }

  // ---------------------------------------------------------------------------
  // Stream utility
  // ---------------------------------------------------------------------------

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
    }
    return Buffer.concat(chunks);
  }
}

import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DocumentIngestionService } from './document-ingestion.service';
import { DOCUMENT_INGESTION_QUEUE } from './ingestion-queue.constants';
import type { CollectIngestionJobData, UploadIngestionJobData } from './ingestion-job.types';

@Processor(DOCUMENT_INGESTION_QUEUE, { concurrency: 1 })
export class DocumentIngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(DocumentIngestionProcessor.name);

  constructor(private readonly ingestion: DocumentIngestionService) {
    super();
  }

  async process(job: Job<UploadIngestionJobData | CollectIngestionJobData, unknown, string>): Promise<void> {
    if (job.name === 'upload') {
      await this.ingestion.processQueuedUpload(job.data as UploadIngestionJobData);
      return;
    }
    if (job.name === 'collect') {
      await this.ingestion.processQueuedCollect(job.data as CollectIngestionJobData);
      return;
    }
    throw new Error(`Unknown ingestion job name: ${job.name}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    const id = job?.id ?? '?';
    this.logger.warn(`Job ${id} failed: ${err.message}`);
  }
}

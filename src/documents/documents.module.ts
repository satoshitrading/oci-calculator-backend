import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { DocumentUpload, DocumentUploadSchema } from '../database/schemas/document-upload.schema';
import { DocumentLineItem, DocumentLineItemSchema } from '../database/schemas/document-line-item.schema';
import { UnifiedBilling, UnifiedBillingSchema } from '../database/schemas/unified-billing.schema';
import { OciCostModeling, OciCostModelingSchema } from '../database/schemas/oci-cost-modeling.schema';
import { DocumentsController } from './documents.controller';
import { DocumentIngestionService } from './document-ingestion.service';
import { CsvExtractorService } from './csv-extractor.service';
import { PdfExtractorService } from './pdf-extractor.service';
import { OcrService } from './ocr.service';
import { XlsxExtractorService } from './xlsx-extractor.service';
import { ProviderDetectionService } from './provider-detection.service';
import { CostSummaryService } from './cost-summary.service';
import { NormalizationService } from './normalization.service';
import { ParserFactory } from './parser-factory.service';
import { TextractService } from './textract.service';
import { GeminiService } from './gemini.service';
import { CollectorService } from './collector.service';
import { OciSkuMappingsModule } from '../oci-sku-mappings/oci-sku-mappings.module';
import { OciSkuResolutionService } from './oci-sku-resolution.service';
import { DOCUMENT_INGESTION_QUEUE } from './ingestion-queue.constants';
import { DocumentIngestionProcessor } from './document-ingestion.processor';

const ingestionRedisUrl = process.env.REDIS_URL?.trim();
const ingestionQueueModules =
  ingestionRedisUrl && ingestionRedisUrl.length > 0
    ? [
        BullModule.forRoot({
          connection: { url: ingestionRedisUrl },
        }),
        BullModule.registerQueue({
          name: DOCUMENT_INGESTION_QUEUE,
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 10_000 },
            removeOnComplete: 200,
            removeOnFail: 100,
          },
        }),
      ]
    : [];

@Module({
  imports: [
    OciSkuMappingsModule,
    ...ingestionQueueModules,
    MongooseModule.forFeature([
      { name: DocumentUpload.name, schema: DocumentUploadSchema },
      { name: DocumentLineItem.name, schema: DocumentLineItemSchema },
      { name: UnifiedBilling.name, schema: UnifiedBillingSchema },
      { name: OciCostModeling.name, schema: OciCostModelingSchema },
    ]),
  ],
  controllers: [DocumentsController],
  providers: [
    // Core ingestion orchestrator (only entry point for the controller)
    DocumentIngestionService,
    ...(ingestionRedisUrl && ingestionRedisUrl.length > 0 ? [DocumentIngestionProcessor] : []),

    // Phase 1 – new services
    ParserFactory,
    NormalizationService,
    TextractService,
    GeminiService,
    CollectorService,

    // Extractors (used by ParserFactory)
    CsvExtractorService,
    PdfExtractorService,
    XlsxExtractorService,
    OcrService,

    // Supporting services
    ProviderDetectionService,
    CostSummaryService,
    OciSkuResolutionService,
  ],
  exports: [DocumentIngestionService],
})
export class DocumentsModule {}

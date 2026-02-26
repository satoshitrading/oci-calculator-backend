import { Module } from '@nestjs/common';
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

@Module({
  imports: [
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
  ],
  exports: [DocumentIngestionService],
})
export class DocumentsModule {}

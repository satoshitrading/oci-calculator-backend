import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentIngestionService } from './document-ingestion.service';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { CollectBillingDto } from './dto/collect-billing.dto';

/**
 * DocumentsController exposes the ingestion endpoints.
 * It delegates all processing to DocumentIngestionService —
 * no business logic lives in the controller.
 */
@Controller('api')
export class DocumentsController {
  constructor(private readonly ingestionService: DocumentIngestionService) {}

  /**
   * POST /api/documents/upload
   *
   * Accepts a multipart/form-data request with:
   *   - file       (required) – PDF invoice, CSV billing export, or XLSX workbook
   *   - providerHint (optional) – aws | azure | gcp | oci | unknown
   *   - label       (optional) – human-readable batch label
   *
   * Returns a DocumentUploadResult with unified billing line items and cost summary.
   */
  @Post('documents/upload')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadDocumentDto,
  ) {
    if (!file) {
      throw new BadRequestException(
        'No file provided. Send a multipart/form-data request with field name "file".',
      );
    }
    return this.ingestionService.processFile(file, dto);
  }

  /**
   * POST /api/documents/upload/textract
   *
   * Same as /upload but forces Amazon Textract for PDF extraction.
   * Returns 400 if TEXTRACT_ACCESS_KEY_ID / SECRET_ACCESS_KEY / REGION are not set.
   *
   * Accepts the same multipart/form-data fields as /upload.
   */
  @Post('documents/upload/textract')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async uploadWithTextract(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadDocumentDto,
  ) {
    if (!file) {
      throw new BadRequestException(
        'No file provided. Send a multipart/form-data request with field name "file".',
      );
    }
    return this.ingestionService.processFile(file, dto, 'textract');
  }

  /**
   * POST /api/documents/upload/gemini
   *
   * Same as /upload but forces Gemini AI for PDF extraction.
   * Returns 400 if GEMINI_API_KEY is not set.
   *
   * Accepts the same multipart/form-data fields as /upload.
   */
  @Post('documents/upload/gemini')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async uploadWithGemini(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadDocumentDto,
  ) {
    if (!file) {
      throw new BadRequestException(
        'No file provided. Send a multipart/form-data request with field name "file".',
      );
    }
    return this.ingestionService.processFile(file, dto, 'gemini');
  }

  /**
   * POST /api/documents/collect
   *
   * Automatically retrieves the most recent billing CSV/XLSX from cloud storage
   * (AWS S3 or OCI Object Storage), pipes it into ParserFactory, applies all
   * mandatory OCI FinOps normalization rules, and persists the result.
   *
   * Request body (all fields optional):
   *   backend      – 'aws-s3' | 'oci-object-storage'  (auto-detected from env vars)
   *   providerHint – 'aws' | 'azure' | 'gcp' | 'oci'  (overrides auto-detection)
   *   prefix       – object key prefix filter (e.g. "billing/2025/")
   *   dryRun       – true → list files only, nothing is downloaded or persisted
   *
   * Required env vars:
   *   AWS S3:  FINOPS_ACCESS_KEY_ID, FINOPS_SECRET_ACCESS_KEY, FINOPS_S3_BUCKET
   *   OCI OS:  FINOPS_OCI_NAMESPACE, FINOPS_OCI_BUCKET, OCI_TENANCY_OCID, OCI_USER_OCID,
   *            OCI_FINGERPRINT, OCI_PRIVATE_KEY, OCI_REGION
   */
  @Post('documents/collect')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async collect(@Body() dto: CollectBillingDto) {
    return this.ingestionService.processFromCollector(dto);
  }

  /**
   * GET /api/documents
   *
   * Returns a paginated list of all document uploads with item counts.
   * Query params: page (default 1), limit (default 20, max 100)
   */
  @Get('documents')
  async list(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const p = page ? Math.max(1, parseInt(page, 10)) : 1;
    const l = limit ? Math.min(100, Math.max(1, parseInt(limit, 10))) : 20;
    return this.ingestionService.listUploads(
      Number.isNaN(p) ? 1 : p,
      Number.isNaN(l) ? 20 : l,
    );
  }

  /**
   * GET /api/documents/:uploadId
   *
   * Retrieves a previously processed document upload with its line items and cost summary.
   */
  @Get('documents/:uploadId')
  async getByUploadId(@Param('uploadId') uploadId: string) {
    const result = await this.ingestionService.getByUploadId(uploadId);
    if (!result) {
      throw new NotFoundException(`Document upload "${uploadId}" not found`);
    }
    return result;
  }

  /**
   * DELETE /api/documents/:uploadId
   *
   * Permanently deletes an upload and all associated records:
   * DocumentUpload, DocumentLineItem, UnifiedBilling, OciCostModeling.
   */
  @Delete('documents/:uploadId')
  async deleteUpload(@Param('uploadId') uploadId: string) {
    return this.ingestionService.deleteUpload(uploadId);
  }
}

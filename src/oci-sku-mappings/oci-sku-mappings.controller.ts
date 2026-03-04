import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Body,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OciSkuMappingsService } from './oci-sku-mappings.service';

@Controller('api')
export class OciSkuMappingsController {
  constructor(private readonly service: OciSkuMappingsService) {}

  /**
   * GET /api/oci-sku-mappings
   *
   * Returns all stored OCI mappings (product name → part number) for the Quotations page.
   */
  @Get('oci-sku-mappings')
  async list() {
    return this.service.list();
  }

  /**
   * POST /api/oci-sku-mappings
   *
   * Create one mapping. Body: { partNumber, productTitle, serviceCategory?, unit?, fallbackUnitPrice? }.
   */
  @Post('oci-sku-mappings')
  async create(
    @Body()
    body: {
      partNumber?: string;
      productTitle?: string;
      serviceCategory?: string | null;
      skuName?: string | null;
      unit?: string;
      fallbackUnitPrice?: number | null;
    },
  ) {
    return this.service.create(body);
  }

  /**
   * PATCH /api/oci-sku-mappings/:id
   *
   * Update one mapping. Body: optional partNumber, productTitle, serviceCategory, unit, fallbackUnitPrice.
   */
  @Patch('oci-sku-mappings/:id')
  async update(
    @Param('id') id: string,
    @Body()
    body: Partial<{
      partNumber: string;
      productTitle: string;
      serviceCategory: string | null;
      skuName: string | null;
      unit: string;
      fallbackUnitPrice: number | null;
    }>,
  ) {
    return this.service.update(id, body);
  }

  /**
   * DELETE /api/oci-sku-mappings/:id
   *
   * Delete one mapping by id.
   */
  @Delete('oci-sku-mappings/:id')
  async delete(@Param('id') id: string) {
    await this.service.delete(id);
  }

  /**
   * POST /api/oci-sku-mappings/import
   *
   * Accepts a CSV file (multipart/form-data, field name "file").
   * CSV is defined with columns: OCI SKU, OCI Product name.
   * Optional: serviceCategory, unit, fallbackUnitPrice.
   * Replaces all existing mappings with the CSV contents.
   */
  @Post('oci-sku-mappings/import')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
    }),
  )
  async import(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException(
        'No file provided. Send multipart/form-data with field name "file".',
      );
    }
    const raw = file.buffer;
    const buffer =
      raw == null
        ? Buffer.alloc(0)
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(new Uint8Array(raw as ArrayBuffer));
    if (buffer.length === 0) {
      throw new BadRequestException('File content is required.');
    }
    return this.service.importFromCsv(buffer);
  }
}

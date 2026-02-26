import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { OciCostModelingRepository } from './oci-cost-modeling.repository';
import { OciCostModelingService } from './oci-cost-modeling.service';

interface ModelRequestBody {
  uploadId?: string;
  currencyCode?: string;
}

@Controller('api')
export class OciCostModelingController {
  constructor(
    private readonly repo: OciCostModelingRepository,
    private readonly modelingService: OciCostModelingService,
  ) {}

  /**
   * GET /api/oci-cost-modeling
   *
   * Legacy endpoint — returns raw records from oci_cost_modeling collection.
   */
  @Get('oci-cost-modeling')
  async list(@Query('limit') limit?: string) {
    const n = limit ? parseInt(limit, 10) : 500;
    return this.repo.list(Number.isNaN(n) ? 500 : n);
  }

  /**
   * GET /api/oci-cost-modeling/:uploadId
   *
   * Returns the lift-and-shift comparison for a previously modeled upload.
   * Returns 404 if the upload has not been modeled yet (use POST /model to trigger).
   */
  @Get('oci-cost-modeling/:uploadId')
  async getByUploadId(
    @Param('uploadId') uploadId: string,
    @Query('currencyCode') currencyCode?: string,
  ) {
    const result = await this.modelingService.getByUploadId(
      uploadId,
      currencyCode ?? 'USD',
    );
    if (!result) {
      throw new NotFoundException(
        `No modeling results found for upload "${uploadId}". ` +
          `POST /api/oci-cost-modeling/model with { "uploadId": "${uploadId}" } to run modeling first.`,
      );
    }
    return result;
  }

  /**
   * POST /api/oci-cost-modeling/model
   *
   * Triggers (or re-triggers) the OCI lift-and-shift cost modeling for a given uploadId.
   * Deletes any existing modeling records for that upload, then recomputes.
   *
   * Body: { uploadId: string, currencyCode?: string }
   */
  @Post('oci-cost-modeling/model')
  async runModel(@Body() body: ModelRequestBody) {
    const { uploadId, currencyCode } = body ?? {};
    if (!uploadId?.trim()) {
      throw new NotFoundException('uploadId is required in the request body');
    }
    return this.modelingService.model(uploadId.trim(), currencyCode ?? 'USD');
  }
}

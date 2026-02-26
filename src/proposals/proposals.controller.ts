import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Res,
  Header,
} from '@nestjs/common';
import type { Response } from 'express';
import { ProposalService } from './proposal.service';
import { CalculationResult } from '../calculate/calculation.service';
import { LiftAndShiftResult } from '../oci-cost-modeling/oci-cost-modeling.service';

interface ProposalBody {
  customerName?: string;
  projectName?: string;
  calculationResult?: CalculationResult;
}

interface MigrationProposalBody {
  customerName?: string;
  projectName?: string;
  modelingResult?: LiftAndShiftResult;
}

@Controller('api/proposals')
export class ProposalsController {
  constructor(private readonly proposalService: ProposalService) {}

  @Post('pdf')
  @Header('Content-Type', 'application/pdf')
  async pdf(@Body() body: ProposalBody, @Res() res: Response): Promise<void> {
    const { customerName, projectName, calculationResult } = body ?? {};
    if (!calculationResult?.lineItems) {
      throw new BadRequestException(
        'calculationResult with lineItems is required',
      );
    }
    const pdfBuffer = await this.proposalService.generatePdfProposal({
      customerName,
      projectName,
      calculationResult,
    });
    const filename = (projectName ?? 'oci-proposal').replace(/[^a-z0-9_-]/gi, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    res.send(pdfBuffer);
  }

  @Post('excel')
  async excel(@Body() body: ProposalBody, @Res() res: Response): Promise<void> {
    const { customerName, projectName, calculationResult } = body ?? {};
    if (!calculationResult?.lineItems) {
      throw new BadRequestException(
        'calculationResult with lineItems is required',
      );
    }
    const { buffer, mimeType, extension } =
      await this.proposalService.generateExcelProposal({
        customerName,
        projectName,
        calculationResult,
      });
    const filename = (projectName ?? 'oci-proposal').replace(/[^a-z0-9_-]/gi, '_');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.${extension}"`);
    res.send(buffer);
  }

  /**
   * POST /api/proposals/migration-pdf
   *
   * Generates a PDF migration proposal from an OCI lift-and-shift modeling result.
   * Body: { customerName?, projectName?, modelingResult: LiftAndShiftResult }
   */
  @Post('migration-pdf')
  @Header('Content-Type', 'application/pdf')
  async migrationPdf(
    @Body() body: MigrationProposalBody,
    @Res() res: Response,
  ): Promise<void> {
    const { customerName, projectName, modelingResult } = body ?? {};
    if (!modelingResult?.uploadId) {
      throw new BadRequestException('modelingResult with uploadId is required');
    }
    const pdfBuffer = await this.proposalService.generateMigrationPdf({
      customerName,
      projectName,
      modelingResult,
    });
    const filename = (projectName ?? 'oci-migration-proposal').replace(/[^a-z0-9_-]/gi, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    res.send(pdfBuffer);
  }

  /**
   * POST /api/proposals/migration-excel
   *
   * Generates an Excel migration proposal from an OCI lift-and-shift modeling result.
   * Body: { customerName?, projectName?, modelingResult: LiftAndShiftResult }
   */
  @Post('migration-excel')
  async migrationExcel(
    @Body() body: MigrationProposalBody,
    @Res() res: Response,
  ): Promise<void> {
    const { customerName, projectName, modelingResult } = body ?? {};
    if (!modelingResult?.uploadId) {
      throw new BadRequestException('modelingResult with uploadId is required');
    }
    const { buffer, mimeType, extension } =
      await this.proposalService.generateMigrationExcel({
        customerName,
        projectName,
        modelingResult,
      });
    const filename = (projectName ?? 'oci-migration-proposal').replace(/[^a-z0-9_-]/gi, '_');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.${extension}"`);
    res.send(buffer);
  }
}

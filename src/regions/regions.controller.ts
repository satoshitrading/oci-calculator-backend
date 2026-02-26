import { Controller, Get, Query } from '@nestjs/common';
import { RegionsRepository } from './regions.repository';

@Controller('api')
export class RegionsController {
  constructor(private readonly repo: RegionsRepository) {}

  @Get('regions')
  async list(@Query('providerId') providerId?: string) {
    const id = providerId ? parseInt(providerId, 10) : null;
    return this.repo.list(Number.isNaN(id) ? null : id);
  }
}

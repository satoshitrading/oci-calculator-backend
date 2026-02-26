import { Controller, Get } from '@nestjs/common';
import { ProvidersRepository } from './providers.repository';

@Controller('api')
export class ProvidersController {
  constructor(private readonly repo: ProvidersRepository) {}

  @Get('providers')
  async list() {
    return this.repo.list();
  }
}

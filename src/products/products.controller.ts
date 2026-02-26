import { Controller, Get, Query } from '@nestjs/common';
import { ProductsRepository } from './products.repository';

@Controller('api')
export class ProductsController {
  constructor(private readonly repo: ProductsRepository) {}

  @Get('products')
  async list(@Query('providerId') providerId?: string) {
    const id = providerId ? parseInt(providerId, 10) : null;
    return this.repo.list(Number.isNaN(id) ? null : id);
  }
}

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from '../database/schemas/product.schema';
import { ProductsController } from './products.controller';
import { ProductsRepository } from './products.repository';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Product.name, schema: ProductSchema }]),
  ],
  controllers: [ProductsController],
  providers: [ProductsRepository],
  exports: [ProductsRepository],
})
export class ProductsModule {}

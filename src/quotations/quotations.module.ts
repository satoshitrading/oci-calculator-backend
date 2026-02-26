import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Quotation, QuotationSchema } from '../database/schemas/quotation.schema';
import { QuotationsController } from './quotations.controller';
import { QuotationsRepository } from './quotations.repository';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Quotation.name, schema: QuotationSchema },
    ]),
  ],
  controllers: [QuotationsController],
  providers: [QuotationsRepository],
})
export class QuotationsModule {}

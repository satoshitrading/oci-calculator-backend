import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Region, RegionSchema } from '../database/schemas/region.schema';
import { RegionsController } from './regions.controller';
import { RegionsRepository } from './regions.repository';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Region.name, schema: RegionSchema }]),
  ],
  controllers: [RegionsController],
  providers: [RegionsRepository],
})
export class RegionsModule {}

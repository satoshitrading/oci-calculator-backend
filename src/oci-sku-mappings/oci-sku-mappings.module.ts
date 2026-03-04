import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  OciSkuMapping,
  OciSkuMappingSchema,
} from '../database/schemas/oci-sku-mapping.schema';
import { OciSkuMappingsController } from './oci-sku-mappings.controller';
import { OciSkuMappingsRepository } from './oci-sku-mappings.repository';
import { OciSkuMappingsService } from './oci-sku-mappings.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OciSkuMapping.name, schema: OciSkuMappingSchema },
    ]),
  ],
  controllers: [OciSkuMappingsController],
  providers: [OciSkuMappingsRepository, OciSkuMappingsService],
  exports: [OciSkuMappingsRepository, OciSkuMappingsService],
})
export class OciSkuMappingsModule {}

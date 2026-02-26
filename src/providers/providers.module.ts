import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CloudProvider, CloudProviderSchema } from '../database/schemas/cloud-provider.schema';
import { ProvidersController } from './providers.controller';
import { ProvidersRepository } from './providers.repository';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CloudProvider.name, schema: CloudProviderSchema },
    ]),
  ],
  controllers: [ProvidersController],
  providers: [ProvidersRepository],
})
export class ProvidersModule {}

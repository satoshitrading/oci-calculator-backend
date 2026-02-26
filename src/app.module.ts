import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { HealthController } from './health/health.controller';
import { ProvidersModule } from './providers/providers.module';
import { RegionsModule } from './regions/regions.module';
import { ProductsModule } from './products/products.module';
import { CalculateModule } from './calculate/calculate.module';
import { ProposalsModule } from './proposals/proposals.module';
import { QuotationsModule } from './quotations/quotations.module';
import { BillingModule } from './billing/billing.module';
import { OciCostModelingModule } from './oci-cost-modeling/oci-cost-modeling.module';
import { DatabaseModule } from './database/database.module';
import { DocumentsModule } from './documents/documents.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      useFactory: () => ({
        uri: process.env.MONGODB_URI || process.env.DATABASE_URL || 'mongodb://localhost:27017/oci-price-calculator',
      }),
    }),
    DatabaseModule,
    ProvidersModule,
    RegionsModule,
    ProductsModule,
    CalculateModule,
    ProposalsModule,
    QuotationsModule,
    BillingModule,
    OciCostModelingModule,
    DocumentsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { AwsPricingService } from './aws-pricing.service';
import { GcpPricingService } from './gcp-pricing.service';
import { AzurePricingService } from './azure-pricing.service';
import { CloudPricingService } from './cloud-pricing.service';
import { InstanceResolverService } from './instance-resolver.service';

/**
 * CloudPricingModule
 *
 * Provides live pricing lookup services for AWS, GCP, and Azure,
 * plus the per-instance OCI SKU resolver used by OciCostModelingService.
 *
 * Credentials:
 *   AWS   — FINOPS_ACCESS_KEY_ID / FINOPS_SECRET_ACCESS_KEY (from .env)
 *   GCP   — GCP_PRICING_API_KEY (from .env)
 *   Azure — no credentials required (public API)
 */
@Module({
  providers: [
    AwsPricingService,
    GcpPricingService,
    AzurePricingService,
    CloudPricingService,
    InstanceResolverService,
  ],
  exports: [
    CloudPricingService,
    InstanceResolverService,
    AwsPricingService,
    GcpPricingService,
    AzurePricingService,
  ],
})
export class CloudPricingModule {}

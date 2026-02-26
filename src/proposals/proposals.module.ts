import { Module } from '@nestjs/common';
import { ProposalsController } from './proposals.controller';
import { ProposalService } from './proposal.service';

@Module({
  controllers: [ProposalsController],
  providers: [ProposalService],
})
export class ProposalsModule {}

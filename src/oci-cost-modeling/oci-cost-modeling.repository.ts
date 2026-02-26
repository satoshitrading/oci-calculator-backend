import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OciCostModeling } from '../database/schemas/oci-cost-modeling.schema';

export interface OciCostModelingRow {
  billingId: number;
  sourceCloud: string;
  resourceId: string | null;
  sourceVcpus: number;
  ociEquivalentQuantity: number;
  ociUnit: string;
  ociTargetSku: string | null;
}

@Injectable()
export class OciCostModelingRepository {
  constructor(
    @InjectModel(OciCostModeling.name)
    private readonly model: Model<OciCostModeling>,
  ) {}

  async list(limit: number = 500): Promise<OciCostModelingRow[]> {
    const docs = await this.model
      .find()
      .sort({ billingId: -1 })
      .limit(limit)
      .lean()
      .exec();
    return docs as OciCostModelingRow[];
  }
}

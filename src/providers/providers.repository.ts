import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CloudProvider } from '../database/schemas/cloud-provider.schema';

export interface CloudProviderRow {
  providerId: number;
  providerName: string;
}

@Injectable()
export class ProvidersRepository {
  constructor(
    @InjectModel(CloudProvider.name)
    private readonly model: Model<CloudProvider>,
  ) {}

  async list(): Promise<CloudProviderRow[]> {
    const docs = await this.model
      .find()
      .sort({ providerName: 1 })
      .lean()
      .exec();
    return docs as CloudProviderRow[];
  }
}

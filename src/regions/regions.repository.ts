import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Region } from '../database/schemas/region.schema';

export interface RegionRow {
  regionId: number;
  providerId: number;
  regionName: string;
}

@Injectable()
export class RegionsRepository {
  constructor(
    @InjectModel(Region.name)
    private readonly model: Model<Region>,
  ) {}

  async list(providerId: number | null = null): Promise<RegionRow[]> {
    const filter = providerId != null ? { providerId } : {};
    const docs = await this.model
      .find(filter)
      .sort(providerId != null ? { regionName: 1 } : { providerId: 1, regionName: 1 })
      .lean()
      .exec();
    return docs as RegionRow[];
  }
}

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CounterDoc, CounterSchema } from './schemas/counter.schema';

@Injectable()
export class CountersService {
  constructor(
    @InjectModel('Counter')
    private readonly counterModel: Model<CounterDoc>,
  ) {}

  async getNextValue(sequenceName: string): Promise<number> {
    const doc = await this.counterModel.findOneAndUpdate(
      { _id: sequenceName },
      { $inc: { value: 1 } },
      { new: true, upsert: true },
    );
    return doc.value;
  }
}

import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ collection: 'regions' })
export class Region extends Document {
  @Prop({ required: true, unique: true })
  regionId: number;

  @Prop({ required: true })
  providerId: number;

  @Prop({ required: true })
  regionName: string;
}

export const RegionSchema = SchemaFactory.createForClass(Region);

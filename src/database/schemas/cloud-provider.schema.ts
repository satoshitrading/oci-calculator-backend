import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ collection: 'cloud_providers' })
export class CloudProvider extends Document {
  @Prop({ required: true, unique: true })
  providerId: number;

  @Prop({ required: true })
  providerName: string;
}

export const CloudProviderSchema = SchemaFactory.createForClass(CloudProvider);

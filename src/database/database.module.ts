import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CounterSchema } from './schemas/counter.schema';
import { CountersService } from './counters.service';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([{ name: 'Counter', schema: CounterSchema }]),
  ],
  providers: [CountersService],
  exports: [CountersService],
})
export class DatabaseModule {}

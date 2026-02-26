import { Schema } from 'mongoose';

export const CounterSchema = new Schema(
  {
    _id: { type: String, required: true },
    value: { type: Number, required: true, default: 0 },
  },
  { collection: 'counters' },
);

export interface CounterDoc {
  _id: string;
  value: number;
}

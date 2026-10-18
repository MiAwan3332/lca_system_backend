import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  _id: String,
  leaseUntil: { type: Date, default: () => new Date(0) },
  leaseToken: String,
  nextAttempt: { type: Date, default: () => new Date(0) },
  lastSent: Date,
  attempts: { type: Number, default: 0 },
  error: String,
}, { timestamps: true });
export default mongoose.model('OperationalAlert', schema);

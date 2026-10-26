import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true },
  target: String,
  requestId: String,
  before: mongoose.Schema.Types.Mixed,
  after: mongoose.Schema.Types.Mixed,
  reason: String,
}, { timestamps: true });
schema.index({ createdAt: -1, _id: -1 });
export default mongoose.model('AccessAudit', schema);

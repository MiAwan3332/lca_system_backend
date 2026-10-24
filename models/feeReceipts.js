import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true, immutable: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', immutable: true },
}, { timestamps: true });
schema.index({ student: 1, createdAt: -1 });
export default mongoose.model('FeeReceipt', schema);

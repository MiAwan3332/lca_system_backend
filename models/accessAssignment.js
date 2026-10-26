import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', required: true, index: true },
  batchIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Batch' }],
  courseIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Course' }],
  expiresAt: Date,
  revokedAt: Date,
  migrationKey: String,
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
schema.index({ user: 1, revokedAt: 1, expiresAt: 1 });
schema.index({ migrationKey: 1 }, { unique: true, partialFilterExpression: { migrationKey: { $type: 'string' } } });
export default mongoose.model('AccessAssignment', schema);

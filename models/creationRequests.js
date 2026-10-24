import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ['student', 'user'], required: true },
  key: { type: String, required: true },
  aliases: [String],
  identity: String,
  fingerprint: { type: String, required: true },
  recordId: { type: mongoose.Schema.Types.ObjectId, required: true },
  requestId: String,
  operation: String,
  target: String,
  state: { type: String, enum: ['preparing', 'committing', 'complete', 'failed', 'expired', 'deleted'], default: 'preparing' },
  finalized: { type: Boolean, default: false },
  plan: { type: mongoose.Schema.Types.Mixed, select: false },
  jobs: [{
    name: String,
    state: { type: String, enum: ['pending', 'processing', 'complete', 'failed'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    startedAt: Date,
    nextRun: { type: Date, default: Date.now },
    result: String,
    error: String,
    diagnostic: mongoose.Schema.Types.Mixed,
  }],
  attempts: { type: Number, default: 0 },
  nextRun: { type: Date, default: Date.now },
  leaseUntil: { type: Date, default: () => new Date(0) },
  leaseToken: String,
  leaseEpoch: { type: Number, default: 0 },
  error: String,
  diagnostic: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
schema.index({ actor: 1, kind: 1, key: 1 }, { unique: true });
schema.index({ actor: 1, kind: 1, aliases: 1 }, { unique: true });
// Also serializes different keys racing to create the same login identity.
schema.index({ kind: 1, identity: 1 }, { unique: true, partialFilterExpression: { identity: { $type: 'string' } } });
schema.index({ finalized: 1, state: 1, nextRun: 1, leaseUntil: 1 });
schema.index({ finalized: 1, createdAt: 1 });
schema.index({ 'jobs.state': 1 });
export default mongoose.model('CreationRequest', schema);

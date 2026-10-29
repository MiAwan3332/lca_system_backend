import mongoose from 'mongoose';

const ObjectId = mongoose.Schema.Types.ObjectId;

// One reverted payment: why, by whom, and a full copy of every record it removed or changed.
// Steps record progress so an interrupted reversal can be finished by running it again.
const paymentReversalSchema = new mongoose.Schema({
  student: { type: ObjectId, ref: 'Student', required: true, index: true },
  payment_log: { type: ObjectId, required: true, unique: true },
  payment_id: String,
  amount: { type: Number, required: true },
  payment_method: String,
  payment_date: Date,
  collected_by: { type: ObjectId, ref: 'User' },
  reason_category: { type: String, required: true },
  reason_note: { type: String, required: true },
  warnings: [String],
  reverted_by: { type: ObjectId, ref: 'User', required: true },
  reverted_at: { type: Date, default: Date.now },
  ip: String,
  status: { type: String, enum: ['in_progress', 'incomplete', 'completed'], default: 'in_progress' },
  error: String,
  steps: {
    fees: { type: Boolean, default: false },
    receipts: { type: Boolean, default: false },
    slips: { type: Boolean, default: false },
    logs: { type: Boolean, default: false },
  },
  fee_changes: [{ _id: false, fee: ObjectId, before_amount: Number, before_status: String, after_amount: Number, after_status: String }],
  totals_before: mongoose.Schema.Types.Mixed,
  totals_after: mongoose.Schema.Types.Mixed,
  removed: {
    logs: [mongoose.Schema.Types.Mixed],
    fees: [mongoose.Schema.Types.Mixed],
    receipts: [mongoose.Schema.Types.Mixed],
    slips: [mongoose.Schema.Types.Mixed],
  },
  imported: { type: Boolean, default: false },
}, { timestamps: true });

export default mongoose.model('PaymentReversal', paymentReversalSchema);

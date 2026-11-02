import mongoose from 'mongoose';

const ObjectId = mongoose.Schema.Types.ObjectId;

// One undone step of a student's fee timeline (payment, discount, refund or fee assignment): why, by whom,
// and a full copy of every record it removed or changed.
// Steps record progress so an interrupted reversal can be finished by running it again.
const paymentReversalSchema = new mongoose.Schema({
  student: { type: ObjectId, ref: 'Student', required: true, index: true },
  // The timeline entry that was undone (named for the payments this first covered).
  payment_log: { type: ObjectId, required: true, unique: true },
  // Paid, Discounted, Refund or Created; records made before other steps could be undone are payments.
  step_type: { type: String, enum: ['Paid', 'Discounted', 'Refund', 'Created'], default: 'Paid' },
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
    refund: { type: Boolean, default: false },
    logs: { type: Boolean, default: false },
  },
  // removes_fee: the undone fee assignment deleted this fee record.
  fee_changes: [{ _id: false, fee: ObjectId, before_amount: Number, before_status: String, after_amount: Number, after_status: String, removes_fee: Boolean }],
  totals_before: mongoose.Schema.Types.Mixed,
  totals_after: mongoose.Schema.Types.Mixed,
  removed: {
    logs: [mongoose.Schema.Types.Mixed],
    fees: [mongoose.Schema.Types.Mixed],
    receipts: [mongoose.Schema.Types.Mixed],
    slips: [mongoose.Schema.Types.Mixed],
    refund_requests: [mongoose.Schema.Types.Mixed],
    students: [mongoose.Schema.Types.Mixed],
  },
  imported: { type: Boolean, default: false },
}, { timestamps: true });

export default mongoose.model('PaymentReversal', paymentReversalSchema);

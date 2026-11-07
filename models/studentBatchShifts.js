import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

/**
 * Chronological record of student batch transfers (shift batch).
 */
const studentBatchShiftSchema = mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
      index: true,
    },
    student_name: { type: String, default: "", index: true },
    student_phone: { type: String, default: "" },
    student_email: { type: String, default: "" },
    from_batch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      default: null,
    },
    from_batch_name: { type: String, default: "" },
    to_batch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      required: true,
      index: true,
    },
    to_batch_name: { type: String, default: "" },
    from_roll_number: { type: String, default: "" },
    to_roll_number: { type: String, default: "" },
    shifted_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    shifted_by_name: { type: String, default: "" },
    shifted_by_email: { type: String, default: "" },
    shifted_by_role: { type: String, default: "" },
    shifted_at: {
      type: Date,
      default: Date.now,
      index: true,
    },
    notes: { type: String, default: "" },
    /** Pending-dues transfer audit (optional). */
    pending_dues_transferred: { type: Boolean, default: false },
    previous_pending_amount: { type: Number, default: 0 },
    new_batch_original_fee: { type: Number, default: 0 },
    new_batch_discount: { type: Number, default: 0 },
    new_batch_payable: { type: Number, default: 0 },
    transfer_remarks: { type: String, default: "" },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: false },
  }
);

studentBatchShiftSchema.index({ shifted_at: -1 });
studentBatchShiftSchema.index({
  student_name: "text",
  student_phone: "text",
  from_batch_name: "text",
  to_batch_name: "text",
  shifted_by_name: "text",
});

studentBatchShiftSchema.plugin(mongoosePaginate);

const StudentBatchShift = mongoose.model(
  "StudentBatchShift",
  studentBatchShiftSchema
);

export default StudentBatchShift;

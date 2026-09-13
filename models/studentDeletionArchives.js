import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

/**
 * Immutable snapshot created when a student is permanently deleted.
 * Preserves identity, who deleted them, and complete finance data.
 */
const studentDeletionArchiveSchema = mongoose.Schema(
  {
    original_student_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    student: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    batch_snapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    finance: {
      summary: {
        total_fee: { type: Number, default: 0 },
        paid_fee: { type: Number, default: 0 },
        pending_fee: { type: Number, default: 0 },
        cash_amount: { type: Number, default: 0 },
        online_amount: { type: Number, default: 0 },
        fees_count: { type: Number, default: 0 },
        fee_logs_count: { type: Number, default: 0 },
        pending_fee_slips_count: { type: Number, default: 0 },
        refund_requests_count: { type: Number, default: 0 },
      },
      fees: { type: [mongoose.Schema.Types.Mixed], default: [] },
      fee_logs: { type: [mongoose.Schema.Types.Mixed], default: [] },
      pending_fee_slips: { type: [mongoose.Schema.Types.Mixed], default: [] },
      refund_requests: { type: [mongoose.Schema.Types.Mixed], default: [] },
    },
    cascade_summary: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    deleted_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    deleted_by_name: {
      type: String,
      default: "",
      index: true,
    },
    deleted_by_email: {
      type: String,
      default: "",
    },
    deleted_by_role: {
      type: String,
      default: "",
    },
    deletion_source: {
      type: String,
      enum: ["student_delete", "batch_delete", "other"],
      default: "student_delete",
      index: true,
    },
    deletion_reason: {
      type: String,
      default: "",
    },
    deleted_at: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: false },
  }
);

studentDeletionArchiveSchema.index({ deleted_at: -1 });
studentDeletionArchiveSchema.index({
  "student.name": "text",
  "student.email": "text",
  "student.phone": "text",
  "student.roll_number": "text",
  deleted_by_name: "text",
});

studentDeletionArchiveSchema.plugin(mongoosePaginate);

const StudentDeletionArchive = mongoose.model(
  "StudentDeletionArchive",
  studentDeletionArchiveSchema
);

export default StudentDeletionArchive;

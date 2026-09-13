import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

/**
 * Immutable snapshot created when a batch is permanently deleted.
 * Preserves batch details, enrolled students, and who deleted it.
 */
const batchDeletionArchiveSchema = mongoose.Schema(
  {
    original_batch_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    batch: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    students: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    student_archive_ids: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "StudentDeletionArchive",
      },
    ],
    summary: {
      students_count: { type: Number, default: 0 },
      total_fee: { type: Number, default: 0 },
      paid_fee: { type: Number, default: 0 },
      pending_fee: { type: Number, default: 0 },
      cash_amount: { type: Number, default: 0 },
      online_amount: { type: Number, default: 0 },
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

batchDeletionArchiveSchema.index({ deleted_at: -1 });
batchDeletionArchiveSchema.index({
  "batch.name": "text",
  "batch.description": "text",
  deleted_by_name: "text",
  "students.name": "text",
  "students.phone": "text",
  "students.roll_number": "text",
});

batchDeletionArchiveSchema.plugin(mongoosePaginate);

const BatchDeletionArchive = mongoose.model(
  "BatchDeletionArchive",
  batchDeletionArchiveSchema
);

export default BatchDeletionArchive;

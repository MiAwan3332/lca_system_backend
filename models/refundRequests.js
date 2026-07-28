import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const refundRequestSchema = mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
    },
    student_name: String,
    student_roll_number: String,
    student_phone: String,
    batch_name: String,
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    requested_amount: {
      type: Number,
      min: 0,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      default: "Pending",
      enum: ["Pending", "Approved", "Rejected"],
    },
    requested_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    approved_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    approved_at: Date,
    approval_comment: String,
    rejected_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    rejected_at: Date,
    rejection_comment: String,
    is_refunded: {
      type: Boolean,
      default: false,
    },
    refunded_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    refunded_at: Date,
    fee_log: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FeeLog",
    },
    refunded_amount: {
      type: Number,
      min: 0,
    },
  },
  { timestamps: true }
);

refundRequestSchema.plugin(mongoosePaginate);

const RefundRequest = mongoose.model("RefundRequest", refundRequestSchema);
export default RefundRequest;

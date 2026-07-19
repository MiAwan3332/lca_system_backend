import mongoose from "mongoose";

const pendingFeeSlipSchema = mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
      index: true,
    },
    pending_amount: {
      type: Number,
      required: true,
      min: 0,
    },
    slip_url: {
      type: String,
      required: true,
    },
    fee_ids: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Fee",
      },
    ],
    generated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

pendingFeeSlipSchema.index({ student: 1, pending_amount: 1 });

const PendingFeeSlip = mongoose.model("PendingFeeSlip", pendingFeeSlipSchema);
export default PendingFeeSlip;

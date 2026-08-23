import mongoose from "mongoose";

const admissionSlipVerificationSchema = mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    student_name: { type: String, required: true, trim: true },
    cnic: { type: String, default: "", trim: true },
    phone: { type: String, default: "", trim: true },
    batch_name: { type: String, default: "", trim: true },
    total_fee: { type: Number, default: 0 },
    amount_received: { type: Number, default: 0 },
    remaining_fee: { type: Number, default: 0 },
    payment_option: { type: String, default: "" },
    payment_method: { type: String, default: "" },
    class_time: { type: String, default: "" },
    authorized_by: { type: String, default: "" },
    issued_at: { type: Date, default: Date.now },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

const AdmissionSlipVerification = mongoose.model(
  "AdmissionSlipVerification",
  admissionSlipVerificationSchema
);

export default AdmissionSlipVerification;

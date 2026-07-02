import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const complaintSchema = mongoose.Schema(
  {
    subject: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    category: {
      type: String,
      default: "General",
      enum: ["General", "Academic", "Discipline", "Facilities", "Finance", "Other"],
    },
    target_role: {
      type: String,
      required: true,
      enum: ["teacher", "principal", "vice_principal", "ceo"],
    },
    submitted_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    submitted_by_student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
    },
    submitter_role: String,
    status: {
      type: String,
      default: "Open",
      enum: ["Open", "In Review", "Resolved", "Rejected"],
    },
    response: String,
    responded_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    responded_at: Date,
  },
  { timestamps: true }
);

complaintSchema.plugin(mongoosePaginate);

const Complaint = mongoose.model("Complaint", complaintSchema);
export default Complaint;

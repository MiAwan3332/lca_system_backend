import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const attachmentSchema = mongoose.Schema(
  {
    file_name: String,
    file_url: String,
    file_type: String,
    file_size: Number,
  },
  { _id: true }
);

const assignmentSchema = mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String, default: "" },
    instructions: { type: String, default: "" },
    batch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      required: true,
    },
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course",
      required: true,
    },
    attachments: [attachmentSchema],
    max_marks: { type: Number, default: 100 },
    grading_criteria: { type: String, default: "" },
    availability_date: { type: Date, required: true },
    has_deadline: { type: Boolean, default: true },
    submission_deadline: { type: Date },
    late_submission_policy: {
      type: String,
      enum: [
        "no_late",
        "late_with_penalty",
        "late_without_penalty",
        "late_until_deadline",
      ],
      default: "no_late",
    },
    late_deadline: { type: Date },
    late_penalty_percent: { type: Number, default: 0 },
    visibility_status: {
      type: String,
      enum: ["Draft", "Published"],
      default: "Draft",
    },
    status: {
      type: String,
      enum: ["Draft", "Published", "Closed"],
      default: "Draft",
    },
    resubmission_allowed: { type: Boolean, default: false },
    max_attempts: { type: Number, default: 1 },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    published_at: { type: Date },
  },
  { timestamps: true }
);

assignmentSchema.plugin(mongoosePaginate);

const Assignment = mongoose.model("Assignment", assignmentSchema);
export default Assignment;

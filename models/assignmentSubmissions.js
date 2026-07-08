import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const submissionFileSchema = mongoose.Schema(
  {
    file_name: String,
    file_url: String,
    file_type: String,
    file_size: Number,
  },
  { _id: true }
);

const assignmentSubmissionSchema = mongoose.Schema(
  {
    assignment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Assignment",
      required: true,
    },
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
    },
    attempt_number: { type: Number, default: 1 },
    files: [submissionFileSchema],
    submission_text: { type: String, default: "" },
    status: {
      type: String,
      enum: [
        "Submitted",
        "Late Submitted",
        "Under Review",
        "Graded",
        "Completed",
        "Resubmission Requested",
      ],
      default: "Submitted",
    },
    is_late: { type: Boolean, default: false },
    marks_obtained: { type: Number },
    penalty_applied: { type: Number, default: 0 },
    feedback: { type: String, default: "" },
    graded_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    graded_at: { type: Date },
    resubmission_requested: { type: Boolean, default: false },
    submitted_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

assignmentSubmissionSchema.index(
  { assignment: 1, student: 1, attempt_number: 1 },
  { unique: true }
);

assignmentSubmissionSchema.plugin(mongoosePaginate);

const AssignmentSubmission = mongoose.model(
  "AssignmentSubmission",
  assignmentSubmissionSchema
);
export default AssignmentSubmission;

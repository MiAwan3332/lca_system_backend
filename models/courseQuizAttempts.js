import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const answerSchema = mongoose.Schema(
  {
    question_id: String,
    question_type: String,
    question: String,
    options: [{ type: String }],
    selected_answers: [{ type: String }],
    text_answer: { type: String, default: "" },
    correct_answers: [{ type: String }],
    marks: { type: Number, default: 0 },
    awarded_marks: { type: Number, default: 0 },
    is_correct: { type: Boolean, default: false },
    requires_manual_grading: { type: Boolean, default: false },
    manual_marks: { type: Number },
    feedback: { type: String, default: "" },
  },
  { _id: false }
);

const courseQuizAttemptSchema = mongoose.Schema(
  {
    quiz: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CourseQuiz",
      required: true,
    },
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
    },
    attempt_number: { type: Number, default: 1 },
    status: {
      type: String,
      enum: [
        "In Progress",
        "Submitted",
        "Under Review",
        "Graded",
        "Published",
        "Auto Submitted",
      ],
      default: "In Progress",
    },
    answers: [answerSchema],
    auto_graded_score: { type: Number, default: 0 },
    manual_score: { type: Number, default: 0 },
    total_score: { type: Number, default: 0 },
    max_score: { type: Number, default: 0 },
    percentage: { type: Number, default: 0 },
    passed: { type: Boolean, default: false },
    started_at: { type: Date, default: Date.now },
    submitted_at: { type: Date },
    duration_seconds: { type: Number, default: 0 },
    result_visible: { type: Boolean, default: false },
    reviewed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    reviewed_at: { type: Date },
    result_published_at: { type: Date },
  },
  { timestamps: true }
);

courseQuizAttemptSchema.index({ quiz: 1, student: 1, attempt_number: 1 }, { unique: true });
courseQuizAttemptSchema.plugin(mongoosePaginate);

const CourseQuizAttempt = mongoose.model("CourseQuizAttempt", courseQuizAttemptSchema);
export default CourseQuizAttempt;

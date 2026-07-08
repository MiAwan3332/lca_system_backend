import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const quizAnswerSchema = mongoose.Schema({
  mcq: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Mcqs",
    required: true,
  },
  question_order: { type: Number, required: true },
  question: { type: String, required: true },
  options: [{ type: String }],
  correct_option_index: { type: Number, required: true },
  selected_option: { type: Number, default: null },
  is_skipped: { type: Boolean, default: false },
  is_correct: { type: Boolean, default: null },
  answered_at: { type: Date, default: null },
});

const quizAttemptSchema = mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
    },
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course",
      required: true,
    },
    pattern: {
      type: String,
      enum: ["sequential", "shuffle_questions", "shuffle_all"],
      required: true,
    },
    question_count_requested: { type: Number, default: null },
    timer_enabled: { type: Boolean, default: false },
    timer_seconds: { type: Number, default: null },
    started_at: { type: Date, default: Date.now },
    ended_at: { type: Date, default: null },
    duration_seconds: { type: Number, default: null },
    total_questions: { type: Number, default: 0 },
    correct_count: { type: Number, default: 0 },
    incorrect_count: { type: Number, default: 0 },
    skipped_count: { type: Number, default: 0 },
    score: { type: Number, default: 0 },
    percentage: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["in_progress", "submitted", "abandoned"],
      default: "in_progress",
    },
    answers: [quizAnswerSchema],
  },
  { timestamps: true }
);

quizAttemptSchema.plugin(mongoosePaginate);

const QuizAttempt = mongoose.model("QuizAttempt", quizAttemptSchema);
export default QuizAttempt;

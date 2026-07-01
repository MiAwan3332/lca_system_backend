import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const embeddedQuestionSchema = mongoose.Schema(
  {
    question_type: {
      type: String,
      enum: ["multiple_choice", "multiple_select", "true_false", "short_answer", "essay"],
      default: "multiple_choice",
    },
    question: { type: String, required: true },
    options: [{ type: String }],
    correct_answers: [{ type: String }],
    marks: { type: Number, default: 1 },
    negative_marks: { type: Number, default: 0 },
  },
  { _id: true }
);

const courseQuizSchema = mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String, default: "" },
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
    start_datetime: { type: Date, required: true },
    end_datetime: { type: Date, required: true },
    duration_minutes: { type: Number, default: 30 },
    passing_marks: { type: Number, default: 50 },
    max_marks: { type: Number, default: 100 },
    max_attempts: { type: Number, default: 1 },
    randomize_questions: { type: Boolean, default: false },
    negative_marking: { type: Boolean, default: false },
    negative_mark_value: { type: Number, default: 0 },
    use_mcq_bank: { type: Boolean, default: true },
    question_count: { type: Number, default: 10 },
    embedded_questions: [embeddedQuestionSchema],
    auto_submit_on_timeout: { type: Boolean, default: true },
    result_publication: {
      type: String,
      enum: ["immediate", "after_review", "scheduled", "after_end_date"],
      default: "after_end_date",
    },
    result_release_at: { type: Date },
    hide_correct_answers_until_release: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["Draft", "Scheduled", "Active", "Closed", "Published"],
      default: "Draft",
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    published_at: { type: Date },
  },
  { timestamps: true }
);

courseQuizSchema.plugin(mongoosePaginate);

const CourseQuiz = mongoose.model("CourseQuiz", courseQuizSchema);
export default CourseQuiz;

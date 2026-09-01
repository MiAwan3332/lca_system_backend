import mongoose from "mongoose";

const SCORE_FIELDS = {
  knowledge: { max: 15 },
  analytical_ability: { max: 20 },
  communication: { max: 15 },
  confidence: { max: 15 },
  personality: { max: 10 },
  body_language: { max: 10 },
  current_affairs: { max: 10 },
  ethics_decision: { max: 10 },
};

const interviewEvaluationSchema = mongoose.Schema(
  {
    panel_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InterviewPanel",
      required: true,
    },
    schedule_index: { type: Number, required: true },
    qualifier_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Qualifier",
      default: null,
    },
    panelist_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Panelist",
      default: null,
    },
    started_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    status: {
      type: String,
      enum: ["in_progress", "completed"],
      default: "in_progress",
    },
    knowledge: { type: Number, default: null, min: 0, max: 15 },
    analytical_ability: { type: Number, default: null, min: 0, max: 20 },
    communication: { type: Number, default: null, min: 0, max: 15 },
    confidence: { type: Number, default: null, min: 0, max: 15 },
    personality: { type: Number, default: null, min: 0, max: 10 },
    body_language: { type: Number, default: null, min: 0, max: 10 },
    current_affairs: { type: Number, default: null, min: 0, max: 10 },
    ethics_decision: { type: Number, default: null, min: 0, max: 10 },
    key_strength: { type: String, default: "", trim: true },
    major_weakness: { type: String, default: "", trim: true },
    improvement_since_last_mock: { type: String, default: "", trim: true },
    verdict: {
      type: String,
      enum: [
        "",
        "ready_final_css",
        "needs_more_mock",
        "intensive_coaching",
      ],
      default: "",
    },
    final_remarks: { type: String, default: "", trim: true },
    started_at: { type: Date, default: Date.now },
    completed_at: { type: Date, default: null },
  },
  { timestamps: true }
);

interviewEvaluationSchema.index(
  { panel_id: 1, schedule_index: 1 },
  { unique: true }
);

export { SCORE_FIELDS };

const InterviewEvaluation = mongoose.model(
  "InterviewEvaluation",
  interviewEvaluationSchema
);
export default InterviewEvaluation;

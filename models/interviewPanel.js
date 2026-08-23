import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const interviewPanelSchema = mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    date: {
      type: String,
      default: "",
    },
    /** @deprecated use start_time — kept for older documents */
    time: {
      type: String,
      default: "",
    },
    start_time: {
      type: String,
      default: "",
    },
    end_time: {
      type: String,
      default: "",
    },
    venue: {
      type: String,
      default: "",
      trim: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    members: [
      {
        name: { type: String, trim: true, required: true },
        role: { type: String, trim: true, default: "Panelist" },
        description: { type: String, trim: true, required: true },
      },
    ],
    /** Extra / additional interview slots for this panel */
    schedules: [
      {
        date: { type: String, required: true },
        start_time: { type: String, default: "" },
        end_time: { type: String, default: "" },
        venue: { type: String, default: "", trim: true },
        notes: { type: String, default: "", trim: true },
        booking_status: {
          type: String,
          enum: ["available", "booked"],
          default: "available",
        },
        booked_for: { type: String, default: "", trim: true },
        booked_phone: { type: String, default: "", trim: true },
        booked_notes: { type: String, default: "", trim: true },
        booked_user_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },
        booked_at: { type: Date, default: null },
      },
    ],
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

interviewPanelSchema.plugin(mongoosePaginate);

const InterviewPanel = mongoose.model("InterviewPanel", interviewPanelSchema);
export default InterviewPanel;

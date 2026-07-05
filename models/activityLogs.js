import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const activityLogSchema = mongoose.Schema(
  {
    actor_category: {
      type: String,
      enum: ["student", "teacher", "admin"],
      required: true,
      index: true,
    },
    actor_user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    actor_role: String,
    actor_name: String,
    actor_email: String,
    actor_student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
    },
    actor_teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Teacher",
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    module: {
      type: String,
      default: "general",
      index: true,
    },
    description: {
      type: String,
      required: true,
    },
    method: String,
    path: String,
    status_code: Number,
    target_id: String,
    target_type: String,
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    ip_address: String,
    user_agent: String,
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: false },
  }
);

activityLogSchema.index({ created_at: -1 });
activityLogSchema.index({ actor_email: 1, created_at: -1 });

activityLogSchema.plugin(mongoosePaginate);

const ActivityLog = mongoose.model("ActivityLog", activityLogSchema);
export default ActivityLog;

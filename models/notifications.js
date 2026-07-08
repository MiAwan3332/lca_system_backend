import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const notificationSchema = mongoose.Schema(
  {
    recipient_user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    recipient_student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
    },
    type: {
      type: String,
      enum: [
        "assignment_published",
        "assignment_deadline_reminder",
        "assignment_late_warning",
        "assignment_graded",
        "quiz_available",
        "quiz_reminder",
        "quiz_result_published",
        "announcement",
        "complaint_received",
        "fee_installment_reminder",
        "fee_installment_admin_alert",
        "fee_daily_due_report",
        "fee_due_today_admin_alert",
        "fee_overdue_admin_alert",
      ],
      required: true,
    },
    title: { type: String, required: true },
    message: { type: String, required: true },
    entity_type: {
      type: String,
      enum: ["assignment", "course_quiz", "submission", "quiz_attempt", "announcement", "complaint", "fee"],
    },
    entity_id: {
      type: mongoose.Schema.Types.ObjectId,
    },
    is_read: { type: Boolean, default: false },
    read_at: { type: Date },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

notificationSchema.plugin(mongoosePaginate);

const Notification = mongoose.model("Notification", notificationSchema);
export default Notification;

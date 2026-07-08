import moment from "moment-timezone";
import Fee from "../models/fees.js";
import User from "../models/users.js";
import Notification from "../models/notifications.js";
import { createNotification } from "./notificationService.js";

const TZ = "Asia/Karachi";
const REMINDER_DAYS_BEFORE = 7;
const ADMIN_ROLES = [
  "admin",
  "superadmin",
  "super_admin",
  "super admin",
  "Super Admin",
  "Super_Admin",
  "super admin development",
  "Super Admin Development",
  "secrateadmin",
  "ceo",
  "CEO",
  "user",
];

const getStartOfToday = () => moment.tz(TZ).startOf("day").toDate();

const buildDaysText = (daysUntil) => {
  if (daysUntil === 0) return "is due today";
  if (daysUntil < 0) return `is overdue by ${Math.abs(daysUntil)} day(s)`;
  return `is due in ${daysUntil} day(s)`;
};

export async function processInstallmentReminders() {
  try {
    const today = moment.tz(TZ).startOf("day");
    const startOfToday = getStartOfToday();

    const pendingFees = await Fee.find({
      status: "Pending",
      amount: { $gt: 0 },
      due_date: { $exists: true, $ne: "" },
    })
      .populate("student", "name email")
      .populate("batch", "name");

    if (!pendingFees.length) return;

    const admins = await User.find({ role: { $in: ADMIN_ROLES } }).select("_id name");

    for (const fee of pendingFees) {
      if (!fee.student || !fee.due_date) continue;

      const dueDate = moment.tz(fee.due_date, TZ).startOf("day");
      if (!dueDate.isValid()) continue;

      const daysUntil = dueDate.diff(today, "days");
      if (daysUntil > REMINDER_DAYS_BEFORE) continue;

      const studentId = fee.student._id || fee.student;
      const studentName = fee.student.name || "Student";
      const batchName = fee.batch?.name || "N/A";
      const amount = Number(fee.amount) || 0;
      const dueLabel = dueDate.format("DD MMM YYYY");
      const daysText = buildDaysText(daysUntil);

      const existingStudentReminder = await Notification.findOne({
        type: "fee_installment_reminder",
        entity_id: fee._id,
        recipient_student: studentId,
        createdAt: { $gte: startOfToday },
      });

      if (!existingStudentReminder) {
        await createNotification({
          recipientStudentId: studentId,
          type: "fee_installment_reminder",
          title: "Fee Installment Reminder",
          message: `Your next installment of Rs. ${amount.toLocaleString("en-PK")} ${daysText}. Due date: ${dueLabel}.`,
          entityType: "fee",
          entityId: fee._id,
          metadata: {
            due_date: fee.due_date,
            days_until: daysUntil,
            amount,
            batch_name: batchName,
          },
        });
      }

      for (const admin of admins) {
        const existingAdminReminder = await Notification.findOne({
          type: "fee_installment_admin_alert",
          entity_id: fee._id,
          recipient_user: admin._id,
          createdAt: { $gte: startOfToday },
        });

        if (existingAdminReminder) continue;

        await createNotification({
          recipientUserId: admin._id,
          type: "fee_installment_admin_alert",
          title: "Student Installment Reminder",
          message: `${studentName} (${batchName}) — Rs. ${amount.toLocaleString("en-PK")} installment ${daysText}. Due date: ${dueLabel}.`,
          entityType: "fee",
          entityId: fee._id,
          metadata: {
            due_date: fee.due_date,
            days_until: daysUntil,
            amount,
            student_name: studentName,
            batch_name: batchName,
          },
        });
      }
    }
  } catch (error) {
    console.error("Installment reminder job failed:", error.message);
  }
}

import { processDailyFeeDueReportNotifications } from "./feeDueReport.js";

export function startInstallmentReminderScheduler() {
  const runDailyFeeJobs = () => {
    processInstallmentReminders();
    processDailyFeeDueReportNotifications();
  };

  runDailyFeeJobs();
  const oneDayMs = 24 * 60 * 60 * 1000;
  setInterval(runDailyFeeJobs, oneDayMs);
}

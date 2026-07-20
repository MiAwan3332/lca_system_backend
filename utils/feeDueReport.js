import moment from "moment-timezone";
import Fee from "../models/fees.js";
import User from "../models/users.js";
import Notification from "../models/notifications.js";
import { createNotification } from "./notificationService.js";

const TZ = "Asia/Karachi";

const ADMIN_ROLES = [
  "admin",
  "administrator",
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

const formatFeeEntry = (fee, daysUntil, referenceIsToday = true) => {
  const student = fee.student;
  const batch = fee.batch;
  const amount = Number(fee.amount) || 0;
  const dueDate = moment.tz(fee.due_date, TZ);

  return {
    fee_id: fee._id,
    student_id: student?._id || student,
    student_name: student?.name || "Unknown",
    student_email: student?.email || "",
    student_phone: student?.phone || "",
    batch_name: batch?.name || "N/A",
    amount,
    due_date: fee.due_date,
    due_date_label: dueDate.isValid() ? dueDate.format("DD MMM YYYY") : fee.due_date,
    days_until: daysUntil,
    overdue_days: daysUntil < 0 ? Math.abs(daysUntil) : 0,
    status_label:
      daysUntil === 0
        ? referenceIsToday
          ? "Due Today"
          : "Due on Date"
        : daysUntil < 0
          ? "Overdue"
          : "Upcoming",
  };
};

export async function buildFeeDueReport(reportDateInput) {
  const reference = reportDateInput
    ? moment.tz(reportDateInput, TZ).startOf("day")
    : moment.tz(TZ).startOf("day");

  if (!reference.isValid()) {
    throw new Error("Invalid report date");
  }

  const today = moment.tz(TZ).startOf("day");
  const referenceStr = reference.format("YYYY-MM-DD");
  const referenceIsToday = reference.isSame(today, "day");

  const pendingFees = await Fee.find({
    status: "Pending",
    amount: { $gt: 0 },
    due_date: { $exists: true, $ne: "" },
  })
    .populate("student", "name email phone")
    .populate("batch", "name");

  const dueOnDate = [];
  const overdue = [];

  for (const fee of pendingFees) {
    if (!fee.due_date) continue;
    const dueDate = moment.tz(fee.due_date, TZ).startOf("day");
    if (!dueDate.isValid()) continue;

    const daysUntil = dueDate.diff(reference, "days");
    const entry = formatFeeEntry(fee, daysUntil, referenceIsToday);

    if (daysUntil === 0) {
      dueOnDate.push(entry);
    } else if (daysUntil < 0) {
      overdue.push(entry);
    }
  }

  dueOnDate.sort((a, b) => a.student_name.localeCompare(b.student_name));
  overdue.sort((a, b) => a.days_until - b.days_until || a.student_name.localeCompare(b.student_name));

  const sumAmount = (items) => items.reduce((sum, item) => sum + item.amount, 0);

  return {
    report_date: referenceStr,
    report_date_label: reference.format("DD MMM YYYY"),
    is_today: referenceIsToday,
    generated_at: moment.tz(TZ).format("DD MMM YYYY, hh:mm A"),
    due_today: dueOnDate,
    due_on_date: dueOnDate,
    overdue,
    summary: {
      due_today_count: dueOnDate.length,
      due_on_date_count: dueOnDate.length,
      overdue_count: overdue.length,
      due_today_amount: sumAmount(dueOnDate),
      due_on_date_amount: sumAmount(dueOnDate),
      overdue_amount: sumAmount(overdue),
      total_pending_count: dueOnDate.length + overdue.length,
      total_pending_amount: sumAmount(dueOnDate) + sumAmount(overdue),
    },
  };
}

export async function processDailyFeeDueReportNotifications() {
  try {
    const report = await buildFeeDueReport();
    const { summary, report_date_label } = report;

    if (summary.due_today_count === 0 && summary.overdue_count === 0) {
      return;
    }

    const admins = await User.find({ role: { $in: ADMIN_ROLES } }).select("_id name");
    if (!admins.length) return;

    const startOfToday = getStartOfToday();

    for (const admin of admins) {
      const existingSummary = await Notification.findOne({
        type: "fee_daily_due_report",
        recipient_user: admin._id,
        createdAt: { $gte: startOfToday },
      });

      if (!existingSummary) {
        await createNotification({
          recipientUserId: admin._id,
          type: "fee_daily_due_report",
          title: "Daily Fee Due Report",
          message: `${summary.due_today_count} fee(s) due today, ${summary.overdue_count} overdue as of ${report_date_label}. Open Notifications to view the full report.`,
          entityType: "fee",
          metadata: {
            report_date: report.report_date,
            ...summary,
          },
        });
      }
    }

    for (const entry of report.due_today) {
      for (const admin of admins) {
        const exists = await Notification.findOne({
          type: "fee_due_today_admin_alert",
          entity_id: entry.fee_id,
          recipient_user: admin._id,
          createdAt: { $gte: startOfToday },
        });
        if (exists) continue;

        await createNotification({
          recipientUserId: admin._id,
          type: "fee_due_today_admin_alert",
          title: "Fee Due Today",
          message: `${entry.student_name} (${entry.batch_name}) — Rs. ${entry.amount.toLocaleString("en-PK")} is due today (${entry.due_date_label}).`,
          entityType: "fee",
          entityId: entry.fee_id,
          metadata: {
            due_date: entry.due_date,
            days_until: 0,
            amount: entry.amount,
            student_name: entry.student_name,
            batch_name: entry.batch_name,
            report_date: report.report_date,
          },
        });
      }
    }

    for (const entry of report.overdue) {
      for (const admin of admins) {
        const exists = await Notification.findOne({
          type: "fee_overdue_admin_alert",
          entity_id: entry.fee_id,
          recipient_user: admin._id,
          createdAt: { $gte: startOfToday },
        });
        if (exists) continue;

        await createNotification({
          recipientUserId: admin._id,
          type: "fee_overdue_admin_alert",
          title: "Fee Overdue",
          message: `${entry.student_name} (${entry.batch_name}) — Rs. ${entry.amount.toLocaleString("en-PK")} is overdue by ${entry.overdue_days} day(s). Due date: ${entry.due_date_label}.`,
          entityType: "fee",
          entityId: entry.fee_id,
          metadata: {
            due_date: entry.due_date,
            days_until: entry.days_until,
            overdue_days: entry.overdue_days,
            amount: entry.amount,
            student_name: entry.student_name,
            batch_name: entry.batch_name,
            report_date: report.report_date,
          },
        });
      }
    }
  } catch (error) {
    console.error("Daily fee due report job failed:", error.message);
  }
}

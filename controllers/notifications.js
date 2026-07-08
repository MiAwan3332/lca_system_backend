import Notification from "../models/notifications.js";
import moment from "moment-timezone";
import {
  isStudentRole,
  resolveStudentId,
  getRequestUserId,
} from "../utils/lmsAccess.js";
import { markNotificationRead } from "../utils/notificationService.js";
import { processInstallmentReminders } from "../utils/feeInstallmentReminders.js";
import {
  buildFeeDueReport,
  processDailyFeeDueReportNotifications,
} from "../utils/feeDueReport.js";
import { isInstitutionAdmin, denyUnlessInstitutionAdmin } from "../utils/lmsAccess.js";

export const getNotifications = async (req, res) => {
  try {
    processInstallmentReminders().catch(() => {});
    if (isInstitutionAdmin(req)) {
      processDailyFeeDueReportNotifications().catch(() => {});
    }

    const baseFilter = {};
    if (isStudentRole(req)) {
      baseFilter.recipient_student = await resolveStudentId(req);
    } else {
      baseFilter.recipient_user = getRequestUserId(req);
    }

    const filter = { ...baseFilter };

    if (req.query.unread_only === "true") {
      filter.is_read = false;
    } else if (req.query.read_only === "true") {
      filter.is_read = true;
    }

    if (req.query.type && req.query.type !== "all") {
      filter.type = req.query.type;
    }

    if (req.query.date) {
      const day = moment.tz(req.query.date, "Asia/Karachi");
      if (day.isValid()) {
        filter.createdAt = {
          $gte: day.clone().startOf("day").toDate(),
          $lte: day.clone().endOf("day").toDate(),
        };
      }
    }

    const unreadCount = await Notification.countDocuments({
      ...baseFilter,
      is_read: false,
    });

    const notifications = await Notification.paginate(filter, {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 20,
      sort: { createdAt: -1 },
    });

    res.status(200).json({ ...notifications, unreadCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const markAsRead = async (req, res) => {
  try {
    const studentId = isStudentRole(req) ? await resolveStudentId(req) : null;
    const userId = isStudentRole(req) ? null : getRequestUserId(req);
    const notification = await markNotificationRead(req.params.id, studentId, userId);
    if (!notification) return res.status(404).json({ message: "Notification not found" });
    res.status(200).json(notification);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getFeeDueReport = async (req, res) => {
  try {
    if (denyUnlessInstitutionAdmin(req, res)) return;

    processDailyFeeDueReportNotifications().catch(() => {});
    const report = await buildFeeDueReport(req.query.date || undefined);
    res.status(200).json(report);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const markAllAsRead = async (req, res) => {
  try {
    const filter = {};
    if (isStudentRole(req)) {
      filter.recipient_student = await resolveStudentId(req);
    } else {
      filter.recipient_user = getRequestUserId(req);
    }
    await Notification.updateMany(filter, { is_read: true, read_at: new Date() });
    res.status(200).json({ message: "All notifications marked as read" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

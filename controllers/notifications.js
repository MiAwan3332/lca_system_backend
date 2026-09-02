import Notification from "../models/notifications.js";
import moment from "moment-timezone";
import {
  isStudentRole,
  resolveStudentId,
  getRequestUserId,
  isInstitutionAdmin,
  denyUnlessInstitutionAdmin,
} from "../utils/lmsAccess.js";
import { markNotificationRead } from "../utils/notificationService.js";
import { processInstallmentReminders } from "../utils/feeInstallmentReminders.js";
import {
  buildFeeDueReport,
  processDailyFeeDueReportNotifications,
} from "../utils/feeDueReport.js";

/**
 * Every role only sees notifications addressed to them.
 * Students: recipient_student or recipient_user.
 * Staff / teachers / others: recipient_user.
 */
const noNotificationsFilter = { _id: null };

const buildRecipientFilter = async (req) => {
  const userId = getRequestUserId(req);

  if (isStudentRole(req)) {
    const studentId = await resolveStudentId(req);
    const or = [];
    if (studentId) or.push({ recipient_student: studentId });
    if (userId) or.push({ recipient_user: userId });
    if (!or.length) return noNotificationsFilter;
    return or.length === 1 ? or[0] : { $or: or };
  }

  if (!userId) return noNotificationsFilter;
  return { recipient_user: userId };
};

export const getNotifications = async (req, res) => {
  try {
    processInstallmentReminders().catch(() => {});
    if (isInstitutionAdmin(req)) {
      processDailyFeeDueReportNotifications().catch(() => {});
    }

    const baseFilter = await buildRecipientFilter(req);
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

    res.status(200).json({
      ...notifications,
      unreadCount,
      scope: "related",
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const markAsRead = async (req, res) => {
  try {
    const studentId = isStudentRole(req) ? await resolveStudentId(req) : null;
    const userId = getRequestUserId(req);
    const notification = await markNotificationRead(
      req.params.id,
      studentId,
      userId,
      { unrestricted: false }
    );
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
    const filter = await buildRecipientFilter(req);
    await Notification.updateMany(filter, {
      is_read: true,
      read_at: new Date(),
    });
    res.status(200).json({ message: "All notifications marked as read" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

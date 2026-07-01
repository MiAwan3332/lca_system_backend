import Notification from "../models/notifications.js";
import {
  isStudentRole,
  resolveStudentId,
  getRequestUserId,
} from "../utils/lmsAccess.js";
import { markNotificationRead } from "../utils/notificationService.js";

export const getNotifications = async (req, res) => {
  try {
    const filter = { is_read: req.query.unread_only === "true" ? false : undefined };
    if (filter.is_read === undefined) delete filter.is_read;

    if (isStudentRole(req)) {
      filter.recipient_student = await resolveStudentId(req);
    } else {
      filter.recipient_user = getRequestUserId(req);
    }

    const notifications = await Notification.paginate(filter, {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 20,
      sort: { createdAt: -1 },
    });

    res.status(200).json(notifications);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const markAsRead = async (req, res) => {
  try {
    const studentId = isStudentRole(req) ? await resolveStudentId(req) : null;
    const userId = getRequestUserId(req);
    const notification = await markNotificationRead(req.params.id, studentId, userId);
    if (!notification) return res.status(404).json({ message: "Notification not found" });
    res.status(200).json(notification);
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

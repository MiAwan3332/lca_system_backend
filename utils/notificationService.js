import Notification from "../models/notifications.js";
import Student from "../models/students.js";

export const createNotification = async ({
  recipientUserId,
  recipientStudentId,
  type,
  title,
  message,
  entityType,
  entityId,
  metadata = {},
}) => {
  return Notification.create({
    recipient_user: recipientUserId || undefined,
    recipient_student: recipientStudentId || undefined,
    type,
    title,
    message,
    entity_type: entityType,
    entity_id: entityId,
    metadata,
  });
};

export const notifyBatchStudents = async ({
  batchId,
  type,
  title,
  message,
  entityType,
  entityId,
  metadata = {},
}) => {
  const students = await Student.find({ batch: batchId }).select("_id user");
  const notifications = students.map((student) => ({
    recipient_student: student._id,
    recipient_user: student.user || undefined,
    type,
    title,
    message,
    entity_type: entityType,
    entity_id: entityId,
    metadata,
  }));
  if (!notifications.length) return [];
  return Notification.insertMany(notifications);
};

export const markNotificationRead = async (
  notificationId,
  studentId,
  userId,
  { unrestricted = false } = {}
) => {
  const filter = { _id: notificationId };
  if (!unrestricted) {
    const or = [];
    if (studentId) or.push({ recipient_student: studentId });
    if (userId) or.push({ recipient_user: userId });
    if (or.length === 1) {
      Object.assign(filter, or[0]);
    } else if (or.length > 1) {
      filter.$or = or;
    } else {
      return null;
    }
  }
  return Notification.findOneAndUpdate(
    filter,
    { is_read: true, read_at: new Date() },
    { new: true }
  );
};

export const markAnnouncementReadForStudent = async (studentId, announcementId) => {
  if (!studentId || !announcementId) return null;
  return Notification.findOneAndUpdate(
    {
      recipient_student: studentId,
      type: "announcement",
      entity_id: announcementId,
    },
    { is_read: true, read_at: new Date() },
    { new: true }
  );
};

import Announcement from "../models/announcements.js";
import Batch from "../models/batches.js";
import {
  canManageLmsContent,
  getRequestUserId,
  getStudentBatchId,
  isFullAccessRole,
  isInstitutionAdmin,
  buildEmptyPaginatedResponse,
} from "../utils/lmsAccess.js";
import { isStudentRole, resolveStudentId } from "../utils/studentScope.js";
import { isTeacherRole, getTeacherScope } from "../utils/teacherScope.js";
import Notification from "../models/notifications.js";
import {
  notifyBatchStudents,
  markAnnouncementReadForStudent,
} from "../utils/notificationService.js";

const populateOptions = [
  { path: "batches", select: "name batch_type is_active" },
  { path: "created_by", select: "name email role" },
];

const validateBatchAccess = async (req, batchIds = []) => {
  if (!batchIds.length) {
    return { ok: false, message: "Select at least one batch" };
  }

  const uniqueIds = [...new Set(batchIds.map(String))];
  const batches = await Batch.find({ _id: { $in: uniqueIds } }).select("_id name");
  if (batches.length !== uniqueIds.length) {
    return { ok: false, message: "One or more selected batches were not found" };
  }

  if (isFullAccessRole(req) || isInstitutionAdmin(req)) {
    return { ok: true, batchIds: uniqueIds };
  }

  if (isTeacherRole(req)) {
    const scope = await getTeacherScope(req);
    const allowed = new Set((scope?.batchIds || []).map(String));
    const unauthorized = uniqueIds.filter((id) => !allowed.has(id));
    if (unauthorized.length) {
      return {
        ok: false,
        message: "You can only send announcements to your assigned batches",
      };
    }
    return { ok: true, batchIds: uniqueIds };
  }

  return { ok: false, message: "Access denied" };
};

const buildListFilter = async (req, query = {}) => {
  const filter = {};
  const { batch_id, query: searchQuery } = query;

  if (isStudentRole(req)) {
    const studentBatchId = await getStudentBatchId(req);
    if (!studentBatchId) {
      return { denied: false, empty: true };
    }
    filter.batches = studentBatchId;
  } else if (isTeacherRole(req) && !isFullAccessRole(req)) {
    const scope = await getTeacherScope(req);
    if (!scope?.batchIds?.length) {
      return { denied: false, empty: true };
    }
    filter.batches = { $in: scope.batchIds };
  }

  if (batch_id) {
    filter.batches = batch_id;
  }

  if (searchQuery) {
    filter.$or = [
      { title: { $regex: searchQuery, $options: "i" } },
      { message: { $regex: searchQuery, $options: "i" } },
    ];
  }

  return { denied: false, empty: false, filter };
};

const dispatchAnnouncementNotifications = async (announcement, batchIds) => {
  let recipientCount = 0;

  for (const batchId of batchIds) {
    const created = await notifyBatchStudents({
      batchId,
      type: "announcement",
      title: announcement.title,
      message: announcement.message,
      entityType: "announcement",
      entityId: announcement._id,
      metadata: { batch_id: batchId },
    });
    recipientCount += created.length;
  }

  announcement.recipient_count = recipientCount;
  await announcement.save();
  return recipientCount;
};

export const getAnnouncements = async (req, res) => {
  try {
    const listContext = await buildListFilter(req, req.query);
    if (listContext.denied) {
      return res.status(403).json({ message: "Access denied" });
    }

    if (listContext.empty) {
      return res.status(200).json(buildEmptyPaginatedResponse(parseInt(req.query.limit, 10) || 10));
    }

    const announcements = await Announcement.paginate(listContext.filter, {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 10,
      sort: { createdAt: -1 },
      populate: populateOptions,
    });

    if (isStudentRole(req)) {
      const studentId = await resolveStudentId(req);
      if (studentId && announcements.docs?.length) {
        const announcementIds = announcements.docs.map((doc) => doc._id);
        const readStates = await Notification.find({
          recipient_student: studentId,
          type: "announcement",
          entity_id: { $in: announcementIds },
        }).select("entity_id is_read");

        const readMap = Object.fromEntries(
          readStates.map((item) => [String(item.entity_id), item.is_read])
        );

        announcements.docs = announcements.docs.map((doc) => {
          const plain = doc.toObject ? doc.toObject() : doc;
          return {
            ...plain,
            is_read: readMap[String(doc._id)] ?? false,
          };
        });
      }
    }

    res.status(200).json(announcements);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getAnnouncementById = async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id).populate(populateOptions);
    if (!announcement) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    if (isStudentRole(req)) {
      const studentBatchId = await getStudentBatchId(req);
      const batchIds = announcement.batches.map((b) => String(b._id || b));
      if (!studentBatchId || !batchIds.includes(String(studentBatchId))) {
        return res.status(403).json({ message: "Access denied" });
      }
      const studentId = await resolveStudentId(req);
      await markAnnouncementReadForStudent(studentId, announcement._id);
      const plain = announcement.toObject();
      plain.is_read = true;
      return res.status(200).json(plain);
    } else if (isTeacherRole(req) && !isFullAccessRole(req)) {
      const scope = await getTeacherScope(req);
      const allowed = new Set((scope?.batchIds || []).map(String));
      const hasAccess = announcement.batches.some((batch) =>
        allowed.has(String(batch._id || batch))
      );
      if (!hasAccess) {
        return res.status(403).json({ message: "Access denied" });
      }
    }

    res.status(200).json(announcement);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createAnnouncement = async (req, res) => {
  try {
    if (!canManageLmsContent(req)) {
      return res.status(403).json({ message: "You do not have permission to send announcements" });
    }

    const { title, message, batch_ids: batchIds } = req.body;
    if (!title?.trim() || !message?.trim()) {
      return res.status(400).json({ message: "Title and message are required" });
    }

    const access = await validateBatchAccess(req, batchIds || []);
    if (!access.ok) {
      return res.status(400).json({ message: access.message });
    }

    const announcement = await Announcement.create({
      title: title.trim(),
      message: message.trim(),
      batches: access.batchIds,
      created_by: getRequestUserId(req),
    });

    await dispatchAnnouncementNotifications(announcement, access.batchIds);

    const populated = await Announcement.findById(announcement._id).populate(populateOptions);
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateAnnouncement = async (req, res) => {
  try {
    if (!canManageLmsContent(req)) {
      return res.status(403).json({ message: "You do not have permission to update announcements" });
    }

    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    const userId = getRequestUserId(req);
    const isOwner = String(announcement.created_by) === String(userId);
    const canUpdate = isFullAccessRole(req) || isInstitutionAdmin(req) || isOwner;

    if (!canUpdate) {
      return res.status(403).json({ message: "You cannot update this announcement" });
    }

    const { title, message, batch_ids: batchIds } = req.body;
    if (!title?.trim() || !message?.trim()) {
      return res.status(400).json({ message: "Title and message are required" });
    }

    const access = await validateBatchAccess(req, batchIds || []);
    if (!access.ok) {
      return res.status(400).json({ message: access.message });
    }

    const oldBatchIds = announcement.batches.map((id) => String(id));
    const newBatchIds = access.batchIds;

    announcement.title = title.trim();
    announcement.message = message.trim();
    announcement.batches = newBatchIds;
    await announcement.save();

    await Notification.updateMany(
      { entity_id: announcement._id, type: "announcement" },
      { title: announcement.title, message: announcement.message }
    );

    const addedBatchIds = newBatchIds.filter((id) => !oldBatchIds.includes(String(id)));
    for (const batchId of addedBatchIds) {
      await notifyBatchStudents({
        batchId,
        type: "announcement",
        title: announcement.title,
        message: announcement.message,
        entityType: "announcement",
        entityId: announcement._id,
        metadata: { batch_id: batchId },
      });
    }

    const recipientCount = await Notification.countDocuments({
      entity_id: announcement._id,
      type: "announcement",
    });
    announcement.recipient_count = recipientCount;
    await announcement.save();

    const populated = await Announcement.findById(announcement._id).populate(populateOptions);
    res.status(200).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    const userId = getRequestUserId(req);
    const isOwner = String(announcement.created_by) === String(userId);
    const canDelete = isFullAccessRole(req) || isInstitutionAdmin(req) || isOwner;

    if (!canDelete) {
      return res.status(403).json({ message: "You cannot delete this announcement" });
    }

    await Notification.deleteMany({
      entity_id: announcement._id,
      type: "announcement",
    });
    await Announcement.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "Announcement deleted", _id: req.params.id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const markAnnouncementAsRead = async (req, res) => {
  try {
    if (!isStudentRole(req)) {
      return res.status(403).json({ message: "Only students can mark announcements as read" });
    }

    const studentId = await resolveStudentId(req);
    if (!studentId) {
      return res.status(404).json({ message: "Student profile not found" });
    }

    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    const studentBatchId = await getStudentBatchId(req);
    const batchIds = announcement.batches.map((id) => String(id));
    if (!studentBatchId || !batchIds.includes(String(studentBatchId))) {
      return res.status(403).json({ message: "Access denied" });
    }

    const notification = await markAnnouncementReadForStudent(studentId, announcement._id);
    res.status(200).json({
      announcement_id: announcement._id,
      notification_id: notification?._id || null,
      is_read: true,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

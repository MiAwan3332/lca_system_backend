import Complaint from "../models/complaints.js";
import Batch from "../models/batches.js";
import Student from "../models/students.js";
import {
  buildComplaintListFilter,
  canViewComplaint,
  COMPLAINT_STATUSES,
  findUsersByComplaintTarget,
  getAllowedTargetsForSubmitter,
  getComplaintTargetLabel,
  getUserComplaintInboxRole,
  normalizeComplaintTarget,
} from "../utils/complaintAccess.js";
import { isFullAccessRole } from "../utils/lmsAccess.js";
import { isStudentRole, resolveStudentId } from "../utils/studentScope.js";
import { createNotification } from "../utils/notificationService.js";

const populateOptions = [
  { path: "submitted_by", select: "name email role" },
  { path: "submitted_by_student", select: "name email batch", populate: { path: "batch", select: "name" } },
  { path: "responded_by", select: "name email role" },
];

const notifyComplaintRecipients = async (complaint) => {
  const title = "New Complaint Received";
  const message = `${complaint.subject} — submitted for ${getComplaintTargetLabel(complaint.target_role)}`;

  if (complaint.target_role === "teacher" && complaint.submitted_by_student) {
    const studentId =
      complaint.submitted_by_student._id || complaint.submitted_by_student;
    const student = await Student.findById(studentId);
    if (!student?.batch) return;

    const batch = await Batch.findById(student.batch).populate({
      path: "teachers",
      populate: { path: "user", select: "_id" },
    });

    const teacherUsers = (batch?.teachers || [])
      .map((teacher) => teacher?.user?._id || teacher?.user)
      .filter(Boolean);

    await Promise.all(
      teacherUsers.map((recipientUserId) =>
        createNotification({
          recipientUserId,
          type: "complaint_received",
          title,
          message,
          entityType: "complaint",
          entityId: complaint._id,
        })
      )
    );
    return;
  }

  const recipients = await findUsersByComplaintTarget(complaint.target_role);
  await Promise.all(
    recipients.map((user) =>
      createNotification({
        recipientUserId: user._id,
        type: "complaint_received",
        title,
        message,
        entityType: "complaint",
        entityId: complaint._id,
      })
    )
  );
};

export const getComplaintMeta = async (req, res) => {
  try {
    const allowedTargets = getAllowedTargetsForSubmitter(req).map((target) => ({
      value: target,
      label: getComplaintTargetLabel(target),
    }));

    res.status(200).json({
      allowed_targets: allowedTargets,
      statuses: COMPLAINT_STATUSES,
      inbox_role: getUserComplaintInboxRole(req),
      can_view_inbox: Boolean(getUserComplaintInboxRole(req) || isFullAccessRole(req)),
      can_view_all: isFullAccessRole(req),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getComplaints = async (req, res) => {
  try {
    const listContext = await buildComplaintListFilter(req, req.query);
    if (listContext.denied) {
      return res.status(403).json({ message: "Access denied" });
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;

    const complaints = await Complaint.paginate(listContext.filter, {
      page,
      limit,
      sort: { createdAt: -1 },
      populate: populateOptions,
    });

    res.status(200).json(complaints);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getComplaintById = async (req, res) => {
  try {
    const complaint = await Complaint.findById(req.params.id).populate(populateOptions);
    if (!complaint) return res.status(404).json({ message: "Complaint not found" });

    if (!(await canViewComplaint(req, complaint))) {
      return res.status(403).json({ message: "Access denied" });
    }

    res.status(200).json(complaint);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createComplaint = async (req, res) => {
  try {
    const { subject, description, category, target_role } = req.body;
    const normalizedTarget = normalizeComplaintTarget(target_role);
    const allowedTargets = getAllowedTargetsForSubmitter(req);

    if (!subject?.trim() || !description?.trim()) {
      return res.status(400).json({ message: "Subject and description are required" });
    }
    if (!allowedTargets.includes(normalizedTarget)) {
      return res.status(400).json({ message: "Invalid recipient role for your account" });
    }

    const payload = {
      subject: subject.trim(),
      description: description.trim(),
      category: category || "General",
      target_role: normalizedTarget,
      submitted_by: req.user.user.id,
      submitter_role: req.user.user.role,
      status: "Open",
    };

    if (isStudentRole(req)) {
      payload.submitted_by_student = await resolveStudentId(req);
    }

    const complaint = await Complaint.create(payload);
    const populated = await Complaint.findById(complaint._id).populate(populateOptions);

    await notifyComplaintRecipients(populated);

    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const respondToComplaint = async (req, res) => {
  try {
    const { status, response } = req.body;
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) return res.status(404).json({ message: "Complaint not found" });

    const isSubmitter = String(complaint.submitted_by) === String(req.user.user.id);

    if (!isFullAccessRole(req)) {
      if (isSubmitter) {
        return res.status(403).json({ message: "You cannot respond to your own complaint" });
      }
      if (!(await canViewComplaint(req, complaint))) {
        return res.status(403).json({ message: "Access denied" });
      }
    }

    if (status && !COMPLAINT_STATUSES.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    if (status) complaint.status = status;
    if (response !== undefined) complaint.response = response;
    complaint.responded_by = req.user.user.id;
    complaint.responded_at = new Date();

    await complaint.save();

    const populated = await Complaint.findById(complaint._id).populate(populateOptions);

    if (populated.submitted_by?._id || populated.submitted_by) {
      await createNotification({
        recipientUserId: populated.submitted_by._id || populated.submitted_by,
        recipientStudentId: populated.submitted_by_student?._id || populated.submitted_by_student,
        type: "complaint_updated",
        title: "Complaint Updated",
        message: `Your complaint "${populated.subject}" is now ${populated.status}.`,
        entityType: "complaint",
        entityId: populated._id,
      });
    }

    res.status(200).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteComplaint = async (req, res) => {
  try {
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) return res.status(404).json({ message: "Complaint not found" });

    const isSubmitter = String(complaint.submitted_by) === String(req.user.user.id);
    if (!isFullAccessRole(req) && !isSubmitter) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (!isFullAccessRole(req) && complaint.status !== "Open") {
      return res.status(400).json({ message: "Only open complaints can be deleted" });
    }

    await Complaint.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "Complaint deleted", _id: complaint._id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

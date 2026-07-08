import path from "path";
import Assignment from "../models/assignments.js";
import AssignmentSubmission from "../models/assignmentSubmissions.js";
import Batch from "../models/batches.js";
import { uploadFile } from "../utils/fileStorage.js";
import {
  computeAssignmentSubmissionStatus,
  isAssignmentVisibleToStudent,
} from "../utils/assignmentHelpers.js";
import {
  canAccessBatch,
  canAccessCourse,
  canManageLmsContent,
  courseInBatch,
  denyUnlessCanManage,
  getStudentBatchId,
  isStudentRole,
  resolveStudentId,
  resolveStudentRecord,
  studentInBatch,
  isTeacherRole,
  getTeacherScope,
} from "../utils/lmsAccess.js";
import { notifyBatchStudents, createNotification } from "../utils/notificationService.js";

const populateOptions = [
  { path: "batch", select: "name" },
  { path: "course", select: "name" },
  { path: "created_by", select: "name email" },
];

const submissionPopulate = [
  { path: "assignment", populate: populateOptions },
  { path: "student", select: "name email batch" },
  { path: "graded_by", select: "name email" },
];

const uploadAssignmentFiles = async (files = []) => {
  const filesStorageUrl = process.env.FILES_STORAGE_URL;
  const filesStoragePath = process.env.FILES_STORAGE_PATH;
  const uploaded = [];

  for (const file of files) {
    const fileName = `${Date.now()}-${file.name}`;
    await uploadFile(file, fileName, `${filesStoragePath}/assignments/attachments`);
    uploaded.push({
      file_name: file.name,
      file_url: `${filesStorageUrl}/files/assignments/attachments/${fileName}`,
      file_type: file.mimetype,
      file_size: file.size,
    });
  }
  return uploaded;
};

const uploadSubmissionFiles = async (files = [], studentId) => {
  const filesStorageUrl = process.env.FILES_STORAGE_URL;
  const filesStoragePath = process.env.FILES_STORAGE_PATH;
  const uploaded = [];

  for (const file of files) {
    const fileName = `${Date.now()}-${file.name}`;
    await uploadFile(
      file,
      fileName,
      `${filesStoragePath}/assignments/submissions/${studentId}`
    );
    uploaded.push({
      file_name: file.name,
      file_url: `${filesStorageUrl}/files/assignments/submissions/${studentId}/${fileName}`,
      file_type: file.mimetype,
      file_size: file.size,
    });
  }
  return uploaded;
};

const parseAssignmentBody = (body) => {
  const payload = { ...body };
  if (typeof payload.attachments === "string") {
    try {
      payload.attachments = JSON.parse(payload.attachments);
    } catch {
      payload.attachments = [];
    }
  }
  payload.has_deadline = payload.has_deadline === true || payload.has_deadline === "true";
  payload.resubmission_allowed =
    payload.resubmission_allowed === true || payload.resubmission_allowed === "true";
  if (payload.max_marks) payload.max_marks = Number(payload.max_marks);
  if (payload.max_attempts) payload.max_attempts = Number(payload.max_attempts);
  if (payload.late_penalty_percent) {
    payload.late_penalty_percent = Number(payload.late_penalty_percent);
  }
  return payload;
};

export const createAssignment = async (req, res) => {
  if (denyUnlessCanManage(req, res)) return;

  try {
    const payload = parseAssignmentBody(req.body);
    if (!(await canAccessBatch(req, payload.batch))) {
      return res.status(403).json({ message: "You cannot create assignments for this batch" });
    }
    if (!(await courseInBatch(payload.batch, payload.course))) {
      return res.status(400).json({ message: "Course does not belong to selected batch" });
    }
    if (!(await canAccessCourse(req, payload.course, payload.batch))) {
      return res.status(403).json({ message: "You can only create assignments for your assigned courses" });
    }

    const newFiles = req.files?.attachments
      ? Array.isArray(req.files.attachments)
        ? req.files.attachments
        : [req.files.attachments]
      : [];
    const attachments = await uploadAssignmentFiles(newFiles);

    const assignment = await Assignment.create({
      ...payload,
      attachments: [...(payload.attachments || []), ...attachments],
      created_by: req.user.user.id,
      status: payload.visibility_status === "Published" ? "Published" : "Draft",
      published_at: payload.visibility_status === "Published" ? new Date() : null,
    });

    const populated = await Assignment.findById(assignment._id).populate(populateOptions);

    if (assignment.visibility_status === "Published") {
      await notifyBatchStudents({
        batchId: assignment.batch,
        type: "assignment_published",
        title: "New Assignment Published",
        message: `${assignment.title} is now available.`,
        entityType: "assignment",
        entityId: assignment._id,
      });
    }

    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getAssignments = async (req, res) => {
  try {
    const filter = {};
    const { batch_id, course_id, status, visibility_status, query } = req.query;

    if (batch_id) filter.batch = batch_id;
    if (course_id) filter.course = course_id;
    if (status) filter.status = status;
    if (visibility_status) filter.visibility_status = visibility_status;

    if (isStudentRole(req)) {
      const batchId = await getStudentBatchId(req);
      if (!batchId) return res.status(200).json({ docs: [], totalDocs: 0 });
      filter.batch = batchId;
      filter.visibility_status = "Published";
      filter.status = "Published";
    } else if (!canManageLmsContent(req)) {
      return res.status(403).json({ message: "Access denied" });
    } else if (isTeacherRole(req)) {
      const scope = await getTeacherScope(req);
      if (!scope?.batchIds?.length) {
        return res.status(200).json({ docs: [], totalDocs: 0, page: 1, limit: 10 });
      }
      if (batch_id) {
        filter.batch = scope.batchIds.includes(String(batch_id)) ? batch_id : { $in: [] };
      } else {
        filter.batch = { $in: scope.batchIds };
      }
      if (course_id) {
        filter.course = scope.courseIds.includes(String(course_id)) ? course_id : { $in: [] };
      } else {
        filter.course = { $in: scope.courseIds };
      }
    }

    if (query) {
      filter.$or = [
        { title: { $regex: query, $options: "i" } },
        { description: { $regex: query, $options: "i" } },
      ];
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;

    const assignments = await Assignment.paginate(filter, {
      page,
      limit,
      sort: { createdAt: -1 },
      populate: populateOptions,
    });

    if (isStudentRole(req)) {
      assignments.docs = assignments.docs.filter((item) =>
        isAssignmentVisibleToStudent(item)
      );
    }

    res.status(200).json(assignments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getAssignmentById = async (req, res) => {
  try {
    const assignment = await Assignment.findById(req.params.id).populate(populateOptions);
    if (!assignment) return res.status(404).json({ message: "Assignment not found" });

    if (isStudentRole(req)) {
      const allowed =
        (await studentInBatch(req, assignment.batch._id || assignment.batch)) &&
        isAssignmentVisibleToStudent(assignment);
      if (!allowed) return res.status(403).json({ message: "Assignment not available" });
    } else if (!(await canAccessBatch(req, assignment.batch._id || assignment.batch))) {
      return res.status(403).json({ message: "Access denied" });
    }

    res.status(200).json(assignment);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateAssignment = async (req, res) => {
  if (denyUnlessCanManage(req, res)) return;

  try {
    const assignment = await Assignment.findById(req.params.id);
    if (!assignment) return res.status(404).json({ message: "Assignment not found" });
    if (!(await canAccessBatch(req, assignment.batch))) {
      return res.status(403).json({ message: "Access denied" });
    }

    const payload = parseAssignmentBody(req.body);
    const targetBatch = payload.batch || assignment.batch;
    const targetCourse = payload.course || assignment.course;
    if (!(await canAccessCourse(req, targetCourse, targetBatch))) {
      return res.status(403).json({ message: "You can only update assignments for your assigned courses" });
    }

    const newFiles = req.files?.attachments
      ? Array.isArray(req.files.attachments)
        ? req.files.attachments
        : [req.files.attachments]
      : [];
    const attachments = await uploadAssignmentFiles(newFiles);

    const wasDraft = assignment.visibility_status !== "Published";
    Object.assign(assignment, payload);
    if (payload.attachments || attachments.length) {
      assignment.attachments = [...(payload.attachments || assignment.attachments), ...attachments];
    }
    if (payload.visibility_status === "Published" && wasDraft) {
      assignment.status = "Published";
      assignment.published_at = new Date();
      await notifyBatchStudents({
        batchId: assignment.batch,
        type: "assignment_published",
        title: "New Assignment Published",
        message: `${assignment.title} is now available.`,
        entityType: "assignment",
        entityId: assignment._id,
      });
    }
    await assignment.save();
    const populated = await Assignment.findById(assignment._id).populate(populateOptions);
    res.status(200).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteAssignment = async (req, res) => {
  if (denyUnlessCanManage(req, res)) return;

  try {
    const assignment = await Assignment.findById(req.params.id);
    if (!assignment) return res.status(404).json({ message: "Assignment not found" });
    if (!(await canAccessBatch(req, assignment.batch))) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (!(await canAccessCourse(req, assignment.course, assignment.batch))) {
      return res.status(403).json({ message: "Access denied" });
    }

    await Assignment.findByIdAndDelete(req.params.id);
    await AssignmentSubmission.deleteMany({ assignment: assignment._id });
    res.status(200).json({ message: "Assignment deleted", _id: assignment._id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const publishAssignment = async (req, res) => {
  if (denyUnlessCanManage(req, res)) return;

  try {
    const assignment = await Assignment.findById(req.params.id);
    if (!assignment) return res.status(404).json({ message: "Assignment not found" });
    if (!(await canAccessBatch(req, assignment.batch))) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (!(await canAccessCourse(req, assignment.course, assignment.batch))) {
      return res.status(403).json({ message: "Access denied" });
    }

    assignment.visibility_status = "Published";
    assignment.status = "Published";
    assignment.published_at = new Date();
    await assignment.save();

    await notifyBatchStudents({
      batchId: assignment.batch,
      type: "assignment_published",
      title: "New Assignment Published",
      message: `${assignment.title} is now available.`,
      entityType: "assignment",
      entityId: assignment._id,
    });

    const populated = await Assignment.findById(assignment._id).populate(populateOptions);
    res.status(200).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const submitAssignment = async (req, res) => {
  try {
    const studentId = await resolveStudentId(req);
    if (!studentId) return res.status(403).json({ message: "Student account required" });

    const assignment = await Assignment.findById(req.params.id);
    if (!assignment) return res.status(404).json({ message: "Assignment not found" });
    if (!isAssignmentVisibleToStudent(assignment)) {
      return res.status(403).json({ message: "Assignment is not available" });
    }
    if (!(await studentInBatch(req, assignment.batch))) {
      return res.status(403).json({ message: "Assignment not assigned to your batch" });
    }

    const existingCount = await AssignmentSubmission.countDocuments({
      assignment: assignment._id,
      student: studentId,
    });

    const nextAttempt = existingCount + 1;
    if (nextAttempt > assignment.max_attempts) {
      return res.status(400).json({ message: "Maximum submission attempts reached" });
    }

    const latest = await AssignmentSubmission.findOne({
      assignment: assignment._id,
      student: studentId,
    }).sort({ attempt_number: -1 });

    if (
      latest &&
      !assignment.resubmission_allowed &&
      ["Submitted", "Late Submitted", "Under Review", "Graded", "Completed"].includes(
        latest.status
      )
    ) {
      return res.status(400).json({ message: "Resubmission is not allowed for this assignment" });
    }

    const submittedAt = new Date();
    const lateInfo = computeAssignmentSubmissionStatus(assignment, submittedAt);
    if (lateInfo.blocked) {
      return res.status(400).json({ message: "Late submissions are not allowed" });
    }

    const submissionFiles = req.files?.submission_files
      ? Array.isArray(req.files.submission_files)
        ? req.files.submission_files
        : [req.files.submission_files]
      : [];

    if (!submissionFiles.length && !req.body.submission_text) {
      return res.status(400).json({ message: "Please upload a file or provide submission text" });
    }

    const files = await uploadSubmissionFiles(submissionFiles, studentId);
    const submission = await AssignmentSubmission.create({
      assignment: assignment._id,
      student: studentId,
      attempt_number: nextAttempt,
      files,
      submission_text: req.body.submission_text || "",
      status: lateInfo.status,
      is_late: lateInfo.isLate,
      submitted_at: submittedAt,
    });

    const populated = await AssignmentSubmission.findById(submission._id).populate(submissionPopulate);
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getAssignmentSubmissions = async (req, res) => {
  try {
    const filter = {};
    const { assignment_id, batch_id, course_id, status } = req.query;

    if (assignment_id) filter.assignment = assignment_id;
    if (status) filter.status = status;

    if (isStudentRole(req)) {
      const studentId = await resolveStudentId(req);
      filter.student = studentId;
    } else if (denyUnlessCanManage(req, res)) {
      return;
    } else {
      if (assignment_id) {
        const assignment = await Assignment.findById(assignment_id);
        if (!assignment) return res.status(404).json({ message: "Assignment not found" });
        if (!(await canAccessBatch(req, assignment.batch))) {
          return res.status(403).json({ message: "Access denied" });
        }
        if (!(await canAccessCourse(req, assignment.course, assignment.batch))) {
          return res.status(403).json({ message: "Access denied" });
        }
      } else {
        const assignmentFilter = {};

        if (isTeacherRole(req)) {
          const scope = await getTeacherScope(req);
          if (!scope?.batchIds?.length) {
            return res.status(200).json({ docs: [], totalDocs: 0, page: 1, limit: 10 });
          }
          assignmentFilter.batch = { $in: scope.batchIds };
          assignmentFilter.course = { $in: scope.courseIds };
        }

        if (batch_id) {
          if (isTeacherRole(req)) {
            const scope = await getTeacherScope(req);
            if (!scope.batchIds.includes(String(batch_id))) {
              return res.status(403).json({ message: "Access denied" });
            }
          }
          assignmentFilter.batch = batch_id;
        }

        if (course_id) {
          if (isTeacherRole(req)) {
            const scope = await getTeacherScope(req);
            if (!scope.courseIds.includes(String(course_id))) {
              return res.status(403).json({ message: "Access denied" });
            }
          }
          assignmentFilter.course = course_id;
        }

        const scopedAssignments = await Assignment.find(assignmentFilter).select("_id");
        const assignmentIds = scopedAssignments.map((item) => item._id);
        if (!assignmentIds.length) {
          return res.status(200).json({ docs: [], totalDocs: 0, page: 1, limit: 10 });
        }
        filter.assignment = { $in: assignmentIds };
      }
    }

    const submissions = await AssignmentSubmission.paginate(filter, {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 10,
      sort: { createdAt: -1 },
      populate: submissionPopulate,
    });

    res.status(200).json(submissions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const gradeSubmission = async (req, res) => {
  if (denyUnlessCanManage(req, res)) return;

  try {
    const { marks_obtained, feedback, status, resubmission_requested } = req.body;
    const submission = await AssignmentSubmission.findById(req.params.id).populate("assignment");
    if (!submission) return res.status(404).json({ message: "Submission not found" });

    const assignment = submission.assignment;
    if (!(await canAccessBatch(req, assignment.batch))) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (!(await canAccessCourse(req, assignment.course, assignment.batch))) {
      return res.status(403).json({ message: "Access denied" });
    }

    const maxMarks = Number(assignment.max_marks) || 0;
    const marksValue = Number(marks_obtained);
    if (Number.isNaN(marksValue) || marksValue < 0) {
      return res.status(400).json({ message: "Valid marks are required" });
    }
    if (maxMarks > 0 && marksValue > maxMarks) {
      return res.status(400).json({ message: `Marks cannot exceed ${maxMarks}` });
    }

    submission.marks_obtained = marksValue;
    submission.feedback = feedback || "";
    submission.graded_by = req.user.user.id;
    submission.graded_at = new Date();
    submission.resubmission_requested = resubmission_requested === true;

    if (resubmission_requested) {
      submission.status = "Resubmission Requested";
    } else if (status === "Completed") {
      submission.status = "Completed";
    } else {
      submission.status = "Graded";
    }

    await submission.save();

    await createNotification({
      recipientStudentId: submission.student,
      type: "assignment_graded",
      title: "Assignment Graded",
      message: `Your submission for ${submission.assignment?.title || "assignment"} has been graded.`,
      entityType: "submission",
      entityId: submission._id,
    });

    const populated = await AssignmentSubmission.findById(submission._id).populate(submissionPopulate);
    res.status(200).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getBatchCoursesForAssignment = async (req, res) => {
  try {
    const { batchId } = req.params;
    if (isStudentRole(req)) {
      const studentBatch = await getStudentBatchId(req);
      if (String(studentBatch) !== String(batchId)) {
        return res.status(403).json({ message: "Access denied" });
      }
    } else if (!(await canAccessBatch(req, batchId))) {
      return res.status(403).json({ message: "Access denied" });
    }

    const batch = await Batch.findById(batchId).populate("courses", "name description");
    if (!batch) return res.status(404).json({ message: "Batch not found" });

    let courses = batch.courses || [];

    if (isTeacherRole(req)) {
      const scope = await getTeacherScope(req);
      const allowedCourseIds = new Set(
        (scope?.assignments || [])
          .filter((item) => item.batchId === String(batchId))
          .map((item) => item.courseId)
      );
      courses = courses.filter((course) =>
        allowedCourseIds.has(String(course._id || course))
      );
    }

    res.status(200).json(courses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

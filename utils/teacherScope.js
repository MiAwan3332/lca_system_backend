import User from "../models/users.js";
import Teacher from "../models/teachers.js";
import Batch from "../models/batches.js";

export const isTeacherRole = (req) =>
  req.user?.user?.role?.toLowerCase?.() === "teacher";

export const getTeacherIdFromToken = (req) => req.user?.user?.teacherId || null;

export const resolveTeacherId = async (req) => {
  const tokenTeacherId = getTeacherIdFromToken(req);
  if (tokenTeacherId) {
    return String(tokenTeacherId);
  }

  const userId = req.user?.user?.id;
  if (!userId) {
    return null;
  }

  const user = await User.findById(userId);
  if (!user) {
    return null;
  }

  const teacher = await Teacher.findOne({
    $or: [{ user: userId }, { email: user.email }],
  });

  if (teacher && !teacher.user) {
    teacher.user = userId;
    await teacher.save();
  }

  return teacher?._id?.toString() || null;
};

export const resolveTeacherRecord = async (req) => {
  const teacherId = await resolveTeacherId(req);
  if (!teacherId) {
    return null;
  }
  return Teacher.findById(teacherId);
};

export const getTeacherScope = async (req) => {
  if (!isTeacherRole(req)) {
    return null;
  }

  const teacherId = await resolveTeacherId(req);
  if (!teacherId) {
    return {
      teacherId: null,
      batchIds: [],
      courseIds: [],
      assignments: [],
    };
  }

  const batches = await Batch.find({
    $or: [
      { teachers: teacherId },
      { "teacher_course_assignments.teacher": teacherId },
    ],
  }).select("courses teacher_course_assignments teachers");

  const batchIds = new Set();
  const courseIds = new Set();
  const assignments = [];

  batches.forEach((batch) => {
    const batchId = String(batch._id);
    batchIds.add(batchId);

    const courseAssignments = (batch.teacher_course_assignments || []).filter(
      (item) => String(item.teacher) === String(teacherId)
    );

    if (courseAssignments.length > 0) {
      courseAssignments.forEach((item) => {
        const courseId = String(item.course);
        courseIds.add(courseId);
        assignments.push({ batchId, courseId });
      });
      return;
    }

    if ((batch.teachers || []).some((teacher) => String(teacher) === String(teacherId))) {
      (batch.courses || []).forEach((course) => {
        const courseId = String(course._id || course);
        courseIds.add(courseId);
        assignments.push({ batchId, courseId });
      });
    }
  });

  return {
    teacherId,
    batchIds: [...batchIds],
    courseIds: [...courseIds],
    assignments,
  };
};

export const denyUnlessOwnTeacher = async (req, res, requestedTeacherId) => {
  if (!isTeacherRole(req)) {
    return true;
  }

  const ownId = await resolveTeacherId(req);
  if (!ownId || ownId !== String(requestedTeacherId)) {
    res.status(403).json({ message: "Access denied" });
    return false;
  }

  return true;
};

export const denyUnlessTeacherBatchAccess = async (req, res, batchId) => {
  if (!isTeacherRole(req)) {
    return true;
  }

  const scope = await getTeacherScope(req);
  if (!scope?.batchIds?.includes(String(batchId))) {
    res.status(403).json({ message: "You do not have access to this batch" });
    return false;
  }

  return true;
};

export const denyUnlessTeacherCourseAccess = async (req, res, courseId, batchId) => {
  if (!isTeacherRole(req)) {
    return true;
  }

  const scope = await getTeacherScope(req);
  if (!scope?.courseIds?.includes(String(courseId))) {
    res.status(403).json({ message: "You do not have access to this course" });
    return false;
  }

  if (batchId && !scope.batchIds.includes(String(batchId))) {
    res.status(403).json({ message: "You do not have access to this batch" });
    return false;
  }

  return true;
};

export const buildEmptyPaginatedResponse = (limit = 10) => ({
  docs: [],
  totalDocs: 0,
  limit: limit || 10,
  totalPages: 0,
  page: 1,
  pagingCounter: 0,
  hasPrevPage: false,
  hasNextPage: false,
  prevPage: null,
  nextPage: null,
});

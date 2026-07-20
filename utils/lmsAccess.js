import Batch from "../models/batches.js";
import Student from "../models/students.js";
import {
  isStudentRole,
  resolveStudentId,
  resolveStudentRecord,
} from "./studentScope.js";
import {
  isTeacherRole,
  resolveTeacherId,
  resolveTeacherRecord,
  getTeacherScope,
  denyUnlessOwnTeacher,
  denyUnlessTeacherBatchAccess,
  denyUnlessTeacherCourseAccess,
  buildEmptyPaginatedResponse,
} from "./teacherScope.js";

const FULL_ACCESS_ROLES = [
  "admin",
  "administrator",
  "superadmin",
  "super_admin",
  "super admin",
  "super admin development",
  "secrateadmin",
  "ceo",
];

export const getRequestRole = (req) =>
  req.user?.user?.role?.toLowerCase?.() || "";

const normalizeRole = (role) =>
  String(role || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

export const isFullAccessRole = (req) => {
  const role = normalizeRole(getRequestRole(req));
  if (!role) return false;
  const compact = role.replace(/\s+/g, "");
  return (
    FULL_ACCESS_ROLES.some((name) => normalizeRole(name) === role) ||
    compact === "ceo" ||
    compact === "secrateadmin" ||
    compact === "superadmin" ||
    compact === "administrator" ||
    compact === "admin"
  );
};

export const isInstitutionAdmin = (req) =>
  !isStudentRole(req) && !isTeacherRole(req);

export const canManageLmsContent = (req) => {
  if (isStudentRole(req)) return false;
  if (isFullAccessRole(req) || isTeacherRole(req)) return true;
  const role = normalizeRole(getRequestRole(req));
  const compact = role.replace(/\s+/g, "");
  return (
    compact === "principal" ||
    compact === "viceprincipal" ||
    role === "vice principal"
  );
};

export const getRequestUserId = (req) => req.user?.user?.id || null;

export const getManagedBatchIds = async (req) => {
  if (isFullAccessRole(req)) return null;
  if (isTeacherRole(req)) {
    const scope = await getTeacherScope(req);
    return scope?.batchIds || [];
  }
  return [];
};

export const getManagedCourseIds = async (req) => {
  if (isFullAccessRole(req)) return null;
  if (isTeacherRole(req)) {
    const scope = await getTeacherScope(req);
    return scope?.courseIds || [];
  }
  return [];
};

export const canAccessBatch = async (req, batchId) => {
  if (!batchId) return false;
  if (isFullAccessRole(req)) return true;
  const allowed = await getManagedBatchIds(req);
  if (allowed === null) return true;
  return allowed.includes(String(batchId));
};

export const canAccessCourse = async (req, courseId, batchId) => {
  if (!courseId) return false;
  if (isFullAccessRole(req)) return true;
  if (isTeacherRole(req)) {
    const scope = await getTeacherScope(req);
    if (!scope?.courseIds?.includes(String(courseId))) return false;
    if (batchId && !scope.batchIds.includes(String(batchId))) return false;
    return true;
  }
  return false;
};

export const getStudentBatchId = async (req) => {
  const student = await resolveStudentRecord(req);
  return student?.batch?._id || student?.batch || null;
};

export const studentInBatch = async (req, batchId) => {
  const studentBatchId = await getStudentBatchId(req);
  return studentBatchId && String(studentBatchId) === String(batchId);
};

export const courseInBatch = async (batchId, courseId) => {
  const batch = await Batch.findById(batchId).populate("courses");
  if (!batch) return false;
  return batch.courses.some((c) => String(c._id || c) === String(courseId));
};

export const getBatchStudents = async (batchId) => {
  return Student.find({ batch: batchId }).select("_id user name email");
};

export const denyUnlessCanManage = (req, res) => {
  if (!canManageLmsContent(req)) {
    res.status(403).json({ message: "You do not have permission to manage this content" });
    return true;
  }
  return false;
};

export const denyUnlessInstitutionAdmin = (req, res) => {
  if (!isInstitutionAdmin(req)) {
    res.status(403).json({ message: "Institution admin access required" });
    return true;
  }
  return false;
};

export const applyTeacherBatchFilter = async (req, filter = {}, field = "batch") => {
  if (!isTeacherRole(req)) {
    return filter;
  }

  const scope = await getTeacherScope(req);
  if (!scope?.batchIds?.length) {
    filter[field] = { $in: [] };
    return filter;
  }

  if (filter[field]) {
    if (!scope.batchIds.includes(String(filter[field]))) {
      filter[field] = { $in: [] };
    }
  } else {
    filter[field] = { $in: scope.batchIds };
  }

  return filter;
};

export const applyTeacherCourseFilter = async (req, filter = {}, field = "_id") => {
  if (!isTeacherRole(req)) {
    return filter;
  }

  const scope = await getTeacherScope(req);
  if (!scope?.courseIds?.length) {
    filter[field] = { $in: [] };
    return filter;
  }

  if (filter[field]) {
    if (!scope.courseIds.includes(String(filter[field]))) {
      filter[field] = { $in: [] };
    }
  } else {
    filter[field] = { $in: scope.courseIds };
  }

  return filter;
};

export {
  resolveStudentId,
  resolveStudentRecord,
  isStudentRole,
  resolveTeacherId,
  resolveTeacherRecord,
  isTeacherRole,
  getTeacherScope,
  denyUnlessOwnTeacher,
  denyUnlessTeacherBatchAccess,
  denyUnlessTeacherCourseAccess,
  buildEmptyPaginatedResponse,
};

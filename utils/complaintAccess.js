import User from "../models/users.js";
import Student from "../models/students.js";
import { isStudentRole } from "./studentScope.js";
import { isTeacherRole, getTeacherScope } from "./teacherScope.js";
import { isFullAccessRole } from "./lmsAccess.js";

export const COMPLAINT_TARGET_ROLES = {
  TEACHER: "teacher",
  PRINCIPAL: "principal",
  VICE_PRINCIPAL: "vice_principal",
  CEO: "ceo",
};

export const STUDENT_TARGETS = [
  COMPLAINT_TARGET_ROLES.TEACHER,
  COMPLAINT_TARGET_ROLES.PRINCIPAL,
  COMPLAINT_TARGET_ROLES.VICE_PRINCIPAL,
  COMPLAINT_TARGET_ROLES.CEO,
];

export const STAFF_TARGETS = [
  COMPLAINT_TARGET_ROLES.PRINCIPAL,
  COMPLAINT_TARGET_ROLES.VICE_PRINCIPAL,
  COMPLAINT_TARGET_ROLES.CEO,
];

export const COMPLAINT_STATUSES = ["Open", "In Review", "Resolved", "Rejected"];

export const normalizeComplaintTarget = (value = "") => {
  const normalized = String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["principle", "principal"].includes(normalized)) return COMPLAINT_TARGET_ROLES.PRINCIPAL;
  if (["vice_principal", "viceprincipal", "vp", "vice_principle"].includes(normalized)) {
    return COMPLAINT_TARGET_ROLES.VICE_PRINCIPAL;
  }
  if (normalized === "ceo") return COMPLAINT_TARGET_ROLES.CEO;
  if (normalized === "teacher") return COMPLAINT_TARGET_ROLES.TEACHER;
  return normalized;
};

export const getComplaintTargetLabel = (target) => {
  const labels = {
    teacher: "Teacher",
    principal: "Principal",
    vice_principal: "Vice Principal",
    ceo: "CEO",
  };
  return labels[target] || target;
};

export const getUserComplaintInboxRole = (req) => {
  const role = req.user?.user?.role || "";
  const normalized = normalizeComplaintTarget(role);
  if (Object.values(COMPLAINT_TARGET_ROLES).includes(normalized)) {
    return normalized;
  }
  return null;
};

export const getAllowedTargetsForSubmitter = (req) => {
  if (isStudentRole(req)) return STUDENT_TARGETS;
  return STAFF_TARGETS;
};

export const roleMatchesComplaintTarget = (userRole, targetRole) =>
  normalizeComplaintTarget(userRole) === normalizeComplaintTarget(targetRole);

export const findUsersByComplaintTarget = async (targetRole) => {
  const normalized = normalizeComplaintTarget(targetRole);
  const users = await User.find().select("_id name email role");
  return users.filter((user) => roleMatchesComplaintTarget(user.role, normalized));
};

export const canViewComplaint = async (req, complaint) => {
  const userId = String(req.user?.user?.id || "");
  if (!complaint) return false;
  if (isFullAccessRole(req)) return true;
  if (complaint.submitted_by && String(complaint.submitted_by._id || complaint.submitted_by) === userId) {
    return true;
  }

  const inboxRole = getUserComplaintInboxRole(req);
  if (!inboxRole || normalizeComplaintTarget(complaint.target_role) !== inboxRole) {
    return false;
  }

  if (inboxRole === COMPLAINT_TARGET_ROLES.TEACHER && isTeacherRole(req)) {
    if (!complaint.submitted_by_student) return true;
    const student = await Student.findById(
      complaint.submitted_by_student._id || complaint.submitted_by_student
    );
    if (!student?.batch) return false;
    const scope = await getTeacherScope(req);
    return scope?.batchIds?.includes(String(student.batch));
  }

  return true;
};

export const buildComplaintListFilter = async (req, query = {}) => {
  const { view = "mine", status, target_role } = query;
  const filter = {};

  if (status) filter.status = status;
  if (target_role) filter.target_role = normalizeComplaintTarget(target_role);

  if (view === "all") {
    if (!isFullAccessRole(req)) {
      return { denied: true };
    }
    return { filter };
  }

  if (view === "inbox") {
    const inboxRole = getUserComplaintInboxRole(req);
    if (!inboxRole && !isFullAccessRole(req)) {
      return { denied: true };
    }

    filter.target_role = inboxRole || undefined;

    if (inboxRole === COMPLAINT_TARGET_ROLES.TEACHER && isTeacherRole(req)) {
      const scope = await getTeacherScope(req);
      if (!scope?.batchIds?.length) {
        return { filter: { _id: { $in: [] } } };
      }
      const students = await Student.find({ batch: { $in: scope.batchIds } }).select("_id");
      filter.submitted_by_student = { $in: students.map((item) => item._id) };
    }

    return { filter };
  }

  filter.submitted_by = req.user?.user?.id;
  return { filter };
};

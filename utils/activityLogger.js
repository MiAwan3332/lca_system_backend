import ActivityLog from "../models/activityLogs.js";
import User from "../models/users.js";
import Student from "../models/students.js";
import Teacher from "../models/teachers.js";

const SENSITIVE_KEYS = new Set([
  "password",
  "confirmPassword",
  "confirm_password",
  "newPassword",
  "oldPassword",
  "token",
  "authToken",
]);

const MODULE_LABELS = {
  users: "Users",
  students: "Students",
  teachers: "Teachers",
  batches: "Batches",
  courses: "Courses",
  fees: "Fees",
  expenses: "Expenses",
  attendence: "Attendance",
  attendance: "Attendance",
  timetable: "Timetable",
  assignments: "Assignments",
  "course-quizzes": "Course Quizzes",
  quiz: "Quiz",
  mcqs: "MCQs",
  announcements: "Announcements",
  complaints: "Complaints",
  notifications: "Notifications",
  roles: "Roles",
  permissions: "Permissions",
  seminars: "Seminars",
  enrollments: "Enrollments",
  statistics: "Statistics",
  "pastPapers": "Past Papers",
  "activity-logs": "Activity Logs",
};

export const resolveActorCategory = (role = "") => {
  const normalized = String(role).toLowerCase();
  if (normalized === "student") return "student";
  if (normalized === "teacher") return "teacher";
  return "admin";
};

const sanitizePayload = (value, depth = 0) => {
  if (depth > 3 || value == null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizePayload(item, depth + 1));
  }
  if (typeof value !== "object") {
    if (typeof value === "string" && value.length > 500) {
      return `${value.slice(0, 500)}...`;
    }
    return value;
  }

  const sanitized = {};
  Object.entries(value).forEach(([key, nestedValue]) => {
    if (SENSITIVE_KEYS.has(key)) {
      sanitized[key] = "[redacted]";
      return;
    }
    sanitized[key] = sanitizePayload(nestedValue, depth + 1);
  });
  return sanitized;
};

const extractModule = (path = "") => {
  const cleaned = String(path).split("?")[0];
  const segments = cleaned.split("/").filter(Boolean);
  if (!segments.length) return "general";
  return segments[0].replace(/[^a-zA-Z0-9-_]/g, "") || "general";
};

const inferAction = (method = "GET", path = "") => {
  const lowerPath = path.toLowerCase();
  if (lowerPath.includes("/login")) return "login";
  if (lowerPath.includes("/logout")) return "logout";
  if (lowerPath.includes("/toggle-status")) return "status_change";
  if (lowerPath.includes("/delete")) return "delete";
  if (lowerPath.includes("/update") || lowerPath.includes("/change-password")) {
    return "update";
  }
  if (lowerPath.includes("/add") || lowerPath.includes("/submit")) return "create";
  if (lowerPath.includes("/read")) return "read";
  if (method === "GET") return "view";
  if (method === "POST") return "create";
  if (method === "PUT" || method === "PATCH") return "update";
  if (method === "DELETE") return "delete";
  return method.toLowerCase();
};

const buildDescription = ({ method, path, action, module, actorCategory, actorName, actorEmail }) => {
  const moduleLabel = MODULE_LABELS[module] || module;
  const actorLabel = actorName || actorEmail || `${actorCategory} user`;

  if (action === "login") {
    return `${actorLabel} logged in`;
  }

  const actionLabels = {
    view: "viewed",
    create: "created a record in",
    update: "updated a record in",
    delete: "deleted a record in",
    status_change: "changed status in",
    read: "marked as read in",
  };

  const verb = actionLabels[action] || `performed ${action} on`;
  return `${actorLabel} ${verb} ${moduleLabel} (${method} ${path})`;
};

const resolveActorDetails = async (req) => {
  const userPayload = req?.user?.user;
  if (!userPayload?.id) {
    return {
      actor_category: "admin",
      actor_user: null,
      actor_role: "",
      actor_name: "",
      actor_email: "",
      actor_student: null,
      actor_teacher: null,
    };
  }

  const user = await User.findById(userPayload.id).select("name email role");
  const actor_role = userPayload.role || user?.role || "";
  const actor_category = resolveActorCategory(actor_role);

  let actor_student = userPayload.studentId || null;
  let actor_teacher = userPayload.teacherId || null;
  let actor_name = user?.name || "";
  const actor_email = user?.email || "";

  if (actor_category === "student" && !actor_student && actor_email) {
    const student = await Student.findOne({ email: actor_email }).select("_id name");
    actor_student = student?._id || null;
    actor_name = actor_name || student?.name || "";
  }

  if (actor_category === "teacher" && !actor_teacher) {
    const teacher = await Teacher.findOne({
      $or: [{ user: userPayload.id }, { email: actor_email }],
    }).select("_id name");
    actor_teacher = teacher?._id || null;
    actor_name = actor_name || teacher?.name || "";
  }

  return {
    actor_category,
    actor_user: userPayload.id,
    actor_role,
    actor_name,
    actor_email,
    actor_student,
    actor_teacher,
  };
};

export const logActivity = async ({
  req,
  action,
  module,
  description,
  statusCode,
  targetId,
  targetType,
  metadata,
  actorOverride,
}) => {
  try {
    const path = req?.originalUrl || req?.path || "";
    if (path.includes("/activity-logs")) return;

    const method = req?.method || "GET";
    const resolvedModule = module || extractModule(path);
    const resolvedAction = action || inferAction(method, path);
    const actor = actorOverride || (await resolveActorDetails(req));

    const entry = new ActivityLog({
      ...actor,
      action: resolvedAction,
      module: resolvedModule,
      description:
        description ||
        buildDescription({
          method,
          path,
          action: resolvedAction,
          module: resolvedModule,
          actorCategory: actor.actor_category,
          actorName: actor.actor_name,
          actorEmail: actor.actor_email,
        }),
      method,
      path,
      status_code: statusCode ?? null,
      target_id: targetId ? String(targetId) : "",
      target_type: targetType || "",
      metadata: sanitizePayload(metadata ?? req?.body ?? {}),
      ip_address:
        req?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req?.ip ||
        req?.connection?.remoteAddress ||
        "",
      user_agent: req?.headers?.["user-agent"] || "",
    });

    await entry.save();
  } catch (error) {
    console.error("Activity log write failed:", error.message);
  }
};

export const attachRequestActivityLogger = (req, res) => {
  if (!req?.user?.user?.id) return;
  if (req._activityLogAttached) return;
  req._activityLogAttached = true;

  res.on("finish", () => {
    logActivity({
      req,
      statusCode: res.statusCode,
    }).catch(() => {});
  });
};

export const logLoginActivity = async ({ req, user, roleName, statusCode = 200 }) => {
  const actor_category = resolveActorCategory(roleName);
  let actor_student = null;
  let actor_teacher = null;

  if (actor_category === "student") {
    const student = await Student.findOne({ email: user.email }).select("_id");
    actor_student = student?._id || null;
  }

  if (actor_category === "teacher") {
    const teacher = await Teacher.findOne({
      $or: [{ user: user._id }, { email: user.email }],
    }).select("_id");
    actor_teacher = teacher?._id || null;
  }

  await logActivity({
    req,
    action: "login",
    module: "users",
    description: `${user.name || user.email} logged in`,
    statusCode,
    actorOverride: {
      actor_category,
      actor_user: user._id,
      actor_role: roleName,
      actor_name: user.name || "",
      actor_email: user.email || "",
      actor_student,
      actor_teacher,
    },
  });
};

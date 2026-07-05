import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { assertStudentAccountActive } from "../utils/studentScope.js";
import { attachRequestActivityLogger } from "../utils/activityLogger.js";

dotenv.config();
const JWT_SECRET = process.env.JWT_SECRET;

const auth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: "Authorization token is required" });
  }

  const [bearer, token] = authHeader.split(" ");

  if (bearer !== "Bearer" || !token) {
    return res.status(401).json({ message: "Invalid authorization header format" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;

    const role = decoded?.user?.role;
    if (role?.toLowerCase() === "student") {
      const isActive = await assertStudentAccountActive(req, res);
      if (!isActive) {
        return;
      }
    }

    const isStudentProfileUpdate =
      req.method === "POST" &&
      req.originalUrl.includes("/students/studentInfoUpdate/");
    const isStudentQuizAction =
      req.originalUrl.includes("/quiz/") &&
      ["POST", "PUT", "PATCH"].includes(req.method);
    const isStudentAssignmentAction =
      req.originalUrl.includes("/assignments/") &&
      (req.originalUrl.includes("/submit/") || req.method === "GET");
    const isStudentCourseQuizAction =
      req.originalUrl.includes("/course-quizzes/") &&
      (req.originalUrl.includes("/start") ||
        req.originalUrl.includes("/answer") ||
        req.originalUrl.includes("/submit") ||
        req.method === "GET");
    const isStudentNotificationAction =
      req.originalUrl.includes("/notifications/") &&
      (req.method === "GET" || req.originalUrl.includes("/read"));
    const isStudentComplaintAction =
      req.originalUrl.includes("/complaints/") &&
      (req.originalUrl.includes("/add") ||
        req.method === "GET" ||
        req.originalUrl.includes("/delete/"));

    if (
      role?.toLowerCase() === "student" &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      !isStudentProfileUpdate &&
      !isStudentQuizAction &&
      !isStudentAssignmentAction &&
      !isStudentCourseQuizAction &&
      !isStudentNotificationAction &&
      !isStudentComplaintAction
    ) {
      return res
        .status(403)
        .json({ message: "Students have view-only access" });
    }

    attachRequestActivityLogger(req, res);
    next();
  } catch (error) {
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Invalid or expired token" });
    }
    res.status(500).json({ message: error.message });
  }
};

export default auth;

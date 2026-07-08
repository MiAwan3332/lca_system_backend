import User from "../models/users.js";
import Student from "../models/students.js";

export const isStudentRole = (req) => {
  const role = req.user?.user?.role;
  return role?.toLowerCase() === "student";
};

export const getUserId = (req) => req.user?.user?.id;

export const getStudentIdFromToken = (req) => req.user?.user?.studentId;

export const resolveStudentId = async (req) => {
  const tokenStudentId = getStudentIdFromToken(req);
  if (tokenStudentId) {
    return tokenStudentId.toString();
  }

  const userId = getUserId(req);
  if (!userId) {
    return null;
  }

  const user = await User.findById(userId);
  if (!user) {
    return null;
  }

  const student = await Student.findOne({ email: user.email });
  return student?._id?.toString() || null;
};

export const resolveStudentRecord = async (req) => {
  const studentId = await resolveStudentId(req);
  if (!studentId) {
    return null;
  }
  return Student.findById(studentId).populate("batch");
};

export const INACTIVE_STUDENT_MESSAGE =
  "Your account is inactive. Please contact Lahore CSS Academy.";

export const assertStudentAccountActive = async (req, res) => {
  const student = await resolveStudentRecord(req);
  if (!student) {
    res.status(403).json({
      message: "Student account not found. Please contact Lahore CSS Academy.",
    });
    return false;
  }
  if (student.is_active === false) {
    res.status(403).json({ message: INACTIVE_STUDENT_MESSAGE });
    return false;
  }
  return true;
};

export const denyUnlessOwnStudent = async (req, res, requestedStudentId) => {
  if (!isStudentRole(req)) {
    return true;
  }

  const ownId = await resolveStudentId(req);
  if (!ownId || ownId !== requestedStudentId?.toString()) {
    res.status(403).json({ message: "Access denied" });
    return false;
  }

  return true;
};

export const denyUnlessOwnBatch = async (req, res, requestedBatchId) => {
  if (!isStudentRole(req)) {
    return true;
  }

  const student = await resolveStudentRecord(req);
  const ownBatchId = student?.batch?._id?.toString() || student?.batch?.toString();

  if (!ownBatchId || ownBatchId !== requestedBatchId?.toString()) {
    res.status(403).json({ message: "Access denied" });
    return false;
  }

  return true;
};

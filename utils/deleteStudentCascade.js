import mongoose from "mongoose";
import Student from "../models/students.js";
import User from "../models/users.js";
import Fee from "../models/fees.js";
import FeeLog from "../models/feeLogs.js";
import PendingFeeSlip from "../models/pendingFeeSlips.js";
import RefundRequest from "../models/refundRequests.js";
import Enrollment from "../models/enrollments.js";
import Attendence from "../models/attendence.js";
import Notification from "../models/notifications.js";
import ActivityLog from "../models/activityLogs.js";
import Complaint from "../models/complaints.js";
import AssignmentSubmission from "../models/assignmentSubmissions.js";
import QuizAttempt from "../models/quizAttempts.js";
import CourseQuizAttempt from "../models/courseQuizAttempts.js";
import InterviewPanel from "../models/interviewPanel.js";
import AdmissionSlipVerification from "../models/admissionSlipVerification.js";

const digitsOnly = (value) => String(value || "").replace(/\D/g, "");

/**
 * Permanently remove a student and all linked finance / LMS / account data.
 * Super Admin only — called from deleteStudent controller.
 */
export const deleteStudentCascade = async (studentId) => {
  if (!studentId || !mongoose.Types.ObjectId.isValid(String(studentId))) {
    throw new Error("Invalid student id");
  }

  const student = await Student.findById(studentId);
  if (!student) {
    throw new Error("Student not found");
  }

  const id = student._id;
  const email = String(student.email || "").trim();
  const phoneDigits = digitsOnly(student.phone);
  const cnic = String(student.cnic || "").trim();

  const user =
    (email
      ? await User.findOne({ email, role: "student" })
      : null) ||
    (email ? await User.findOne({ email }) : null);

  const userId = user?._id || null;

  // ── Finance ──
  const fees = await Fee.find({ student: id }).select("_id").lean();
  const feeIds = fees.map((f) => f._id);

  const [
    feeLogsDeleted,
    feesDeleted,
    pendingSlipsDeleted,
    refundsDeleted,
  ] = await Promise.all([
    FeeLog.deleteMany({
      $or: [{ student: id }, ...(feeIds.length ? [{ fee: { $in: feeIds } }] : [])],
    }),
    Fee.deleteMany({ student: id }),
    PendingFeeSlip.deleteMany({ student: id }),
    RefundRequest.deleteMany({ student: id }),
  ]);

  // ── LMS / academic ──
  const [
    enrollmentsDeleted,
    attendanceDeleted,
    assignmentSubsDeleted,
    quizAttemptsDeleted,
    courseQuizAttemptsDeleted,
  ] = await Promise.all([
    Enrollment.deleteMany({ student: id }),
    Attendence.deleteMany({ student: id }),
    AssignmentSubmission.deleteMany({ student: id }),
    QuizAttempt.deleteMany({ student: id }),
    CourseQuizAttempt.deleteMany({ student: id }),
  ]);

  // ── Notifications / activity / complaints ──
  const complaintFilter = {
    $or: [{ submitted_by_student: id }],
  };
  if (userId) {
    complaintFilter.$or.push({ submitted_by: userId });
  }

  const [
    notificationsDeleted,
    activityDeleted,
    complaintsDeleted,
  ] = await Promise.all([
    Notification.deleteMany({
      $or: [
        { recipient_student: id },
        ...(userId ? [{ recipient_user: userId }] : []),
      ],
    }),
    ActivityLog.deleteMany({
      $or: [
        { actor_student: id },
        ...(userId ? [{ actor_user: userId }] : []),
        { target_id: String(id), target_type: "Student" },
      ],
    }),
    Complaint.deleteMany(complaintFilter),
  ]);

  // ── Admission slip verification tokens (by phone / cnic / name match) ──
  const slipFilter = { $or: [] };
  if (phoneDigits.length >= 10) {
    slipFilter.$or.push({ phone: { $regex: phoneDigits.slice(-10) } });
  }
  if (cnic) {
    slipFilter.$or.push({ cnic });
  }
  let admissionSlipsDeleted = { deletedCount: 0 };
  if (slipFilter.$or.length) {
    admissionSlipsDeleted = await AdmissionSlipVerification.deleteMany(slipFilter);
  }

  // ── Interview panel bookings linked to this student/user/phone ──
  let interviewBookingsCleared = 0;
  const panels = await InterviewPanel.find({
    $or: [
      { "schedules.booked_user_id": userId || id },
      ...(phoneDigits
        ? [{ "schedules.booked_phone": { $regex: phoneDigits.slice(-10) } }]
        : []),
    ],
  });

  for (const panel of panels) {
    let changed = false;
    const schedules = Array.isArray(panel.schedules) ? panel.schedules : [];
    for (const slot of schedules) {
      const slotPhone = digitsOnly(slot.booked_phone);
      const matchesUser =
        userId &&
        slot.booked_user_id &&
        String(slot.booked_user_id) === String(userId);
      const matchesPhone =
        phoneDigits.length >= 10 &&
        slotPhone &&
        (slotPhone === phoneDigits ||
          slotPhone.slice(-10) === phoneDigits.slice(-10));

      if (matchesUser || matchesPhone) {
        slot.booking_status = "available";
        slot.booked_for = "";
        slot.booked_phone = "";
        slot.booked_notes = "";
        slot.booked_user_id = undefined;
        slot.booked_at = null;
        changed = true;
        interviewBookingsCleared += 1;
      }
    }
    if (changed) {
      panel.markModified("schedules");
      await panel.save();
    }
  }

  // ── Login user + student record ──
  let userDeleted = false;
  if (userId) {
    const removed = await User.findByIdAndDelete(userId);
    userDeleted = Boolean(removed);
  } else if (email) {
    const removed = await User.findOneAndDelete({
      email,
      role: "student",
    });
    userDeleted = Boolean(removed);
  }

  await Student.findByIdAndDelete(id);

  return {
    student_id: String(id),
    student_name: student.name,
    user_deleted: userDeleted,
    finance: {
      fees: feesDeleted.deletedCount || 0,
      fee_logs: feeLogsDeleted.deletedCount || 0,
      pending_fee_slips: pendingSlipsDeleted.deletedCount || 0,
      refund_requests: refundsDeleted.deletedCount || 0,
    },
    academic: {
      enrollments: enrollmentsDeleted.deletedCount || 0,
      attendance: attendanceDeleted.deletedCount || 0,
      assignment_submissions: assignmentSubsDeleted.deletedCount || 0,
      quiz_attempts: quizAttemptsDeleted.deletedCount || 0,
      course_quiz_attempts: courseQuizAttemptsDeleted.deletedCount || 0,
    },
    other: {
      notifications: notificationsDeleted.deletedCount || 0,
      activity_logs: activityDeleted.deletedCount || 0,
      complaints: complaintsDeleted.deletedCount || 0,
      admission_slips: admissionSlipsDeleted.deletedCount || 0,
      interview_bookings_cleared: interviewBookingsCleared,
    },
  };
};

export default deleteStudentCascade;

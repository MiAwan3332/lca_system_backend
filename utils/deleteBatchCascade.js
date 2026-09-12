import mongoose from "mongoose";
import path from "path";
import Batch from "../models/batches.js";
import Student from "../models/students.js";
import User from "../models/users.js";
import Fee from "../models/fees.js";
import FeeLog from "../models/feeLogs.js";
import Enrollment from "../models/enrollments.js";
import Attendence from "../models/attendence.js";
import Assignment from "../models/assignments.js";
import AssignmentSubmission from "../models/assignmentSubmissions.js";
import CourseQuiz from "../models/courseQuizzes.js";
import CourseQuizAttempt from "../models/courseQuizAttempts.js";
import TimeTable from "../models/timeTables.js";
import Qualifier from "../models/qualifiers.js";
import InterviewEvaluation from "../models/interviewEvaluation.js";
import InterviewPanel from "../models/interviewPanel.js";
import WhatsAppQueuedMessage from "../models/whatsappQueuedMessage.js";
import StudentRollCounter from "../models/studentRollCounters.js";
import Announcement from "../models/announcements.js";
import { deleteStudentCascade } from "./deleteStudentCascade.js";
import { deleteFile } from "./fileStorage.js";

const digitsOnly = (value) => String(value || "").replace(/\D/g, "");

const resolveStorageConfig = () => {
  const filesStoragePath =
    process.env.FILES_STORAGE_PATH ||
    path.resolve(process.cwd(), "public", "files");
  return { filesStoragePath };
};

const buildQualifierAccountEmail = (phone) => {
  const digits = digitsOnly(phone);
  if (digits.length < 10) {
    return "";
  }
  return `qualifier.${digits.slice(-10)}@lca.local`;
};

const resolveQualifierLoginEmail = (qualifier) => {
  const existing = String(qualifier?.email || "").trim().toLowerCase();
  if (existing && existing.includes("@") && !existing.endsWith("@lca.local")) {
    return existing;
  }
  return buildQualifierAccountEmail(qualifier?.phone);
};

/**
 * Permanently remove a batch, all enrolled students (with finance),
 * and batch-scoped LMS / qualifier / queue data.
 */
export const deleteBatchCascade = async (batchId) => {
  if (!batchId || !mongoose.Types.ObjectId.isValid(String(batchId))) {
    throw new Error("Invalid batch id");
  }

  const batch = await Batch.findById(batchId);
  if (!batch) {
    throw new Error("Batch not found");
  }

  const id = batch._id;
  const students = await Student.find({ batch: id }).select("_id name").lean();
  const studentSummaries = [];

  for (const student of students) {
    try {
      const summary = await deleteStudentCascade(student._id);
      studentSummaries.push(summary);
    } catch (error) {
      if (error?.message === "Student not found") {
        continue;
      }
      throw error;
    }
  }

  // Leftover fees still tied only to this batch (orphans)
  const orphanFees = await Fee.find({ batch: id }).select("_id").lean();
  const orphanFeeIds = orphanFees.map((fee) => fee._id);
  const [orphanFeeLogsDeleted, orphanFeesDeleted] = await Promise.all([
    orphanFeeIds.length
      ? FeeLog.deleteMany({ fee: { $in: orphanFeeIds } })
      : Promise.resolve({ deletedCount: 0 }),
    Fee.deleteMany({ batch: id }),
  ]);

  const assignments = await Assignment.find({ batch: id }).select("_id").lean();
  const assignmentIds = assignments.map((row) => row._id);
  const quizzes = await CourseQuiz.find({ batch: id }).select("_id").lean();
  const quizIds = quizzes.map((row) => row._id);

  const [
    assignmentSubsDeleted,
    courseQuizAttemptsDeleted,
    assignmentsDeleted,
    quizzesDeleted,
    timetablesDeleted,
    enrollmentsDeleted,
    attendanceDeleted,
  ] = await Promise.all([
    assignmentIds.length
      ? AssignmentSubmission.deleteMany({ assignment: { $in: assignmentIds } })
      : Promise.resolve({ deletedCount: 0 }),
    quizIds.length
      ? CourseQuizAttempt.deleteMany({ quiz: { $in: quizIds } })
      : Promise.resolve({ deletedCount: 0 }),
    Assignment.deleteMany({ batch: id }),
    CourseQuiz.deleteMany({ batch: id }),
    TimeTable.deleteMany({ batch: id }),
    Enrollment.deleteMany({ batch: id }),
    Attendence.deleteMany({ batch: id }),
  ]);

  // Qualifiers for interview batches
  const qualifiers = await Qualifier.find({ batch: id }).lean();
  const qualifierIds = qualifiers.map((row) => row._id);

  let interviewEvaluationsDeleted = { deletedCount: 0 };
  let qualifierUsersDeleted = 0;
  let qualifierPhotosDeleted = 0;
  let interviewBookingsCleared = 0;

  if (qualifierIds.length) {
    interviewEvaluationsDeleted = await InterviewEvaluation.deleteMany({
      qualifier_id: { $in: qualifierIds },
    });

    const panels = await InterviewPanel.find({
      "schedules.booked_qualifier_id": { $in: qualifierIds },
    });
    for (const panel of panels) {
      let changed = false;
      const schedules = Array.isArray(panel.schedules) ? panel.schedules : [];
      for (const slot of schedules) {
        if (
          slot.booked_qualifier_id &&
          qualifierIds.some(
            (qid) => String(qid) === String(slot.booked_qualifier_id)
          )
        ) {
          slot.booking_status = "available";
          slot.booked_for = "";
          slot.booked_phone = "";
          slot.booked_notes = "";
          slot.booked_user_id = undefined;
          slot.booked_qualifier_id = undefined;
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

    const { filesStoragePath } = resolveStorageConfig();
    for (const qualifier of qualifiers) {
      const loginEmail = resolveQualifierLoginEmail(qualifier);
      if (loginEmail) {
        const removed = await User.deleteMany({
          email: loginEmail,
          role: { $regex: /^qualifier$/i },
        });
        qualifierUsersDeleted += removed.deletedCount || 0;
      }
      try {
        await deleteFile(
          `${filesStoragePath}/qualifiers/photos/photo_${qualifier._id}.jpeg`
        );
        qualifierPhotosDeleted += 1;
      } catch {
        // ignore missing files
      }
    }
  }

  const qualifiersDeleted = await Qualifier.deleteMany({ batch: id });

  const [whatsappDeleted, rollCountersDeleted] = await Promise.all([
    WhatsAppQueuedMessage.deleteMany({ batch: id }),
    StudentRollCounter.deleteMany({ batch: id }),
  ]);

  await Announcement.updateMany({ batches: id }, { $pull: { batches: id } });
  const emptyAnnouncementsDeleted = await Announcement.deleteMany({
    batches: { $size: 0 },
  });

  await Batch.findByIdAndDelete(id);

  const financeTotals = studentSummaries.reduce(
    (acc, row) => {
      acc.fees += row.finance?.fees || 0;
      acc.fee_logs += row.finance?.fee_logs || 0;
      acc.pending_fee_slips += row.finance?.pending_fee_slips || 0;
      acc.refund_requests += row.finance?.refund_requests || 0;
      return acc;
    },
    {
      fees: orphanFeesDeleted.deletedCount || 0,
      fee_logs: orphanFeeLogsDeleted.deletedCount || 0,
      pending_fee_slips: 0,
      refund_requests: 0,
    }
  );

  return {
    batch_id: String(id),
    batch_name: batch.name,
    students_deleted: studentSummaries.length,
    finance: financeTotals,
    academic: {
      assignments: assignmentsDeleted.deletedCount || 0,
      assignment_submissions: assignmentSubsDeleted.deletedCount || 0,
      course_quizzes: quizzesDeleted.deletedCount || 0,
      course_quiz_attempts: courseQuizAttemptsDeleted.deletedCount || 0,
      timetables: timetablesDeleted.deletedCount || 0,
      enrollments: enrollmentsDeleted.deletedCount || 0,
      attendance: attendanceDeleted.deletedCount || 0,
    },
    qualifiers: {
      deleted: qualifiersDeleted.deletedCount || 0,
      users_deleted: qualifierUsersDeleted,
      photos_deleted: qualifierPhotosDeleted,
      interview_evaluations: interviewEvaluationsDeleted.deletedCount || 0,
      interview_bookings_cleared: interviewBookingsCleared,
    },
    other: {
      whatsapp_queue: whatsappDeleted.deletedCount || 0,
      roll_counters: rollCountersDeleted.deletedCount || 0,
      empty_announcements: emptyAnnouncementsDeleted.deletedCount || 0,
    },
  };
};

export default deleteBatchCascade;

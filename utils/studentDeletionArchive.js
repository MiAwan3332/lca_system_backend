import User from "../models/users.js";
import Fee from "../models/fees.js";
import FeeLog from "../models/feeLogs.js";
import PendingFeeSlip from "../models/pendingFeeSlips.js";
import RefundRequest from "../models/refundRequests.js";
import StudentDeletionArchive from "../models/studentDeletionArchives.js";
import { getRequestUserId } from "./lmsAccess.js";

const toPlain = (doc) => {
  if (!doc) return null;
  if (typeof doc.toObject === "function") return doc.toObject();
  return doc;
};

/**
 * Resolve who is performing the deletion from req or an explicit override.
 */
export const resolveDeletionActor = async (req, actorOverride = null) => {
  if (actorOverride) {
    return {
      deleted_by: actorOverride.deleted_by || actorOverride.id || null,
      deleted_by_name: actorOverride.deleted_by_name || actorOverride.name || "",
      deleted_by_email: actorOverride.deleted_by_email || actorOverride.email || "",
      deleted_by_role: actorOverride.deleted_by_role || actorOverride.role || "",
    };
  }

  const userId = getRequestUserId(req);
  if (!userId) {
    return {
      deleted_by: null,
      deleted_by_name: "",
      deleted_by_email: "",
      deleted_by_role: req?.user?.user?.role || "",
    };
  }

  const user = await User.findById(userId).select("name email role").lean();
  return {
    deleted_by: userId,
    deleted_by_name: user?.name || "",
    deleted_by_email: user?.email || "",
    deleted_by_role: req?.user?.user?.role || user?.role || "",
  };
};

/**
 * Load complete finance records for a student before hard delete.
 */
export const collectStudentFinanceSnapshot = async (studentId) => {
  const [fees, feeLogs, pendingFeeSlips, refundRequests] = await Promise.all([
    Fee.find({ student: studentId })
      .populate("batch", "name batch_fee is_active")
      .lean(),
    FeeLog.find({ student: studentId })
      .sort({ action_date: -1 })
      .populate("action_by", "name email role")
      .populate({
        path: "fee",
        populate: { path: "batch", select: "name" },
      })
      .lean(),
    PendingFeeSlip.find({ student: studentId })
      .sort({ createdAt: -1 })
      .populate("generated_by", "name email")
      .lean(),
    RefundRequest.find({ student: studentId })
      .sort({ createdAt: -1 })
      .populate("requested_by", "name email")
      .populate("approved_by", "name email")
      .populate("rejected_by", "name email")
      .populate("refunded_by", "name email")
      .lean(),
  ]);

  // Also pick up fee logs tied only by fee id (legacy rows).
  const feeIds = fees.map((fee) => fee._id);
  let extraLogs = [];
  if (feeIds.length) {
    const existingIds = feeLogs.map((log) => log._id);
    extraLogs = await FeeLog.find({
      fee: { $in: feeIds },
      ...(existingIds.length ? { _id: { $nin: existingIds } } : {}),
    })
      .sort({ action_date: -1 })
      .populate("action_by", "name email role")
      .populate({
        path: "fee",
        populate: { path: "batch", select: "name" },
      })
      .lean();
  }

  const allLogs = [...feeLogs, ...extraLogs].sort((a, b) => {
    const da = a.action_date ? new Date(a.action_date).getTime() : 0;
    const db = b.action_date ? new Date(b.action_date).getTime() : 0;
    return db - da;
  });

  return {
    fees,
    fee_logs: allLogs,
    pending_fee_slips: pendingFeeSlips,
    refund_requests: refundRequests,
  };
};

/**
 * Persist deletion archive. Call BEFORE removing finance / student records.
 */
export const createStudentDeletionArchive = async ({
  student,
  actor,
  deletionSource = "student_delete",
  deletionReason = "",
}) => {
  const studentDoc = toPlain(student);
  if (!studentDoc?._id) {
    throw new Error("Cannot archive deletion without student data");
  }

  const studentId = studentDoc._id;
  const financeRaw = await collectStudentFinanceSnapshot(studentId);

  const batch =
    studentDoc.batch && typeof studentDoc.batch === "object"
      ? {
          _id: studentDoc.batch._id || studentDoc.batch,
          name: studentDoc.batch.name || "",
          batch_fee: studentDoc.batch.batch_fee ?? null,
          is_active: studentDoc.batch.is_active,
        }
      : studentDoc.batch
        ? { _id: studentDoc.batch }
        : null;

  const archive = await StudentDeletionArchive.create({
    original_student_id: studentId,
    student: {
      _id: studentDoc._id,
      roll_number: studentDoc.roll_number || "",
      name: studentDoc.name || "",
      email: studentDoc.email || "",
      phone: studentDoc.phone || "",
      cnic: studentDoc.cnic || "",
      admission_date: studentDoc.admission_date || "",
      date_of_birth: studentDoc.date_of_birth || "",
      father_name: studentDoc.father_name || "",
      father_phone: studentDoc.father_phone || "",
      latest_degree: studentDoc.latest_degree || "",
      university: studentDoc.university || "",
      city: studentDoc.city || "",
      province: studentDoc.province || "",
      completion_year: studentDoc.completion_year || "",
      marks_cgpa: studentDoc.marks_cgpa || "",
      cnic_image: studentDoc.cnic_image || "",
      cnic_back_image: studentDoc.cnic_back_image || "",
      image: studentDoc.image || "",
      latest_degree_image: studentDoc.latest_degree_image || "",
      qrcode: studentDoc.qrcode || "",
      batch: studentDoc.batch?._id || studentDoc.batch || null,
      paid_fee: Number(studentDoc.paid_fee) || 0,
      pending_fee: Number(studentDoc.pending_fee) || 0,
      total_fee: Number(studentDoc.total_fee) || 0,
      online_amount: Number(studentDoc.online_amount) || 0,
      cash_amount: Number(studentDoc.cash_amount) || 0,
      is_special_batch: Boolean(studentDoc.is_special_batch),
      special_fee_options: studentDoc.special_fee_options || {},
      remarks: studentDoc.remarks || "",
      is_active: studentDoc.is_active !== false,
      profile_updated_once: Boolean(studentDoc.profile_updated_once),
      skip_profile_completion: Boolean(studentDoc.skip_profile_completion),
    },
    batch_snapshot: batch,
    finance: {
      summary: {
        total_fee: Number(studentDoc.total_fee) || 0,
        paid_fee: Number(studentDoc.paid_fee) || 0,
        pending_fee: Number(studentDoc.pending_fee) || 0,
        cash_amount: Number(studentDoc.cash_amount) || 0,
        online_amount: Number(studentDoc.online_amount) || 0,
        fees_count: financeRaw.fees.length,
        fee_logs_count: financeRaw.fee_logs.length,
        pending_fee_slips_count: financeRaw.pending_fee_slips.length,
        refund_requests_count: financeRaw.refund_requests.length,
      },
      fees: financeRaw.fees,
      fee_logs: financeRaw.fee_logs,
      pending_fee_slips: financeRaw.pending_fee_slips,
      refund_requests: financeRaw.refund_requests,
    },
    deleted_by: actor?.deleted_by || null,
    deleted_by_name: actor?.deleted_by_name || "",
    deleted_by_email: actor?.deleted_by_email || "",
    deleted_by_role: actor?.deleted_by_role || "",
    deletion_source: deletionSource,
    deletion_reason: deletionReason || "",
    deleted_at: new Date(),
  });

  return archive;
};

export const attachCascadeSummaryToArchive = async (archiveId, cascadeSummary) => {
  if (!archiveId) return null;
  return StudentDeletionArchive.findByIdAndUpdate(
    archiveId,
    { $set: { cascade_summary: cascadeSummary || {} } },
    { new: true }
  );
};

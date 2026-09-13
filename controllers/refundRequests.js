import RefundRequest from "../models/refundRequests.js";
import Student from "../models/students.js";
import User from "../models/users.js";
import Fee from "../models/fees.js";
import FeeLog from "../models/feeLogs.js";
import {
  canCreateRefundRequest,
  canDecideRefundRequest,
  canUpdateRefundPayout,
  getRequestRoleName,
} from "../utils/refundAccess.js";
import {
  asUploadedFileArray,
  getPaymentEvidenceUrls,
  normalizePaymentEvidenceForStorage,
  uploadPaymentEvidenceFiles,
} from "../utils/paymentEvidence.js";
import { requiresPaymentEvidence } from "../utils/paymentMethods.js";
import { syncStudentFeeFromLogs } from "../utils/feePayment.js";

const populateFields = [
  {
    path: "student",
    select: "name email phone roll_number batch pending_fee paid_fee total_fee is_active",
  },
  { path: "requested_by", select: "name email role" },
  { path: "approved_by", select: "name email role" },
  { path: "rejected_by", select: "name email role" },
  { path: "refunded_by", select: "name email role" },
];

const normalizeRefundPaymentMethod = (raw) => {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value === "Online" || value.toLowerCase() === "online") {
    return "Online Payment";
  }
  if (value === "Cash" || value.toLowerCase() === "cash") {
    return "Cash";
  }
  if (value === "Online Payment") return "Online Payment";
  return value;
};

export const getRefundRequests = async (req, res) => {
  try {
    if (!canDecideRefundRequest(getRequestRoleName(req))) {
      return res.status(403).json({
        message: "You do not have permission to view refund requests",
      });
    }

    const {
      page = 1,
      limit = 10,
      query = "",
      status = "",
    } = req.query;

    const filter = {};
    const statusValue = String(status || "").trim();
    if (statusValue === "Refunded") {
      filter.is_refunded = true;
    } else if (statusValue === "AwaitingRefund") {
      filter.status = "Approved";
      filter.is_refunded = { $ne: true };
    } else if (statusValue) {
      filter.status = statusValue;
    }
    if (query) {
      filter.$or = [
        { student_name: { $regex: query, $options: "i" } },
        { student_roll_number: { $regex: query, $options: "i" } },
        { student_phone: { $regex: query, $options: "i" } },
        { batch_name: { $regex: query, $options: "i" } },
        { reason: { $regex: query, $options: "i" } },
      ];
    }

    const options = {
      page: Number(page) || 1,
      limit: Number(limit) || 10,
      sort: { createdAt: -1 },
      populate: populateFields,
    };

    const result = await RefundRequest.paginate(filter, options);

    const [pendingCount, approvedCount, rejectedCount, refundedCount] =
      await Promise.all([
        RefundRequest.countDocuments({ status: "Pending" }),
        RefundRequest.countDocuments({ status: "Approved" }),
        RefundRequest.countDocuments({ status: "Rejected" }),
        RefundRequest.countDocuments({ is_refunded: true }),
      ]);

    res.status(200).json({
      ...result,
      pendingCount,
      approvedCount,
      rejectedCount,
      refundedCount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createRefundRequest = async (req, res) => {
  try {
    if (!canCreateRefundRequest(getRequestRoleName(req))) {
      return res.status(403).json({
        message:
          "Only CEO, Principal, Vice Principal, or Super Admin can create refund requests",
      });
    }

    const { studentId, amount, reason } = req.body;
    const trimmedReason = String(reason || "").trim();
    const refundAmount = Number(amount);

    if (!studentId) {
      return res.status(400).json({ message: "Student is required" });
    }
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      return res.status(400).json({ message: "Refund amount must be greater than 0" });
    }
    if (!trimmedReason) {
      return res.status(400).json({ message: "Reason is required" });
    }

    const student = await Student.findById(studentId).populate("batch", "name");
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    const paidFee = Math.round(Math.max(Number(student.paid_fee) || 0, 0));
    if (paidFee <= 0) {
      return res.status(400).json({
        message: "Refund request is only allowed for students who have paid fees",
      });
    }
    if (refundAmount > paidFee) {
      return res.status(400).json({
        message: `Refund amount cannot exceed paid fee (Rs. ${paidFee})`,
      });
    }

    const alreadyRefunded = await RefundRequest.findOne({
      student: studentId,
      is_refunded: true,
    });
    if (alreadyRefunded) {
      return res.status(400).json({
        message: "This student has already been refunded",
      });
    }

    const pending = await RefundRequest.findOne({
      student: studentId,
      status: "Pending",
    });
    if (pending) {
      return res.status(400).json({
        message: "A pending refund request already exists for this student",
      });
    }

    const openApproved = await RefundRequest.findOne({
      student: studentId,
      status: "Approved",
      is_refunded: { $ne: true },
    });
    if (openApproved) {
      return res.status(400).json({
        message: "An approved refund is already waiting to be processed for this student",
      });
    }

    const requester = await User.findById(req.user.user.id);

    const created = await RefundRequest.create({
      student: student._id,
      student_name: student.name,
      student_roll_number: student.roll_number || "",
      student_phone: student.phone || "",
      batch_name: student.batch?.name || "N/A",
      amount: refundAmount,
      requested_amount: refundAmount,
      reason: trimmedReason,
      status: "Pending",
      requested_by: requester?._id,
      is_refunded: false,
    });

    const populated = await RefundRequest.findById(created._id).populate(populateFields);
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const approveRefundRequest = async (req, res) => {
  try {
    if (!canDecideRefundRequest(getRequestRoleName(req))) {
      return res.status(403).json({
        message: "You do not have permission to approve refund requests",
      });
    }

    const { id } = req.params;
    const comment = String(req.body?.comment || "").trim();
    if (!comment) {
      return res.status(400).json({ message: "Approval comment is required" });
    }

    const request = await RefundRequest.findById(id);
    if (!request) {
      return res.status(404).json({ message: "Refund request not found" });
    }
    if (request.status !== "Pending") {
      return res.status(400).json({
        message: "Only pending refund requests can be approved",
      });
    }

    const hasAmountOverride =
      req.body?.amount !== undefined &&
      req.body?.amount !== null &&
      String(req.body.amount).trim() !== "";
    let approvedAmount = Number(request.amount);
    if (hasAmountOverride) {
      approvedAmount = Number(req.body.amount);
      if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
        return res.status(400).json({
          message: "Approved amount must be greater than 0",
        });
      }
    }

    if (
      request.requested_amount === undefined ||
      request.requested_amount === null
    ) {
      request.requested_amount = request.amount;
    }

    const approver = await User.findById(req.user.user.id);
    request.amount = approvedAmount;
    request.status = "Approved";
    request.approved_by = approver?._id;
    request.approved_at = new Date();
    request.approval_comment = comment;
    request.rejected_by = undefined;
    request.rejected_at = undefined;
    request.rejection_comment = undefined;
    request.is_refunded = false;
    await request.save();

    // Deactivate student when refund request is approved
    if (request.student) {
      await Student.findByIdAndUpdate(request.student, {
        $set: { is_active: false },
      });
    }

    const updated = await RefundRequest.findById(id).populate(populateFields);
    res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const rejectRefundRequest = async (req, res) => {
  try {
    if (!canDecideRefundRequest(getRequestRoleName(req))) {
      return res.status(403).json({
        message: "You do not have permission to reject refund requests",
      });
    }

    const { id } = req.params;
    const comment = String(req.body?.comment || "").trim();
    if (!comment) {
      return res.status(400).json({ message: "Rejection comment is required" });
    }

    const request = await RefundRequest.findById(id);
    if (!request) {
      return res.status(404).json({ message: "Refund request not found" });
    }
    if (request.status !== "Pending") {
      return res.status(400).json({
        message: "Only pending refund requests can be rejected",
      });
    }

    const rejector = await User.findById(req.user.user.id);
    request.status = "Rejected";
    request.rejected_by = rejector?._id;
    request.rejected_at = new Date();
    request.rejection_comment = comment;
    request.approved_by = undefined;
    request.approved_at = undefined;
    request.approval_comment = undefined;
    await request.save();

    const updated = await RefundRequest.findById(id).populate(populateFields);
    res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * Process payout for an approved refund:
 * - create FeeLog "Refund" (subtracts from finance net)
 * - reduce student paid_fee (and cash/online totals)
 * - require screenshot when refunded via Online Payment
 * - mark request as refunded
 */
export const processRefundRequest = async (req, res) => {
  try {
    if (!canDecideRefundRequest(getRequestRoleName(req))) {
      return res.status(403).json({
        message: "You do not have permission to process refunds",
      });
    }

    const { id } = req.params;
    const request = await RefundRequest.findById(id);
    if (!request) {
      return res.status(404).json({ message: "Refund request not found" });
    }
    if (request.status !== "Approved") {
      return res.status(400).json({
        message: "Only approved refund requests can be refunded",
      });
    }
    if (request.is_refunded) {
      return res.status(400).json({
        message: "This refund has already been processed",
      });
    }

    const approvedMax = Math.round(Math.max(Number(request.amount) || 0, 0));
    if (approvedMax <= 0) {
      return res.status(400).json({ message: "Invalid approved refund amount" });
    }

    const hasAmountOverride =
      req.body?.amount !== undefined &&
      req.body?.amount !== null &&
      String(req.body.amount).trim() !== "";

    let refundAmount = approvedMax;
    if (hasAmountOverride) {
      refundAmount = Math.round(Number(req.body.amount));
    }

    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      return res.status(400).json({ message: "Refund amount must be greater than 0" });
    }
    if (refundAmount > approvedMax) {
      return res.status(400).json({
        message: `Refund amount cannot exceed approved amount (Rs. ${approvedMax})`,
      });
    }

    const paymentMethod = normalizeRefundPaymentMethod(
      req.body?.payment_method || req.body?.refund_payment_method
    );
    if (paymentMethod !== "Cash" && paymentMethod !== "Online Payment") {
      return res.status(400).json({
        message: "Select refund payment method: Cash or Online",
      });
    }

    let refundEvidence = "";
    if (requiresPaymentEvidence(paymentMethod)) {
      const evidenceFiles = asUploadedFileArray(req.files?.payment_evidence);
      if (!evidenceFiles.length) {
        return res.status(400).json({
          message: "Screenshot / receipt is required for online refunds",
        });
      }
      const urls = await uploadPaymentEvidenceFiles(
        evidenceFiles,
        request.student
      );
      refundEvidence = normalizePaymentEvidenceForStorage(urls);
      if (!refundEvidence) {
        return res.status(400).json({
          message: "Failed to upload online refund screenshot",
        });
      }
    }

    const student = await Student.findById(request.student);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    const actor = await User.findById(req.user.user.id);
    const fee = await Fee.findOne({ student: student._id }).sort({ _id: -1 });

    // Soft-deactivate first; channel totals synced from FeeLogs after refund log.
    student.is_active = false;
    await student.save();

    const feeLog = await FeeLog.create({
      amount: refundAmount,
      action_amount: refundAmount,
      action_date: new Date(),
      description: `Refund processed (${paymentMethod}) for ${student.name || "student"} (approved Rs. ${approvedMax})${
        request.reason ? `: ${request.reason}` : ""
      }`,
      action_type: "Refund",
      action_by: actor?._id,
      fee: fee?._id,
      student: student._id,
      payment_method: paymentMethod,
      payment_evidence: refundEvidence || null,
    });

    // Recalc paid_fee + cash_amount / online_amount:
    // Online refund deducts from online; Cash refund deducts from cash.
    await syncStudentFeeFromLogs(student._id);

    request.refunded_amount = refundAmount;
    request.is_refunded = true;
    request.refunded_by = actor?._id;
    request.refunded_at = new Date();
    request.fee_log = feeLog._id;
    request.refund_payment_method = paymentMethod;
    request.refund_evidence = refundEvidence || "";
    await request.save();

    const updated = await RefundRequest.findById(id).populate(populateFields);
    res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * Super Admin only — update Cash/Online payout method and screenshot
 * on an already-processed refund.
 */
export const updateRefundPayout = async (req, res) => {
  try {
    if (!canUpdateRefundPayout(getRequestRoleName(req))) {
      return res.status(403).json({
        message: "Only Super Admin can update refund payout details",
      });
    }

    const { id } = req.params;
    const request = await RefundRequest.findById(id);
    if (!request) {
      return res.status(404).json({ message: "Refund request not found" });
    }
    if (!request.is_refunded) {
      return res.status(400).json({
        message: "Only processed (refunded) requests can be updated here",
      });
    }

    const paymentMethod = normalizeRefundPaymentMethod(
      req.body?.payment_method || req.body?.refund_payment_method
    );
    if (paymentMethod !== "Cash" && paymentMethod !== "Online Payment") {
      return res.status(400).json({
        message: "Select refund payment method: Cash or Online",
      });
    }

    const existingEvidence = getPaymentEvidenceUrls(request.refund_evidence);
    const evidenceFiles = asUploadedFileArray(req.files?.payment_evidence);
    let refundEvidence = normalizePaymentEvidenceForStorage(existingEvidence);

    if (requiresPaymentEvidence(paymentMethod)) {
      if (evidenceFiles.length) {
        const urls = await uploadPaymentEvidenceFiles(
          evidenceFiles,
          request.student
        );
        const keepExisting =
          String(req.body?.replace_evidence || "").toLowerCase() === "true"
            ? []
            : existingEvidence;
        refundEvidence = normalizePaymentEvidenceForStorage([
          ...keepExisting,
          ...urls,
        ]);
      }
      if (!getPaymentEvidenceUrls(refundEvidence).length) {
        return res.status(400).json({
          message: "Screenshot / receipt is required for online refunds",
        });
      }
    } else {
      refundEvidence = "";
    }

    request.refund_payment_method = paymentMethod;
    request.refund_evidence = refundEvidence || "";
    await request.save();

    if (request.fee_log) {
      await FeeLog.findByIdAndUpdate(request.fee_log, {
        $set: {
          payment_method: paymentMethod,
          payment_evidence: refundEvidence || null,
        },
      });
    }

    // Recalc cash vs online after method change on the refund FeeLog.
    if (request.student) {
      await syncStudentFeeFromLogs(request.student);
    }

    const updated = await RefundRequest.findById(id).populate(populateFields);
    res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

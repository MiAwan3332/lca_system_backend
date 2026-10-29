import crypto from "crypto";
import mongoose from "mongoose";
import QRCode from "qrcode";
import AdmissionSlipVerification from "../models/admissionSlipVerification.js";
import Student from '../models/students.js';
import Fee from '../models/fees.js';
import FeeLog from '../models/feeLogs.js';
import FeeReceipt from '../models/feeReceipts.js';
import { staffProfileCodes } from '../utils/staffRoleProfiles.js';

const FRONTEND_BASE_URL = (
  process.env.FRONTEND_URL ||
  process.env.CLIENT_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");

const getRequestUserId = (req) =>
  req.user?.user?.id || req.user?.user?._id || req.user?.id || null;

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const validId = (value) => value && mongoose.isValidObjectId(String(value)) ? String(value) : null;

/** The student and payment a fee slip belongs to, so reverting that payment can cancel the slip. */
async function slipPaymentLink(body) {
  const student = validId(body.student_id);
  if (!student || String(body.slip_type || '').toLowerCase() !== 'fee') return { student };
  const logId = validId(body.payment_log_id);
  if (logId) {
    const log = await FeeLog.findById(logId).select('payment_id').lean();
    return { student, payment_log: log?._id || null, payment_id: log?.payment_id || null };
  }
  const receiptId = validId(body.receipt_id);
  const receipt = receiptId
    ? await FeeReceipt.findOne({ _id: receiptId, student }).select('payment_id').lean()
    : await FeeReceipt.findOne({ student, 'payload.payingNow': toNumber(body.amount_received ?? body.payingNow) }).sort({ createdAt: -1 }).select('payment_id').lean();
  return { student, payment_id: receipt?.payment_id || null };
}

/** Authenticated: register a slip and return verify URL + QR image. */
export const issueAdmissionSlipVerification = async (req, res) => {
  try {
    let body = req.body || {};
    if (staffProfileCodes(req.access).length) {
      // Staff issue a snapshot of the saved student, never a client-invented payment.
      const filter = body.student_id ? { _id: body.student_id } : body.phone ? { phone: String(body.phone).trim() } : null;
      const student = filter ? await Student.findOne(filter).populate('batch', 'name class_start_time class_end_time').lean() : null;
      if (!student) return res.status(400).json({ message: 'Choose a saved student before issuing an admission slip.' });
      body = { ...body, student_name: student.name, phone: student.phone, cnic: student.cnic,
        batch_name: student.batch?.name, total_fee: student.total_fee, amount_received: student.paid_fee,
        remaining_fee: student.pending_fee, payment_option: Number(student.pending_fee) > 0 ? (Number(student.paid_fee) > 0 ? 'partial' : 'later') : 'full' };
      if (body.slip_type === 'fee') {
        if (body.payment_log_id) {
          const fees = await Fee.find({ student: student._id }).distinct('_id');
          const log = await FeeLog.findOne({ _id: body.payment_log_id, action_type: 'Paid',
            $or: [{ student: student._id }, { fee: { $in: fees } }] }).populate({ path: 'fee', populate: { path: 'batch', select: 'name' } }).lean();
          if (!log) return res.status(400).json({ message: 'Choose a saved payment for this student.' });
          body.amount_received = log.action_amount;
          body.remaining_fee = Math.max(Number(log.amount || 0) - Number(log.action_amount || 0), Number(student.pending_fee || 0), 0);
          body.payment_method = log.payment_method;
          body.batch_name = log.fee?.batch?.name || body.batch_name;
        } else {
          const receipt = await FeeReceipt.findOne({ student: student._id, ...(body.receipt_id ? { _id: body.receipt_id } : {}) }).sort({ createdAt: -1 }).lean();
          if (!receipt) return res.status(400).json({ message: 'Choose a saved payment receipt.' });
          body.amount_received = receipt.payload.payingNow;
          body.remaining_fee = receipt.payload.remainingAfter ?? receipt.payload.pendingFee ?? receipt.payload.pending_fee ?? student.pending_fee;
          body.total_fee = receipt.payload.totalFee ?? student.total_fee;
          body.payment_method = receipt.payload.paymentMethod;
        }
        body.payment_option = Number(body.remaining_fee) > 0 ? 'partial' : 'full';
      }
    }
    const studentName = String(body.student_name || body.name || "").trim();
    if (!studentName) {
      return res.status(400).json({ message: "Student name is required" });
    }

    const clientBase = String(body.verify_base_url || "")
      .trim()
      .replace(/\/$/, "");
    const frontendBase = clientBase || FRONTEND_BASE_URL;
    const token = crypto.randomBytes(24).toString("hex");
    const verifyUrl = `${frontendBase}/verify-slip/${token}`;

    const record = await AdmissionSlipVerification.create({
      token,
      student_name: studentName,
      cnic: String(body.cnic || "").trim(),
      phone: String(body.phone || "").trim(),
      batch_name: String(body.batch_name || body.batchName || "").trim(),
      total_fee: toNumber(body.total_fee ?? body.batchFee),
      amount_received: toNumber(body.amount_received ?? body.payingNow),
      remaining_fee: toNumber(body.remaining_fee ?? body.remainingFee),
      payment_option: String(body.payment_option || body.paymentOption || "").trim(),
      payment_method: String(body.payment_method || body.paymentMethod || "").trim(),
      class_time: String(body.class_time || body.classTime || "").trim(),
      authorized_by: String(body.authorized_by || body.authorizedBy || "").trim(),
      slip_type:
        String(body.slip_type || "").toLowerCase() === "fee"
          ? "fee"
          : "admission",
      issued_at: new Date(),
      created_by: getRequestUserId(req) || undefined,
      ...(await slipPaymentLink(body)),
    });

    const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 280,
      color: { dark: "#212529", light: "#ffffff" },
    });

    res.status(200).json({
      authentic: true,
      token: record.token,
      verify_url: verifyUrl,
      qr_data_url: qrDataUrl,
      issued_at: record.issued_at,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/** Public: anyone scanning the QR can check authenticity. */
export const verifyAdmissionSlip = async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token || token.length < 16) {
      return res.status(200).json({
        authentic: false,
        status: "fake",
        message: "This verification code is invalid.",
      });
    }

    const record = await AdmissionSlipVerification.findOne({ token }).lean();
    if (!record) {
      return res.status(200).json({
        authentic: false,
        status: "fake",
        message: "No matching slip found. This slip appears to be fake or forged.",
      });
    }

    if (record.cancelled_at) {
      return res.status(200).json({
        authentic: false,
        status: "cancelled",
        message: "This slip was cancelled because its payment was reverted by Lahore CSS Academy.",
      });
    }

    const isFeeSlip = record.slip_type === "fee";
    res.status(200).json({
      authentic: true,
      status: "real",
      slip_type: isFeeSlip ? "fee" : "admission",
      message: isFeeSlip
        ? "This fee slip is verified and issued by Lahore CSS Academy."
        : "This admission slip is authentic and issued by Lahore CSS Academy.",
      slip: {
        student_name: record.student_name,
        cnic: record.cnic,
        phone: record.phone,
        batch_name: record.batch_name,
        total_fee: record.total_fee,
        amount_received: record.amount_received,
        remaining_fee: record.remaining_fee,
        payment_option: record.payment_option,
        payment_method: record.payment_method,
        class_time: record.class_time,
        authorized_by: record.authorized_by,
        issued_at: record.issued_at,
        slip_type: isFeeSlip ? "fee" : "admission",
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

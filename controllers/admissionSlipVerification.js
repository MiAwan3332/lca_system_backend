import crypto from "crypto";
import QRCode from "qrcode";
import AdmissionSlipVerification from "../models/admissionSlipVerification.js";

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

/** Authenticated: register a slip and return verify URL + QR image. */
export const issueAdmissionSlipVerification = async (req, res) => {
  try {
    const body = req.body || {};
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
      issued_at: new Date(),
      created_by: getRequestUserId(req) || undefined,
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
        message: "No matching admission slip found. This slip appears to be fake or forged.",
      });
    }

    res.status(200).json({
      authentic: true,
      status: "real",
      message: "This admission slip is authentic and issued by Lahore CSS Academy.",
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
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

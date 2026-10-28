import Student from "../models/students.js";
import { permissionGrants } from '../utils/accessPolicy.js';
import { assertDiscountAccess } from '../utils/discountAccess.js';
import { stageCreationFiles, prepareCreation, commitCreation, creationResponse } from '../utils/creationService.js';
import CreationRequest from '../models/creationRequests.js';
import { pendingStudentDues, normalizedStudentPhone } from '../utils/studentIdentity.js';
import { DEFAULT_STUDENT_PASSWORD } from '../utils/creationDefaults.js';
import mongoose from "mongoose";
import Batch from "../models/batches.js";
import User from "../models/users.js";
import {
  isStudentRole,
  resolveStudentId,
  resolveStudentRecord,
  denyUnlessOwnStudent,
} from "../utils/studentScope.js";
import {
  isTeacherRole,
  applyTeacherBatchFilter,
  denyUnlessTeacherBatchAccess,
  buildEmptyPaginatedResponse,
  isInstitutionAdmin,
  canAccessBatch,
  isFullAccessRole,
  denyUnlessPlatformSuperAdmin,
  denyUnlessStrictSuperAdmin,
  denyUnlessCanDeleteStudent,
  denyUnlessCanShiftStudentBatch,
  getRequestUserId,
} from "../utils/lmsAccess.js";
import { addEmailToQueue } from "../utils/emailQueue.js";
import dotenv, { populate } from "dotenv";
import moment from "moment";
import QRCode from "qrcode";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { compressImage, uploadFile } from "../utils/fileStorage.js";
import {
  asUploadedFileArray,
  normalizePaymentEvidenceForStorage,
  uploadPaymentEvidenceFiles,
} from "../utils/paymentEvidence.js";
import { parseSpecialFeeOptionsFromBatch, batchIsPaid } from "../utils/specialFeeOptions.js";
import {
  applyAdmissionDateFilter,
  buildAdmissionDateFilter,
  normalizeAdmissionDate,
} from "../utils/admissionDate.js";
import { isPakistanProvince } from "../utils/pakistanProvinces.js";
import {
  createStudentAdmissionFee,
  syncStudentFeeFromLogs,
} from "../utils/feePayment.js";
import Fee from "../models/fees.js";
import RefundRequest from "../models/refundRequests.js";
import FeeLog from "../models/feeLogs.js";
import PendingFeeSlip from "../models/pendingFeeSlips.js";
import Enrollment from "../models/enrollments.js";
import ActivityLog from "../models/activityLogs.js";
import path from "path";
import {
  getNextStudentRollNumber,
  backfillMissingRollNumbersForBatch,
  extractRollSequence,
} from "../utils/studentRollNumber.js";
import { sendStudentWelcomeWhatsApp, resolveWhatsAppSenderFromReq } from "../utils/whatsappMessaging.js";
import { deleteStudentCascade } from "../utils/deleteStudentCascade.js";
import { logActivity } from "../utils/activityLogger.js";
import StudentDeletionArchive from "../models/studentDeletionArchives.js";
import StudentBatchShift from "../models/studentBatchShifts.js";
import { buildPaginationResponse, getPagination } from "../utils/pagination.js";
dotenv.config();

const PENDING_FEE_BLOCK_MESSAGE =
  "This student has an outstanding fee balance. Please clear the pending dues before transferring the student to another batch.";

const getSyncedPendingAmount = async (studentId) => {
  await syncStudentFeeFromLogs(studentId);
  const student = await Student.findById(studentId).select("pending_fee");
  return Math.round(Math.max(Number(student?.pending_fee) || 0, 0));
};

const findPendingFeeSlipForAmount = async (studentId, pendingAmount) => {
  return PendingFeeSlip.findOne({
    student: studentId,
    pending_amount: pendingAmount,
  }).sort({ createdAt: -1 });
};

const buildPendingFeeBlockPayload = async (studentId, pendingAmount) => {
  const existingSlip = await findPendingFeeSlipForAmount(
    studentId,
    pendingAmount
  );
  return {
    code: "PENDING_FEE_BLOCK",
    message: PENDING_FEE_BLOCK_MESSAGE,
    pending_amount: pendingAmount,
    student_id: studentId,
    has_pending_fee_slip: Boolean(existingSlip),
    slip_url: existingSlip?.slip_url || null,
  };
};

// const crypto = require("crypto");


const digitsOnly = (value) => String(value || "").replace(/\D/g, "");

/** Internal login email for students (phone-based login uses Student.phone). */
const buildStudentAccountEmail = (phone) => {
  const digits = digitsOnly(phone);
  if (!digits) {
    throw new Error("Phone number is required to create a student login");
  }
  return `student.${digits}@lca.local`;
};

const findStudentByPhoneDigits = async (phone) => {
  const digits = digitsOnly(phone);
  if (!digits || digits.length < 10) return null;
  const last10 = digits.slice(-10);
  const flexiblePattern = last10.split("").join("\\D*");
  const candidates = await Student.find({
    phone: { $regex: flexiblePattern },
  }).limit(20);
  return (
    candidates.find((item) => {
      const itemDigits = digitsOnly(item.phone);
      return itemDigits === digits || itemDigits.slice(-10) === last10;
    }) || null
  );
};

/**
 * Phone must be unique among live All Students only.
 * Numbers that exist only in Deleted Students archive may be re-added.
 * Orphan student login users left after older deletes are cleaned up.
 */
const assertPhoneAvailableForNewStudent = async (phone, allowOrphanCleanup = true) => {
  const existingByPhone = await findStudentByPhoneDigits(phone);
  if (existingByPhone) {
    throw new Error(
      "Phone number already exists in All Students. Numbers from Deleted Students can be re-added."
    );
  }

  const email = buildStudentAccountEmail(phone);
  const existingStudent = await Student.findOne({ email });
  if (existingStudent) {
    throw new Error(
      "A student with this phone already exists in All Students"
    );
  }

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    const role = String(existingUser.role || "").toLowerCase();
    // Leftover login from a deleted student — allow re-create.
    if (role === "student" && allowOrphanCleanup) {
      await User.findByIdAndDelete(existingUser._id);
    } else {
      throw new Error("A login account already exists for this phone");
    }
  }

  return email;
};

export const addStudent = async (req, res) => {
  const { name, phone, batch, remarks, cnic } = req.body;
  const admission_date =
    normalizeAdmissionDate(req.body.admission_date) ||
    normalizeAdmissionDate(new Date());
  let payingNow = Number(req.body.paying_now) || 0;
  const paymentMethod = req.body.payment_method;
  const nextInstallmentDate = req.body.next_installment_date;

  try {
    if (!name?.trim()) {
      return res.status(400).json({ message: "Name is required" });
    }
    if (!phone?.trim()) {
      return res.status(400).json({ message: "Phone number is required" });
    }
    for (const field of ['paying_now', 'discount_amount']) {
      if (req.body[field] !== undefined && req.body[field] !== '' && !Number.isFinite(Number(req.body[field]))) {
        return res.status(400).json({ message: 'Payment and discount amounts must be valid numbers' });
      }
    }

    const existingStudent = req.studentIdentity?.student;
    const existingUser = req.studentIdentity?.user;
    let email = existingUser?.email;
    if (existingStudent) {
      if (!batch) return res.status(400).json({ message: 'Select a destination batch for the existing student' });
      if (existingStudent.creation_pending) return res.status(409).json({ message: 'The existing admission is still processing. Inspect its status before retrying.' });
      const dues = await pendingStudentDues(existingStudent._id);
      if (dues.length) return res.status(409).json({ code: 'PENDING_FEE_BLOCK', message: 'Clear existing pending dues before admission', dues,
        pending_total: dues.reduce((sum, item) => sum + item.pending, 0) });
      if (String(existingStudent.batch) === String(batch)) return res.status(409).json({ message: 'This student is already in the selected batch. Use their existing record.' });
      if (await Fee.exists({ student: existingStudent._id, batch })) return res.status(409).json({ message: 'A fee record already exists for this student and batch. Use the existing enrollment.' });
      const locked = await Student.updateOne({ _id: existingStudent._id, $or: [{ admission_request: { $exists: false } }, { admission_request: null }] },
        { $set: { admission_request: req.creationRequest._id } });
      if (!locked.modifiedCount) return res.status(409).json({ message: 'Another admission is processing for this student. Check its status.' });
    }
    if (!email) {
      try { email = await assertPhoneAvailableForNewStudent(phone, false); }
      catch (err) { return res.status(400).json({ message: err.message }); }
    }

    let batchRecord = null;
    let totalFee = 0;
    let rollNumber = "";
    let isSpecialBatch = false;
    let specialFeeOptions = {};
    let unpaidBatch = false;

    if (batch) {
      batchRecord = await Batch.findById(batch);
      if (!batchRecord) {
        return res.status(400).json({ message: "Selected batch not found" });
      }
      if (!await canAccessBatch(req, batch)) return res.status(403).json({ message: 'Destination batch access denied' });
      if (batchRecord.is_active === false) {
        return res.status(400).json({ message: "Selected batch is inactive" });
      }
      if (batchRecord.is_interview_batch === true) {
        return res.status(400).json({
          message: "Interview batches cannot be used for students. Choose a class batch.",
        });
      }

      unpaidBatch = !batchIsPaid(batchRecord);
      isSpecialBatch = batchRecord.is_special_batch === true;

      if (unpaidBatch) {
        totalFee = 0;
        specialFeeOptions = {};
        payingNow = 0;
      } else if (isSpecialBatch) {
        const parsed = parseSpecialFeeOptionsFromBatch(req.body, batchRecord);
        if (parsed.error) {
          return res.status(400).json({ message: parsed.error });
        }
        specialFeeOptions = parsed.options;
        totalFee = parsed.totalFee;
      } else {
        totalFee = Number(batchRecord.batch_fee) || 0;
      }

      rollNumber = await getNextStudentRollNumber({
        batchId: batchRecord._id,
        batchName: batchRecord.name,
        rollNickname: batchRecord.roll_nickname,
        batchType: batchRecord.batch_type,
      });
    }

    const grossFee = totalFee;
    const discountAmount = unpaidBatch
      ? 0
      : Number(req.body.discount_amount) || 0;
    const discountDescription =
      String(req.body.discount_description || "").trim() ||
      "Discount applied on student admission";

    if (discountAmount < 0) {
      return res.status(400).json({ message: "Discount cannot be negative" });
    }
    if (discountAmount > grossFee) {
      return res.status(400).json({
        message: `Discount cannot be greater than total fee (${grossFee} Rs.)`,
      });
    }

    totalFee = Math.max(grossFee - discountAmount, 0);

    if (payingNow < 0) {
      return res.status(400).json({ message: "Paying now cannot be negative" });
    }

    if (payingNow > totalFee) {
      return res
        .status(400)
        .json({
          message: `Paying amount cannot be greater than payable fee (${totalFee} Rs.)`,
        });
    }

    if (payingNow > 0) {
      if (!paymentMethod || !["Cash", "Online", "Bank Transfer", "Online Payment", "Cheque"].includes(paymentMethod)) {
        return res
          .status(400)
          .json({
            message:
              "Payment method is required (Cash, Bank Transfer, Online Payment, or Cheque)",
          });
      }
      if (
        (paymentMethod === "Online" || paymentMethod === "Online Payment") &&
        asUploadedFileArray(req.files?.payment_evidence).length === 0
      ) {
        return res.status(400).json({
          message: "Online payment evidence attachment is required",
        });
      }
    }

    const isPartialPayment = payingNow > 0 && payingNow < totalFee;
    if (isPartialPayment) {
      if (!nextInstallmentDate) {
        return res.status(400).json({
          message: "Next installment date is required for partial payment",
        });
      }
      if (!moment(nextInstallmentDate, moment.ISO_8601, true).isValid()) {
        return res.status(400).json({ message: 'Next installment date must be a valid date' });
      }
      if (moment(nextInstallmentDate).isBefore(moment(), "day")) {
        return res.status(400).json({
          message: "Next installment date must be today or in the future",
        });
      }
    }

    const pendingFee = Math.max(totalFee - payingNow, 0);

    // Generate a random password
    // const randomPassword = crypto.randomBytes(4).toString("hex"); 
    const randomPassword = DEFAULT_STUDENT_PASSWORD;

    // Hash the password
    const saltRounds = 10;
    const hashedPassword = existingUser?.password || await bcrypt.hash(randomPassword, saltRounds);

    const newUser = new User({
      name,
      email,
      password: hashedPassword, // Save the hashed password
      role: "student", // Assign the role
      phone,
    });

    const newStudent = new Student({
      created_by: req.user.user.id,
      roll_number: rollNumber,
      name,
      email,
      phone,
      normalized_phone: normalizedStudentPhone(phone),
      admission_date,
      batch: batch || undefined,
      remarks: remarks || "",
      discount_remarks:
        discountAmount > 0
          ? discountDescription || "Discount applied on student admission"
          : "",
      total_fee: totalFee,
      paid_fee: payingNow,
      pending_fee: pendingFee,
      is_special_batch: isSpecialBatch,
      special_fee_options: specialFeeOptions,
      password: hashedPassword, // Save the hashed password
      cnic: String(cnic || "").trim(),
      date_of_birth: "",
      father_name: "",
      father_phone: "",
      latest_degree: "",
      university: "",
      city: "",
      completion_year: "",
      marks_cgpa: "",
      cnic_image: "",
      cnic_back_image: "",
      image: "",
    });

    if (batchRecord && !String(newStudent.roll_number || "").trim()) {
      const rollError = new Error(
        "Roll number could not be assigned. Set batch type (Online / On Campus) and roll nickname, then try again."
      );
      rollError.status = 500;
      throw rollError;
    }

    const request = req.creationRequest;
    const assets = await stageCreationFiles(request, req.files,
      payingNow > 0 && ["Online", "Online Payment"].includes(paymentMethod));
    const { _id: unusedUserId, ...userPlan } = newUser.toObject();
    const { _id: unusedStudentId, ...studentPlan } = newStudent.toObject();
    const prepared = await prepareCreation(request, {
      user: userPlan, student: studentPlan, assets,
      existingStudent, existingUser,
      fee: batch ? { batchId: batch, totalFee: grossFee, payingNow, discountAmount, discountDescription,
        paymentMethod, nextInstallmentDate: isPartialPayment ? nextInstallmentDate : undefined } : null,
    });
    await commitCreation(prepared);
    res.status(201).json(await creationResponse(prepared));
  } catch (error) {
    const durable = req.creationRequest && await CreationRequest.findById(req.creationRequest._id).catch(() => null);
    if (!durable) return res.status(202).json({ idempotency_key: req.creationRequest?.key, submission_status: 'unknown', processing_status: 'pending' });
    if (durable?.state === 'committing' || durable?.state === 'complete') {
      // A DB acknowledgement may be lost after a successful write. Never delete committed data.
      const payload = await creationResponse(durable).catch(() => ({ idempotency_key: durable.key, submission_status: 'unknown', processing_status: 'pending' }));
      return res.status(202).json(payload);
    }

    res.status(error.status || 500).json({
      message: error.message,
      ...(error.code === 'CREATION_NOT_COMMITTED' ? { code: error.code } : {}),
      requestId: req.requestId || null,
    });
  }
};

const validateStudentImportRow = (row, rowNumber) => {
  const name = String(row?.name ?? "").trim();
  const phone = String(row?.phone ?? "").trim();
  const totalFee = Number(row?.total_fee);
  const paidFee = Number(row?.paid_fee);
  const pendingFee = Number(row?.pending_fee);
  const onlineAmount = Number(row?.online_amount);
  const cashAmount = Number(row?.cash_amount);

  if (!name) {
    throw new Error("Name is required");
  }
  if (!phone) {
    throw new Error("Phone number is required");
  }
  if (!Number.isFinite(totalFee) || totalFee < 0) {
    throw new Error("Total fee must be a valid non-negative number");
  }
  if (!Number.isFinite(paidFee) || paidFee < 0) {
    throw new Error("Paid amount must be a valid non-negative number");
  }
  if (!Number.isFinite(pendingFee) || pendingFee < 0) {
    throw new Error("Pending amount must be a valid non-negative number");
  }
  if (!Number.isFinite(onlineAmount) || onlineAmount < 0) {
    throw new Error("Online amount must be a valid non-negative number");
  }
  if (!Number.isFinite(cashAmount) || cashAmount < 0) {
    throw new Error("Cash amount must be a valid non-negative number");
  }
  if (paidFee > totalFee) {
    throw new Error("Paid amount cannot exceed total fee");
  }
  if (Math.abs(pendingFee - (totalFee - paidFee)) > 0.01) {
    throw new Error("Pending amount must equal total fee minus paid amount");
  }
  if (Math.abs(onlineAmount + cashAmount - paidFee) > 0.01) {
    throw new Error("Online amount + cash amount must equal paid amount");
  }

  const email = buildStudentAccountEmail(phone);

  return {
    name,
    email,
    phone,
    totalFee,
    paidFee,
    pendingFee,
    onlineAmount,
    cashAmount,
    remarks: String(row?.remarks ?? "").trim(),
    rowNumber,
  };
};

const importStudentFromRow = async ({
  row,
  batchId,
  batchRecord,
  actionUserId,
}) => {
  const validated = validateStudentImportRow(row, row.excelRow || row.rowNumber);

  await assertPhoneAvailableForNewStudent(validated.phone);

  const rollNumber = await getNextStudentRollNumber({
    batchId: batchRecord._id,
    batchName: batchRecord.name,
    rollNickname: batchRecord.roll_nickname,
    batchType: batchRecord.batch_type,
  });

  if (!rollNumber) {
    throw new Error("Failed to assign roll number");
  }

  const hashedPassword = await bcrypt.hash(DEFAULT_STUDENT_PASSWORD, 10);
  const admissionDate = new Date().toISOString();

  let newUser = null;
  let newStudent = null;

  try {
    newUser = await new User({
      name: validated.name,
      email: validated.email,
      password: hashedPassword,
      role: "student",
    }).save();

    newStudent = await new Student({
      roll_number: rollNumber,
      name: validated.name,
      email: validated.email,
      phone: validated.phone,
      admission_date: admissionDate,
      batch: batchRecord._id,
      remarks: validated.remarks,
      total_fee: validated.totalFee,
      paid_fee: validated.paidFee,
      pending_fee: validated.pendingFee,
      online_amount: validated.onlineAmount,
      cash_amount: validated.cashAmount,
      cnic: "",
      date_of_birth: "",
      father_name: "",
      father_phone: "",
      latest_degree: "",
      university: "",
      city: "",
      completion_year: "",
      marks_cgpa: "",
      cnic_image: "",
      cnic_back_image: "",
      image: "",
    }).save();

    // Ensure roll number is persisted (defensive against empty defaults)
    if (!newStudent.roll_number) {
      await Student.updateOne(
        { _id: newStudent._id },
        { $set: { roll_number: rollNumber } }
      );
      newStudent.roll_number = rollNumber;
    }

    await generateQrCode(newStudent._id);

    const batchFee = Math.max(Number(batchRecord.batch_fee) || 0, 0);
    const sheetTotal = validated.totalFee;
    const discountAmount =
      batchFee > 0 && sheetTotal < batchFee
        ? Math.round((batchFee - sheetTotal) * 100) / 100
        : 0;
    const grossFee = discountAmount > 0 ? batchFee : sheetTotal;

    if (grossFee > 0) {
      const payableFee = Math.max(grossFee - discountAmount, 0);
      const isPartialPayment =
        validated.paidFee > 0 && validated.paidFee < payableFee;
      const nextInstallmentDate = isPartialPayment
        ? moment().add(30, "days").format("YYYY-MM-DD")
        : undefined;

      const paymentBreakdown = [];
      if (validated.cashAmount > 0) {
        paymentBreakdown.push({
          paymentMethod: "Cash",
          amount: validated.cashAmount,
        });
      }
      if (validated.onlineAmount > 0) {
        paymentBreakdown.push({
          paymentMethod: "Online Payment",
          amount: validated.onlineAmount,
        });
      }

      await createStudentAdmissionFee({
        studentId: newStudent._id,
        batchId,
        totalFee: grossFee,
        payingNow: validated.paidFee,
        discountAmount,
        discountDescription:
          discountAmount > 0
            ? `Import discount: batch fee ${batchFee} minus sheet total ${sheetTotal}`
            : undefined,
        actionUserId,
        paymentMethod:
          validated.cashAmount > 0
            ? "Cash"
            : validated.onlineAmount > 0
              ? "Online Payment"
              : undefined,
        paymentBreakdown,
        nextInstallmentDate,
      });

      // Keep explicit cash/online totals on the student record
      await Student.updateOne(
        { _id: newStudent._id },
        {
          $set: {
            online_amount: validated.onlineAmount,
            cash_amount: validated.cashAmount,
            total_fee: payableFee,
            paid_fee: validated.paidFee,
            pending_fee: Math.max(payableFee - validated.paidFee, 0),
            ...(discountAmount > 0
              ? {
                  discount_remarks: `Import discount: batch fee ${batchFee} minus sheet total ${sheetTotal}`,
                }
              : {}),
          },
        }
      );
    }

    return newStudent;
  } catch (error) {
    if (newStudent?._id) {
      await Student.findByIdAndDelete(newStudent._id);
    }
    if (newUser?._id) {
      await User.findByIdAndDelete(newUser._id);
    }
    throw error;
  }
};

export const bulkImportStudents = async (req, res) => {
  const { batch_id: batchId, students } = req.body;

  if (!batchId) {
    return res.status(400).json({ message: "Batch is required" });
  }

  if (!Array.isArray(students) || students.length === 0) {
    return res.status(400).json({ message: "No students provided for import" });
  }

  if (students.length > 500) {
    return res.status(400).json({ message: "Maximum 500 students can be imported at once" });
  }

  if (isStudentRole(req)) {
    return res.status(403).json({ message: "Access denied" });
  }

  try {
    const batchRecord = await Batch.findById(batchId);
    if (!batchRecord) {
      return res.status(400).json({ message: "Selected batch not found" });
    }
    if (batchRecord.is_active === false) {
      return res.status(400).json({ message: "Selected batch is inactive" });
    }

    if (!(await canAccessBatch(req, batchId))) {
      return res.status(403).json({ message: "You do not have access to this batch" });
    }

    const actionUserId = req.user?.user?.id;
    if (req.access?.enforced && !req.access.owner) {
      const collecting = students.some((row) => Number(row?.paid_fee) > 0);
      const discounting = students.some((row) => Number.isFinite(Number(row?.total_fee)) && Number(row.total_fee) < Number(batchRecord.batch_fee));
      if (collecting && !permissionGrants(req.access, 'fees.pay.fee').length) return res.status(403).json({ message: 'Importing paid amounts requires fee-collection permission' });
      if (discounting && !permissionGrants(req.access, 'fees.discount.fee').length) return res.status(403).json({ message: 'Importing a discounted fee requires discount authority' });
      for (const row of students) {
        if (Number.isFinite(Number(row?.total_fee))) {
          try { assertDiscountAccess(req.access, Math.max(0, Number(batchRecord.batch_fee) - Number(row.total_fee)), { batchId: String(batchId) }); }
          catch (error) { return res.status(error.status || 403).json({ message: error.message }); }
        }
      }
    }
    const results = {
      imported: 0,
      failed: [],
      imported_students: [],
      backfilled_roll_numbers: [],
    };

    const seenPhones = new Set();

    for (let index = 0; index < students.length; index += 1) {
      const row = students[index];
      const rowNumber = row.excelRow || index + 2;

      try {
        const phoneKey = digitsOnly(row?.phone);
        if (!phoneKey) {
          throw new Error("Phone number is required");
        }
        if (seenPhones.has(phoneKey) || seenPhones.has(phoneKey.slice(-10))) {
          throw new Error("Duplicate phone number in import file");
        }
        seenPhones.add(phoneKey);
        seenPhones.add(phoneKey.slice(-10));

        const newStudent = await importStudentFromRow({
          row: { ...row, excelRow: rowNumber },
          batchId: batchRecord._id,
          batchRecord,
          actionUserId,
        });

        const savedStudent = await Student.findById(newStudent._id).select(
          "name phone roll_number"
        );

        results.imported += 1;
        results.imported_students.push({
          row: rowNumber,
          name: savedStudent?.name || newStudent.name,
          phone: savedStudent?.phone || newStudent.phone,
          roll_number: savedStudent?.roll_number || newStudent.roll_number,
        });
      } catch (error) {
        results.failed.push({
          row: rowNumber,
          phone: row?.phone || "",
          message: error.message,
        });
      }
    }

    // Assign rolls to any students in this batch still missing one
    results.backfilled_roll_numbers = await backfillMissingRollNumbersForBatch({
      batchId: batchRecord._id,
      batchName: batchRecord.name,
      rollNickname: batchRecord.roll_nickname,
      batchType: batchRecord.batch_type,
    });

    res.status(200).json({
      message: `Imported ${results.imported} of ${students.length} students`,
      batch_id: batchId,
      batch_name: batchRecord.name,
      ...results,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getStudents = async (req, res) => {
  const {
    query,
    batch_id,
    payment_status,
    enrollment_status,
    start_date,
    end_date,
    city,
    search_field,
    is_active,
    due_date_from,
    due_date_to,
  } = req.query;

  try {
    if (isStudentRole(req)) {
      const studentId = await resolveStudentId(req);
      if (!studentId) {
        return res.status(404).json({ message: "Student profile not found" });
      }

      const student = await Student.findById(studentId).populate("batch");
      const isActive = student ? student.is_active !== false : false;
      return res.status(200).json({
        docs: student ? [student] : [],
        totalDocs: student ? 1 : 0,
        limit: 1,
        totalPages: 1,
        page: 1,
        pagingCounter: 1,
        hasPrevPage: false,
        hasNextPage: false,
        prevPage: null,
        nextPage: null,
        status_counts: {
          total: student ? 1 : 0,
          active: student && isActive ? 1 : 0,
          inactive: student && !isActive ? 1 : 0,
        },
      });
    }

    const escapeRegex = (value) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const rawQuery = query ? query.trim() : "";
    const searchQuery = rawQuery ? escapeRegex(rawQuery) : "";
    const filter = { creation_pending: { $ne: true } };

    if (searchQuery) {
      const regex = { $regex: searchQuery, $options: "i" };
      const field = search_field || "all";

      if (field === "name") {
        filter.name = regex;
      } else if (field === "email") {
        filter.email = regex;
      } else if (field === "phone") {
        const phoneDigits = rawQuery.replace(/\D/g, "");
        if (phoneDigits) {
          filter.$or = [
            { phone: regex },
            { father_phone: regex },
            {
              phone: {
                $regex: phoneDigits.split("").join("\\D*"),
                $options: "i",
              },
            },
          ];
        } else {
          filter.$or = [{ phone: regex }, { father_phone: regex }];
        }
      } else {
        filter.$or = [
          { name: regex },
          { email: regex },
          { phone: regex },
          { father_phone: regex },
          { roll_number: regex },
        ];
      }
    }

    if (batch_id) {
      filter.batch = batch_id;
    } else if (enrollment_status === "enrolled") {
      // Legacy support
      filter.batch = { $ne: null };
    } else if (enrollment_status === "unenrolled") {
      filter.batch = null;
    }

    const feeStatus = String(payment_status || "").trim().toLowerCase();
    if (feeStatus === "pending_dues" || feeStatus === "pending") {
      filter.pending_fee = { $gt: 0 };
    } else if (feeStatus === "fully_paid" || feeStatus === "paid") {
      filter.$and = [
        ...(filter.$and || []),
        {
          $or: [
            { pending_fee: { $lte: 0 } },
            { pending_fee: null },
            { pending_fee: { $exists: false } },
          ],
        },
      ];
    }

    const dueFrom = String(due_date_from || "").trim();
    const dueTo = String(due_date_to || "").trim();
    if (dueFrom || dueTo) {
      const feeMatch = {
        status: "Pending",
        amount: { $gt: 0 },
        due_date: { $exists: true, $nin: [null, ""] },
      };
      if (dueFrom || dueTo) {
        feeMatch.due_date = {};
        if (dueFrom) feeMatch.due_date.$gte = dueFrom;
        if (dueTo) feeMatch.due_date.$lte = dueTo;
      }

      const dueStudentIds = await Fee.distinct("student", feeMatch);
      if (!dueStudentIds.length) {
        return res.status(200).json({
          ...buildEmptyPaginatedResponse(parseInt(req.query.limit, 10) || 10),
          status_counts: { total: 0, active: 0, inactive: 0 },
        });
      }
      filter._id = { $in: dueStudentIds };
      // Due-date filter implies pending dues
      filter.pending_fee = { $gt: 0 };
    }

    if (isTeacherRole(req)) {
      await applyTeacherBatchFilter(req, filter, "batch");
      if (filter.batch?.$in?.length === 0) {
        return res.status(200).json(buildEmptyPaginatedResponse(parseInt(req.query.limit, 10) || 10));
      }
    }

    applyAdmissionDateFilter(filter, start_date, end_date);

    if (city) {
      filter.city = { $regex: city, $options: "i" };
    }

    // Status counts ignore the active/inactive filter so all three chips stay visible.
    const countBaseFilter = { ...filter };
    const [totalCount, activeCount, inactiveCount] = await Promise.all([
      Student.countDocuments(countBaseFilter),
      Student.countDocuments({
        ...countBaseFilter,
        is_active: { $ne: false },
      }),
      Student.countDocuments({
        ...countBaseFilter,
        is_active: false,
      }),
    ]);

    if (is_active === "true") {
      filter.is_active = { $ne: false };
    } else if (is_active === "false") {
      filter.is_active = false;
    }

    const students = await Student.paginate(filter, {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 10,
      populate: ["batch"],
      sort: { _id: -1 },
    });

    const docs = students.docs || [];
    const studentIds = docs.map((s) => s._id);
    let approvedByStudent = {};
    let pendingByStudent = {};
    let refundedStudentIds = new Set();

    if (studentIds.length) {
      const relatedRefunds = await RefundRequest.find({
        student: { $in: studentIds },
      }).select("_id student amount reason status is_refunded approved_at");

      relatedRefunds.forEach((item) => {
        const key = String(item.student);
        if (item.status === "Approved" && item.is_refunded !== true) {
          approvedByStudent[key] = item;
        }
        if (item.status === "Pending") {
          pendingByStudent[key] = item;
        }
        if (item.is_refunded === true) {
          refundedStudentIds.add(key);
        }
      });
    }

    let dueDateByStudent = {};
    const shouldAttachDueDate =
      String(req.query.export || "") === "1" ||
      String(req.query.export || "").toLowerCase() === "true" ||
      feeStatus === "pending_dues" ||
      feeStatus === "pending" ||
      Boolean(dueFrom || dueTo);

    if (shouldAttachDueDate && studentIds.length) {
      const pendingFees = await Fee.find({
        student: { $in: studentIds },
        status: "Pending",
        amount: { $gt: 0 },
        due_date: { $exists: true, $nin: [null, ""] },
      })
        .select("student due_date amount")
        .sort({ due_date: 1 })
        .lean();

      pendingFees.forEach((fee) => {
        const key = String(fee.student);
        if (!dueDateByStudent[key]) {
          dueDateByStudent[key] = {
            due_date: fee.due_date,
            pending_due_amount: Number(fee.amount) || 0,
          };
        }
      });
    }

    students.docs = docs.map((doc) => {
      const plain = typeof doc.toObject === "function" ? doc.toObject() : doc;
      const key = String(plain._id);
      const dueInfo = dueDateByStudent[key] || null;
      return {
        ...plain,
        approved_refund_request: approvedByStudent[key] || null,
        pending_refund_request: pendingByStudent[key] || null,
        has_refunded_request: refundedStudentIds.has(key),
        due_date: dueInfo?.due_date || "",
        pending_due_date: dueInfo?.due_date || "",
        pending_due_amount: dueInfo?.pending_due_amount || 0,
      };
    });

    const payload =
      typeof students.toJSON === "function" ? students.toJSON() : { ...students };

    res.status(200).json({
      ...payload,
      status_counts: {
        total: totalCount,
        active: activeCount,
        inactive: inactiveCount,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getStudentsByBatch = async (req, res) => {
  const { batchId } = req.params;
  const { query } = req.query;
  try {
    if (isStudentRole(req)) {
      const student = await resolveStudentRecord(req);
      const ownBatchId = student?.batch?._id?.toString() || student?.batch?.toString();
      if (!ownBatchId || ownBatchId !== batchId) {
        return res.status(403).json({ message: "Access denied" });
      }
      return res.status(200).json({
        docs: student ? [student] : [],
        totalDocs: student ? 1 : 0,
        limit: 1,
        totalPages: 1,
        page: 1,
        pagingCounter: 1,
        hasPrevPage: false,
        hasNextPage: false,
        prevPage: null,
        nextPage: null,
      });
    }

    if (!(await denyUnlessTeacherBatchAccess(req, res, batchId))) {
      return;
    }

    const students = await Student.paginate(
      { 
        batch: batchId,
        creation_pending: { $ne: true },
      },
      {
        page: parseInt(req.query.page),
        limit: parseInt(req.query.limit),
        populate: ["batch"],
        sort: { roll_number: 1, name: 1, _id: 1 },
      });

    // Natural roll order: OC-Marathon-1, 2, 3…10 (by trailing digits), not lexical.
    const compareByRollSeq = (a, b) => {
      const rollA = String(a?.roll_number || "").trim();
      const rollB = String(b?.roll_number || "").trim();
      if (!rollA && rollB) return 1;
      if (rollA && !rollB) return -1;
      const seqA = extractRollSequence(rollA);
      const seqB = extractRollSequence(rollB);
      if (seqA !== seqB) return seqA - seqB;
      if (rollA !== rollB) {
        return rollA.localeCompare(rollB, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      }
      const nameA = String(a?.name || "").trim().toLowerCase();
      const nameB = String(b?.name || "").trim().toLowerCase();
      if (nameA !== nameB) return nameA.localeCompare(nameB);
      return String(a?._id || "").localeCompare(String(b?._id || ""));
    };
    students.docs = [...students.docs].sort(compareByRollSeq);
    // Generate finance history if exporting (large limit)
    if (parseInt(req.query.limit) > 1000 && students.docs.length > 0) {
      const studentIds = students.docs.map(s => s._id);
      
      const fees = await Fee.find({ student: { $in: studentIds } }).select("_id student");
      const feeIds = fees.map(f => f._id);
      
      const paymentLogs = await FeeLog.find({
        $or: [
          { student: { $in: studentIds } },
          ...(feeIds.length ? [{ fee: { $in: feeIds } }] : [])
        ]
      }).sort({ action_date: 1 }).lean();
      
      const feeToStudent = {};
      fees.forEach(f => {
        feeToStudent[f._id.toString()] = f.student.toString();
      });
      
      const historyByStudent = {};
      const discountRemarksByStudent = {};
      paymentLogs.forEach(log => {
        let sid = log.student?.toString();
        if (!sid && log.fee) {
          sid = feeToStudent[log.fee.toString()];
        }
        if (sid) {
          if (!historyByStudent[sid]) historyByStudent[sid] = [];
          
          const dateStr = log.action_date ? new Date(log.action_date).toLocaleDateString() : "";
          const amount = log.action_amount || log.amount || 0;
          let entry = `${log.action_type} Rs.${amount}`;
          if (log.payment_method) entry += ` via ${log.payment_method}`;
          if (dateStr) entry += ` on ${dateStr}`;
          
          historyByStudent[sid].push(entry);

          if (log.action_type === "Discounted") {
            const note = String(log.description || "").trim();
            if (note) {
              if (!discountRemarksByStudent[sid]) {
                discountRemarksByStudent[sid] = [];
              }
              discountRemarksByStudent[sid].push(note);
            }
          }
        }
      });
      
      const docsJson = students.docs.map(doc => {
        const json = doc.toJSON();
        const hist = historyByStudent[json._id.toString()];
        json.finance_history = hist ? hist.join(" | ") : "No transactions";
        const fromLogs = discountRemarksByStudent[json._id.toString()];
        if (!String(json.discount_remarks || "").trim() && fromLogs?.length) {
          json.discount_remarks = [...new Set(fromLogs)].join(" | ");
        }
        return json;
      });
      
      students.docs = docsJson;
    }

    res.status(200).json(students);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getStudentPaymentLogs = async (req, res) => {
  const { id } = req.params;

  try {
    if (!(await denyUnlessOwnStudent(req, res, id))) {
      return;
    }

    const student = await Student.findById(id).populate("batch", "name");
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    const fees = await Fee.find({ student: id }).select("_id");
    const feeIds = fees.map((fee) => fee._id);

    const paymentLogs = await FeeLog.find({
      $or: [{ student: id }, ...(feeIds.length ? [{ fee: { $in: feeIds } }] : [])],
    })
      .sort({ action_date: -1 })
      .populate("action_by", "name email")
      .populate({
        path: "fee",
        populate: { path: "batch", select: "name" },
      });

    const pendingFeeRecord = await Fee.findOne({
      student: id,
      status: "Pending",
      amount: { $gt: 0 },
    })
      .sort({ due_date: 1 })
      .select("due_date amount status _id");

    res.status(200).json({
      student: {
        _id: student._id,
        name: student.name,
        email: student.email,
        phone: student.phone,
        batch: student.batch,
        total_fee: student.total_fee || 0,
        paid_fee: student.paid_fee || 0,
        pending_fee: student.pending_fee || 0,
      },
      pending_fee_record: pendingFeeRecord,
      payment_logs: paymentLogs,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getStudentHistory = async (req, res) => {
  const { id } = req.params;

  try {
    if (isStudentRole(req)) {
      const ownId = await resolveStudentId(req);
      if (!ownId || String(ownId) !== String(id)) {
        return res.status(403).json({ message: "Access denied" });
      }
    }

    const student = await Student.findById(id).populate(
      "batch",
      "name batch_fee is_active class_start_time class_end_time batch_type roll_nickname"
    );
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    await syncStudentFeeFromLogs(id);

    const refreshedStudent = await Student.findById(id).populate(
      "batch",
      "name batch_fee is_active class_start_time class_end_time batch_type roll_nickname"
    );

    const [fees, enrollments, pendingFeeSlips, activityLogs, refundRequests, batchShifts] =
      await Promise.all([
      Fee.find({ student: id })
        .populate("batch", "name batch_fee is_active")
        .sort({ _id: -1 }),
      Enrollment.find({ student: id })
        .populate("batch", "name batch_fee is_active")
        .populate("courses", "name"),
      PendingFeeSlip.find({ student: id })
        .populate("generated_by", "name email")
        .sort({ createdAt: -1 }),
      ActivityLog.find({
        $or: [
          { actor_student: id },
          { target_id: String(id), target_type: /student/i },
        ],
      })
        .sort({ created_at: -1 })
        .limit(50)
        .populate("actor_user", "name email role"),
      RefundRequest.find({ student: id })
        .sort({ createdAt: -1 })
        .populate("requested_by", "name email")
        .populate("approved_by", "name email")
        .populate("rejected_by", "name email")
        .populate("refunded_by", "name email"),
      StudentBatchShift.find({ student: id })
        .sort({ shifted_at: -1 })
        .populate("shifted_by", "name email role")
        .populate("from_batch", "name")
        .populate("to_batch", "name"),
    ]);

    const feeIds = fees.map((fee) => fee._id);
    const paymentLogs = await FeeLog.find({
      $or: [
        { student: id },
        ...(feeIds.length ? [{ fee: { $in: feeIds } }] : []),
      ],
    })
      .sort({ action_date: -1 })
      .populate("action_by", "name email")
      .populate({
        path: "fee",
        populate: { path: "batch", select: "name" },
      });

    const batchMap = new Map();

    const upsertBatchHistory = (batchDoc, extras = {}) => {
      if (!batchDoc?._id) return;
      const key = String(batchDoc._id);
      const existing = batchMap.get(key) || {
        batch_id: batchDoc._id,
        batch_name: batchDoc.name || "Unknown batch",
        batch_fee: batchDoc.batch_fee || 0,
        is_active: batchDoc.is_active !== false,
        is_current: false,
        sources: [],
        fee_count: 0,
        paid_amount: 0,
        pending_amount: 0,
        created_amount: 0,
        first_seen_at: null,
        last_seen_at: null,
      };

      if (extras.source && !existing.sources.includes(extras.source)) {
        existing.sources.push(extras.source);
      }
      if (extras.is_current) existing.is_current = true;
      if (extras.fee_count) existing.fee_count += extras.fee_count;
      if (extras.paid_amount) existing.paid_amount += extras.paid_amount;
      if (extras.pending_amount) existing.pending_amount += extras.pending_amount;
      if (extras.created_amount) existing.created_amount += extras.created_amount;

      const seenAt = extras.seen_at ? new Date(extras.seen_at) : null;
      if (seenAt && !Number.isNaN(seenAt.getTime())) {
        if (!existing.first_seen_at || seenAt < new Date(existing.first_seen_at)) {
          existing.first_seen_at = seenAt;
        }
        if (!existing.last_seen_at || seenAt > new Date(existing.last_seen_at)) {
          existing.last_seen_at = seenAt;
        }
      }

      batchMap.set(key, existing);
    };

    if (refreshedStudent.batch) {
      upsertBatchHistory(refreshedStudent.batch, {
        source: "current",
        is_current: true,
        seen_at: refreshedStudent.admission_date || refreshedStudent._id.getTimestamp?.(),
      });
    }

    for (const enrollment of enrollments) {
      upsertBatchHistory(enrollment.batch, {
        source: "enrollment",
        seen_at: enrollment._id?.getTimestamp?.(),
      });
    }

    const logsByFeeId = {};
    for (const log of paymentLogs) {
      const feeId = log.fee?._id ? String(log.fee._id) : log.fee ? String(log.fee) : null;
      if (!feeId) continue;
      if (!logsByFeeId[feeId]) logsByFeeId[feeId] = [];
      logsByFeeId[feeId].push(log);
    }

    for (const fee of fees) {
      const feeLogs = logsByFeeId[String(fee._id)] || [];
      const paidAmount = feeLogs
        .filter((log) => log.action_type === "Paid")
        .reduce((sum, log) => sum + (Number(log.action_amount) || 0), 0);
      const createdAmount = feeLogs
        .filter((log) => log.action_type === "Created")
        .reduce(
          (sum, log) => sum + (Number(log.action_amount) || Number(log.amount) || 0),
          0
        );
      const pendingAmount =
        fee.status === "Pending" ? Number(fee.amount) || 0 : 0;

      upsertBatchHistory(fee.batch, {
        source: "fee",
        fee_count: 1,
        paid_amount: paidAmount,
        pending_amount: pendingAmount,
        created_amount: createdAmount,
        seen_at: fee._id?.getTimestamp?.(),
      });
    }

    const batchHistory = Array.from(batchMap.values()).sort((a, b) => {
      if (a.is_current && !b.is_current) return -1;
      if (!a.is_current && b.is_current) return 1;
      const aTime = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
      const bTime = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0;
      return bTime - aTime;
    });

    const feesWithLogs = fees.map((fee) => ({
      ...fee.toObject(),
      logs: logsByFeeId[String(fee._id)] || [],
    }));

    const refundedRequests = (refundRequests || []).filter(
      (reqItem) => reqItem.is_refunded === true
    );
    const refundedAmount = refundedRequests.reduce((sum, reqItem) => {
      const value =
        reqItem.refunded_amount != null
          ? Number(reqItem.refunded_amount)
          : Number(reqItem.amount);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);

    const hasPendingRefund = (refundRequests || []).some(
      (reqItem) => reqItem.status === "Pending"
    );
    const hasApprovedAwaitingRefund = (refundRequests || []).some(
      (reqItem) => reqItem.status === "Approved" && reqItem.is_refunded !== true
    );

    let refundStatus = null;
    if (refundedRequests.length > 0) {
      refundStatus = "Refunded";
    } else if (hasApprovedAwaitingRefund) {
      refundStatus = "Approved";
    } else if (hasPendingRefund) {
      refundStatus = "Pending";
    } else {
      const rejectedOnly =
        (refundRequests || []).length > 0 &&
        (refundRequests || []).every((reqItem) => reqItem.status === "Rejected");
      if (rejectedOnly) refundStatus = "Rejected";
    }

    const summary = {
      total_fee: Number(refreshedStudent.total_fee) || 0,
      paid_fee: Number(refreshedStudent.paid_fee) || 0,
      pending_fee: Number(refreshedStudent.pending_fee) || 0,
      refunded_amount: Math.round(refundedAmount),
      is_refunded: refundedRequests.length > 0,
      refund_status: refundStatus,
      fee_records: fees.length,
      payment_events: paymentLogs.length,
      batches_touched: batchHistory.length,
      batch_shifts: batchShifts.length,
      pending_fee_slips: pendingFeeSlips.length,
      enrollments: enrollments.length,
      activity_events: activityLogs.length,
      is_active: refreshedStudent.is_active !== false,
    };

    const studentPayload = refreshedStudent.toObject
      ? refreshedStudent.toObject()
      : { ...refreshedStudent };
    if (!String(studentPayload.discount_remarks || "").trim()) {
      const discountNotes = paymentLogs
        .filter((log) => log.action_type === "Discounted")
        .map((log) => String(log.description || "").trim())
        .filter(Boolean);
      if (discountNotes.length) {
        studentPayload.discount_remarks = [...new Set(discountNotes)].join(
          " | "
        );
      }
    }

    res.status(200).json({
      student: studentPayload,
      summary,
      batch_history: batchHistory,
      batch_shifts: batchShifts || [],
      fees: feesWithLogs,
      payment_logs: paymentLogs,
      enrollments,
      pending_fee_slips: pendingFeeSlips,
      activity_logs: activityLogs,
      refund_requests: refundRequests || [],
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/** Assign a roll number if the student is missing one (used before admission slip print). */
export const ensureStudentRollNumber = async (req, res) => {
  const { id } = req.params;
  try {
    const student = await Student.findById(id).populate(
      "batch",
      "name roll_nickname batch_type"
    );
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    const existing = String(student.roll_number || "").trim();
    if (existing) {
      return res.status(200).json({
        roll_number: existing,
        assigned: false,
        student,
      });
    }

    const batchDoc =
      student.batch && typeof student.batch === "object"
        ? student.batch
        : student.batch
          ? await Batch.findById(student.batch).select(
              "name roll_nickname batch_type"
            )
          : null;

    if (!batchDoc?._id) {
      return res.status(400).json({
        message: "Student has no batch; cannot assign a roll number",
      });
    }

    const rollNumber = await getNextStudentRollNumber({
      batchId: batchDoc._id,
      batchName: batchDoc.name,
      rollNickname: batchDoc.roll_nickname,
      batchType: batchDoc.batch_type,
    });

    student.roll_number = rollNumber;
    await student.save();

    return res.status(200).json({
      roll_number: rollNumber,
      assigned: true,
      student,
    });
  } catch (error) {
    return res.status(500).json({
      message: error.message || "Could not assign roll number",
    });
  }
};

export const getStudent = async (req, res) => {
  const { id } = req.params;
  try {
    if (!(await denyUnlessOwnStudent(req, res, id))) {
      return;
    }

    const student = await Student.findById(id);
    if (!student) return res.status(404).json({ message: 'Student not found' });
    res.status(200).json(student);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteStudent = async (req, res) => {
  const { id } = req.params;
  try {
    if (denyUnlessCanDeleteStudent(req, res)) return;

    const summary = await deleteStudentCascade(id, {
      req,
      deletionSource: "student_delete",
      deletionReason: String(req.body?.reason || "").trim(),
    });

    await logActivity({
      req,
      action: "delete",
      module: "students",
      description: `Deleted student ${summary.student_name || id} (archive ${summary.archive_id || "n/a"})`,
      targetId: summary.archive_id || id,
      targetType: "StudentDeletionArchive",
      metadata: {
        original_student_id: summary.student_id,
        student_name: summary.student_name,
        archive_id: summary.archive_id,
        finance: summary.finance,
      },
    });

    res.status(200).json({
      message: "Student and all related data deleted successfully",
      summary,
    });
  } catch (error) {
    const msg = error?.message || "Failed to delete student";
    if (msg === "Student not found" || msg === "Invalid student id") {
      return res.status(404).json({ message: msg });
    }
    res.status(500).json({ message: msg });
  }
};

export const getDeletedStudents = async (req, res) => {
  try {
    if (denyUnlessCanDeleteStudent(req, res)) return;

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const query = String(req.query.query || "").trim();

    const filter = {};
    if (query) {
      const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { "student.name": regex },
        { "student.email": regex },
        { "student.phone": regex },
        { "student.roll_number": regex },
        { deleted_by_name: regex },
        { deleted_by_email: regex },
      ];
    }

    const result = await StudentDeletionArchive.paginate(filter, {
      page,
      limit,
      sort: { deleted_at: -1 },
      select:
        "original_student_id student.name student.email student.phone student.roll_number student.paid_fee student.pending_fee student.total_fee student.cash_amount student.online_amount batch_snapshot deleted_by deleted_by_name deleted_by_email deleted_by_role deletion_source deletion_reason deleted_at finance.summary cascade_summary",
      populate: { path: "deleted_by", select: "name email role" },
    });

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getDeletedStudentArchive = async (req, res) => {
  const { id } = req.params;
  try {
    if (denyUnlessCanDeleteStudent(req, res)) return;

    const archive = await StudentDeletionArchive.findById(id).populate(
      "deleted_by",
      "name email role"
    );
    if (!archive) {
      return res.status(404).json({ message: "Deleted student archive not found" });
    }

    res.status(200).json(archive);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getBatchShifts = async (req, res) => {
  try {
    if (denyUnlessCanShiftStudentBatch(req, res)) return;

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const query = String(req.query.query || "").trim();

    const filter = {};
    if (query) {
      const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { student_name: regex },
        { student_phone: regex },
        { student_email: regex },
        { from_batch_name: regex },
        { to_batch_name: regex },
        { from_roll_number: regex },
        { to_roll_number: regex },
        { shifted_by_name: regex },
      ];
    }

    const result = await StudentBatchShift.paginate(filter, {
      page,
      limit,
      sort: { shifted_at: -1 },
      populate: [
        { path: "student", select: "name phone email roll_number batch is_active" },
        { path: "shifted_by", select: "name email role" },
        { path: "from_batch", select: "name" },
        { path: "to_batch", select: "name" },
      ],
    });

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const changeStudentPassword = async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;

  try {
    if (!password || password.length < 6) {
      return res.status(400).json({
        message: "Password must be at least 6 characters",
      });
    }

    const student = await Student.findById(id);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    const user = await User.findOne({ email: student.email, role: "student" });
    if (!user) {
      return res.status(404).json({ message: "Student login account not found" });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    user.password = hashedPassword;
    await user.save();

    res.status(200).json({ message: "Student password updated successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateStudent = async (req, res) => {
  const { id } = req.params;
  try {
    const student = await Student.findById(id);
    if (!student) return res.status(404).json({ message: "Student not found" });
    const fields = ['name', 'email', 'phone', 'cnic', 'admission_date', 'city', 'province', 'date_of_birth',
      'father_name', 'father_phone', 'latest_degree', 'university', 'completion_year', 'marks_cgpa',
      'batch', 'paid_fee', 'pending_fee', 'total_fee'];
    const updateData = Object.fromEntries(fields.filter((key) => Object.hasOwn(req.body, key)).map((key) => [key, req.body[key]]));
    if (updateData.email && updateData.email !== student.email && await Student.exists({ email: updateData.email, _id: { $ne: id } })) {
      return res.status(400).json({ message: "Email already exists" });
    }
    if (updateData.admission_date) updateData.admission_date = normalizeAdmissionDate(updateData.admission_date);
    const uploads = { image: ['avatars', 'avatar'], cnic_image: ['cnic_images', 'cnic_front'],
      cnic_back_image: ['cnic_images', 'cnic_back'], latest_degree_image: ['latest_degree', 'latest_degree'] };
    for (const [field, [folder, prefix]] of Object.entries(uploads)) {
      const file = req.files?.[field];
      if (!file) continue;
      const fileName = `${prefix}_${id}${path.extname(file.name) || '.jpg'}`;
      const converted = `${prefix}_${id}.jpeg`;
      const directory = `${process.env.FILES_STORAGE_PATH}/students/${folder}`;
      await uploadFile(file, fileName, directory);
      await compressImage(`${directory}/${fileName}`, `${directory}/${converted}`, 50);
      updateData[field] = `${process.env.FILES_STORAGE_URL}/files/students/${folder}/${converted}`;
    }
    await Student.findByIdAndUpdate(id, updateData);
    res.status(200).json("Student updated successfully");
  } catch (error) { res.status(500).json({ message: error.message }); }
};

const generateQrCode = async (studentId) => {
  let newQrCode = null;
  try {
    // Generate QR code
    QRCode.toString(
      studentId.toString(),
      {
        errorCorrectionLevel: "H",
        type: "svg",
      },
      async function (err, data) {
        if (err) throw err;
        await Student.findByIdAndUpdate(studentId, { qrcode: data });
        newQrCode = data;
      }
    );
  } catch (error) {
    console.log(error);
  }
  return newQrCode;
};

export const getQrCode = async (req, res) => {
  const { id } = req.params;
  try {
    const student = await Student.findById(id);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    await generateQrCode(student._id);

    res.status(200).json((await Student.findById(student._id)).qrcode);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateStudentinfo = async (req, res) => {
  const { id } = req.params;
  const {
    cnic,
    city,
    province,
    date_of_birth,
    father_name,
    father_phone,
    latest_degree,
    university,
    completion_year,
    marks_cgpa,
  } = req.body;
  const files = req.files || {};
  const { image, cnic_image, cnic_back_image, latest_degree_image } = files;

  try {
    const student = await Student.findById(id);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    if (isStudentRole(req)) {
      if (!(await denyUnlessOwnStudent(req, res, id))) {
        return;
      }
      if (student.profile_updated_once) {
        return res
          .status(403)
          .json({ message: "Profile can only be updated once" });
      }
    }

    const filesStorageUrl = process.env.FILES_STORAGE_URL;
    const filesStoragePath = process.env.FILES_STORAGE_PATH;

    const uploadStudentImage = async (file, folder, baseName) => {
      const fileExt = path.extname(file.name);
      const fileName = `${baseName}_${id}${fileExt}`;
      await uploadFile(file, fileName, `${filesStoragePath}/students/${folder}`);
      const webpFileName = `${baseName}_${id}.jpeg`;
      await compressImage(
        `${filesStoragePath}/students/${folder}/${fileName}`,
        `${filesStoragePath}/students/${folder}/${webpFileName}`,
        50
      );
      return `${filesStorageUrl}/files/students/${folder}/${webpFileName}`;
    };

    const updateData = {
      cnic,
      city,
      province,
      date_of_birth,
      father_name,
      father_phone,
      latest_degree,
      university,
      completion_year,
      marks_cgpa,
    };

    if (image) {
      updateData.image = await uploadStudentImage(image, "avatars", "avatar");
    } else if (!student.image) {
      return res.status(400).json({ message: "Student image is required" });
    }

    if (cnic_image) {
      updateData.cnic_image = await uploadStudentImage(
        cnic_image,
        "cnic_images",
        "cnic_front"
      );
    } else if (!student.cnic_image) {
      return res.status(400).json({ message: "CNIC front image is required" });
    }

    if (cnic_back_image) {
      updateData.cnic_back_image = await uploadStudentImage(
        cnic_back_image,
        "cnic_images",
        "cnic_back"
      );
    } else if (!student.cnic_back_image) {
      return res.status(400).json({ message: "CNIC back image is required" });
    }

    if (latest_degree_image) {
      updateData.latest_degree_image = await uploadStudentImage(
        latest_degree_image,
        "latest_degree",
        "latest_degree"
      );
    } else if (!student.latest_degree_image) {
      return res
        .status(400)
        .json({ message: "Latest degree image is required" });
    }

    if (isStudentRole(req)) {
      updateData.profile_updated_once = true;
    }

    await Student.findByIdAndUpdate(id, updateData);

    res.status(200).json({ message: "Student updated successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const checkStudentFields = async (req, res) => {
  const { id } = req.params;

  try {
    // Retrieve student by ID
    const student = await Student.findById(id);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    // Check for empty fields
    const fieldsToCheck = {
      cnic: student.cnic,
      city: student.city,
      province: student.province,
      date_of_birth: student.date_of_birth,
      father_name: student.father_name,
      father_phone: student.father_phone,
      latest_degree: student.latest_degree,
      university: student.university,
      completion_year: student.completion_year,
      marks_cgpa: student.marks_cgpa,
      image: student.image,
      cnic_image: student.cnic_image,
      cnic_back_image: student.cnic_back_image,
    };

    const emptyFields = Object.keys(fieldsToCheck).filter(
      (key) => !fieldsToCheck[key]
    );

    if (emptyFields.length > 0) {
      return res
        .status(400)
        .json({ message: "Empty fields found", emptyFields, check: 0 });
    }

    res.status(200).json({ message: "All fields are filled", check: 1 });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const transferStudentBatch = async (req, res) => {
  const { id } = req.params;
  const { batch, assign_new_fee, special_selected_options } = req.body;
  const assignNewFee =
    assign_new_fee === true ||
    assign_new_fee === "true" ||
    assign_new_fee === 1 ||
    assign_new_fee === "1";

  if (denyUnlessCanShiftStudentBatch(req, res)) return;

  if (!batch) {
    return res.status(400).json({ message: "Destination batch is required" });
  }

  try {
    const student = await Student.findById(id);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    if (student.admission_request) return res.status(409).json({ message: 'An admission is processing for this student. Wait before shifting batches.' });
    if (String(student.batch || "") === String(batch)) {
      return res.status(400).json({
        message: "Student is already assigned to this batch",
      });
    }

    const batchRecord = await Batch.findById(batch);
    if (!batchRecord) {
      return res.status(400).json({ message: "Selected batch not found" });
    }
    if (batchRecord.is_active === false) {
      return res.status(400).json({ message: "Selected batch is inactive" });
    }
    if (batchRecord.is_interview_batch === true) {
      return res.status(400).json({
        message:
          "Interview batches cannot be used for students. Choose a class batch.",
      });
    }

    if (!(await canAccessBatch(req, batch))) {
      return res.status(403).json({ message: "You do not have access to this batch" });
    }

    const pendingAmount = await getSyncedPendingAmount(id);
    if (pendingAmount > 0) {
      return res
        .status(409)
        .json(await buildPendingFeeBlockPayload(id, pendingAmount));
    }

    let newFeeAmount = 0;
    let specialFeeOptions = {};
    if (assignNewFee) {
      const unpaidBatch = !batchIsPaid(batchRecord);
      const isSpecialBatch = batchRecord.is_special_batch === true;

      if (unpaidBatch) {
        return res.status(400).json({
          message:
            "Destination batch has no fee configured. Transfer without assigning a new fee.",
        });
      }

      if (isSpecialBatch) {
        const parsed = parseSpecialFeeOptionsFromBatch(
          { special_selected_options },
          batchRecord
        );
        if (parsed.error) {
          return res.status(400).json({ message: parsed.error });
        }
        specialFeeOptions = parsed.options;
        newFeeAmount = parsed.totalFee;
      } else {
        newFeeAmount = Number(batchRecord.batch_fee) || 0;
      }

      if (!(newFeeAmount > 0)) {
        return res.status(400).json({
          message: "Destination batch fee must be greater than 0 to assign a new fee",
        });
      }

      const existingDestFee = await Fee.findOne({
        student: id,
        batch: batchRecord._id,
      });
      if (existingDestFee) {
        return res.status(400).json({
          message:
            "A fee record already exists for this student in the destination batch",
        });
      }
    }

    const previousBatchId = student.batch;
    const oldRollNumber = student.roll_number;
    const previousBatch = previousBatchId
      ? await Batch.findById(previousBatchId).select("name")
      : null;

    student.batch = batch;
    
    // Assign new roll number for the new batch
    const newRollNumber = await getNextStudentRollNumber({
      batchId: batchRecord._id,
      batchName: batchRecord.name,
      rollNickname: batchRecord.roll_nickname,
      batchType: batchRecord.batch_type,
    });
    student.roll_number = newRollNumber;

    if (assignNewFee && Object.keys(specialFeeOptions).length > 0) {
      student.special_fee_options = specialFeeOptions;
    }

    await student.save();

    let assignedFee = null;
    if (assignNewFee && newFeeAmount > 0) {
      const actionUserId = req.user?.user?.id;
      assignedFee = await createStudentAdmissionFee({
        studentId: student._id,
        batchId: batchRecord._id,
        totalFee: newFeeAmount,
        payingNow: 0,
        discountAmount: 0,
        createdDescription: `Fee assigned on batch shift to ${batchRecord.name || "new batch"}`,
        actionUserId,
      });
    }

    const actorUserId = getRequestUserId(req);
    const actorUser = actorUserId
      ? await User.findById(actorUserId).select("name email role")
      : null;

    await StudentBatchShift.create({
      student: student._id,
      student_name: student.name || "",
      student_phone: student.phone || "",
      student_email: student.email || "",
      from_batch: previousBatchId || null,
      from_batch_name: previousBatch?.name || (previousBatchId ? "Unknown batch" : "Unassigned"),
      to_batch: batchRecord._id,
      to_batch_name: batchRecord.name || "",
      from_roll_number: oldRollNumber || "",
      to_roll_number: newRollNumber || "",
      shifted_by: actorUserId || null,
      shifted_by_name: actorUser?.name || "",
      shifted_by_email: actorUser?.email || "",
      shifted_by_role: req.user?.user?.role || actorUser?.role || "",
      shifted_at: new Date(),
    });

    await logActivity({
      req,
      action: "batch_shift",
      module: "students",
      description: `Shifted student ${student.name} from ${
        previousBatch?.name || "Unassigned"
      } (${oldRollNumber || "no roll"}) to ${batchRecord.name} (${newRollNumber})${
        assignNewFee ? ` and assigned new fee of Rs. ${newFeeAmount}` : ""
      }`,
      targetId: student._id,
      targetType: "Student",
      metadata: {
        previousBatchId,
        previousBatchName: previousBatch?.name || "",
        newBatchId: batchRecord._id,
        newBatchName: batchRecord.name,
        oldRollNumber,
        newRollNumber,
        assign_new_fee: assignNewFee,
        new_fee_amount: assignNewFee ? newFeeAmount : 0,
        assigned_fee_id: assignedFee?._id || null,
      },
    });

    const updatedStudent = await Student.findById(id).populate("batch");
    res.status(200).json({
      ...(typeof updatedStudent.toObject === "function"
        ? updatedStudent.toObject()
        : updatedStudent),
      assign_new_fee: assignNewFee,
      new_fee_amount: assignNewFee ? newFeeAmount : 0,
      assigned_fee_id: assignedFee?._id || null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getPendingFeeSlip = async (req, res) => {
  const { id } = req.params;

  if (isStudentRole(req)) {
    return res.status(403).json({ message: "Access denied" });
  }

  try {
    const student = await Student.findById(id);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    const pendingAmount = await getSyncedPendingAmount(id);
    if (pendingAmount <= 0) {
      return res.status(400).json({
        message: "Student has no pending fee balance",
        pending_amount: 0,
      });
    }

    const existingSlip = await findPendingFeeSlipForAmount(id, pendingAmount);
    if (!existingSlip) {
      return res.status(404).json({
        message: "No pending fee slip found for the current outstanding balance",
        pending_amount: pendingAmount,
        has_pending_fee_slip: false,
      });
    }

    res.status(200).json({
      slip_url: existingSlip.slip_url,
      pending_amount: pendingAmount,
      reused: true,
      has_pending_fee_slip: true,
      createdAt: existingSlip.createdAt,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getOrCreatePendingFeeSlip = async (req, res) => {
  const { id } = req.params;

  if (isStudentRole(req)) {
    return res.status(403).json({ message: "Access denied" });
  }

  try {
    const student = await Student.findById(id).populate("batch", "name");
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    const pendingAmount = await getSyncedPendingAmount(id);
    if (pendingAmount <= 0) {
      return res.status(400).json({
        message: "Student has no pending fee balance",
        pending_amount: 0,
      });
    }

    const existingSlip = await findPendingFeeSlipForAmount(id, pendingAmount);
    if (existingSlip) {
      return res.status(200).json({
        slip_url: existingSlip.slip_url,
        pending_amount: pendingAmount,
        reused: true,
        has_pending_fee_slip: true,
        createdAt: existingSlip.createdAt,
      });
    }

    const slipFile = req.files?.slip || req.files?.file;
    if (!slipFile) {
      return res.status(400).json({
        code: "NEED_SLIP_FILE",
        message: "Pending fee slip PDF is required to create a new slip",
        pending_amount: pendingAmount,
        has_pending_fee_slip: false,
      });
    }

    const filesStorageUrl =
      process.env.FILES_STORAGE_URL ||
      `${req.protocol}://${req.get("host")}/public`;
    const filesStoragePath =
      process.env.FILES_STORAGE_PATH ||
      path.resolve(process.cwd(), "public", "files");

    const pendingFees = await Fee.find({
      student: id,
      status: "Pending",
      amount: { $gt: 0 },
    }).select("_id");

    const fileExt = path.extname(slipFile.name) || ".pdf";
    const fileName = `pending_fee_slip_${id}_${pendingAmount}_${Date.now()}${fileExt}`;
    const folderPath = `${filesStoragePath}/students/pending-fee-slips`;
    await uploadFile(slipFile, fileName, folderPath);

    const slipUrl = `${filesStorageUrl}/files/students/pending-fee-slips/${fileName}`;
    const actionUserId = req.user?.user?.id;

    const createdSlip = await PendingFeeSlip.create({
      student: id,
      pending_amount: pendingAmount,
      slip_url: slipUrl,
      fee_ids: pendingFees.map((fee) => fee._id),
      generated_by: actionUserId || undefined,
    });

    res.status(201).json({
      slip_url: createdSlip.slip_url,
      pending_amount: pendingAmount,
      reused: false,
      has_pending_fee_slip: true,
      createdAt: createdSlip.createdAt,
      student: {
        _id: student._id,
        name: student.name,
        email: student.email,
        roll_number: student.roll_number,
        batch: student.batch,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const basicStudentUpdate = async (req, res) => {
  const { id } = req.params;
  const {
    name,
    phone,
    email,
    cnic,
    batch,
    remarks,
    paid_fee,
    skip_profile_completion,
  } = req.body;

  try {
    const student = await Student.findById(id);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    const updateData = {};

    if (name !== undefined) updateData.name = name;
    if (phone !== undefined) updateData.phone = phone;
    if (cnic !== undefined) updateData.cnic = String(cnic || "").trim();
    if (remarks !== undefined) updateData.remarks = remarks || "";

    if (email !== undefined && email !== student.email) {
      const existingStudent = await Student.findOne({
        email,
        _id: { $ne: id },
      });
      if (existingStudent) {
        return res.status(400).json({ message: "Email already exists" });
      }

      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({ message: "Email already exists" });
      }
    }

    if (email !== undefined) {
      updateData.email = email;
    }

    if (batch !== undefined) {
      if (batch) {
        const batchRecord = await Batch.findById(batch);
        if (!batchRecord) {
          return res.status(400).json({ message: "Selected batch not found" });
        }
        if (
          batchRecord.is_active === false &&
          String(student.batch) !== String(batch)
        ) {
          return res.status(400).json({ message: "Selected batch is inactive" });
        }

        const isBatchChanging = String(student.batch || "") !== String(batch);
        if (isBatchChanging) {
          const pendingAmount = await getSyncedPendingAmount(id);
          if (pendingAmount > 0) {
            return res
              .status(409)
              .json(await buildPendingFeeBlockPayload(id, pendingAmount));
          }
        }

        updateData.batch = batch;
      } else {
        const isBatchChanging = Boolean(student.batch);
        if (isBatchChanging) {
          const pendingAmount = await getSyncedPendingAmount(id);
          if (pendingAmount > 0) {
            return res
              .status(409)
              .json(await buildPendingFeeBlockPayload(id, pendingAmount));
          }
        }
        updateData.batch = null;
      }
    }

    if (paid_fee !== undefined && paid_fee !== null && paid_fee !== "") {
      const newPaidFee = student.paid_fee + Number(paid_fee);
      const pendingFee =
        student.total_fee > newPaidFee ? student.total_fee - newPaidFee : 0;
      updateData.paid_fee = newPaidFee;
      updateData.pending_fee = pendingFee;
    }

    if (!isStudentRole(req) && skip_profile_completion !== undefined) {
      updateData.skip_profile_completion =
        skip_profile_completion === true ||
        skip_profile_completion === "true";
    }

    const imageFile = req.files?.image;
    if (imageFile) {
      const filesStorageUrl = process.env.FILES_STORAGE_URL;
      const filesStoragePath = process.env.FILES_STORAGE_PATH;
      const fileExt = path.extname(imageFile.name) || ".jpg";
      const fileName = `avatar_${id}${fileExt}`;
      await uploadFile(imageFile, fileName, `${filesStoragePath}/students/avatars`);
      const webpFileName = `avatar_${id}.jpeg`;
      await compressImage(
        `${filesStoragePath}/students/avatars/${fileName}`,
        `${filesStoragePath}/students/avatars/${webpFileName}`,
        50
      );
      updateData.image = `${filesStorageUrl}/files/students/avatars/${webpFileName}`;
    }

    await Student.findByIdAndUpdate(id, updateData);

    const user = await User.findOne({ email: student.email, role: "student" });
    if (user) {
      if (name !== undefined) user.name = name;
      if (email !== undefined && email !== student.email) {
        user.email = email;
      }
      await user.save();
    }

    const updatedStudent = await Student.findById(id).populate("batch");
    res.status(200).json(updatedStudent);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getStudentsGraph = async (req, res) => {
  try {
    const { batch_id, start_date, end_date } = req.query;

    const rangeStart = start_date ? new Date(start_date) : null;
    const rangeEnd = end_date ? new Date(`${end_date}T23:59:59.999Z`) : null;
    const year = rangeEnd
      ? rangeEnd.getFullYear()
      : rangeStart
        ? rangeStart.getFullYear()
        : new Date().getFullYear();

    const months = Array.from({ length: 12 }, (_, i) => new Date(year, i, 1))
      .map((date) => ({
        date,
        month: date.toLocaleString("default", { month: "long" }),
      }))
      .filter(({ date }) => {
        const monthStart = date;
        const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
        if (rangeStart && monthEnd < rangeStart) return false;
        if (rangeEnd && monthStart > rangeEnd) return false;
        return true;
      });

    const studentCounts = await Promise.all(
      months.map(async ({ date }) => {
        const monthStart = moment(date).format("YYYY-MM-DD");
        const monthEnd = moment(date).endOf("month").format("YYYY-MM-DD");

        const query = {
          admission_date: buildAdmissionDateFilter(
            rangeStart
              ? moment.max(moment(rangeStart), moment(monthStart)).format("YYYY-MM-DD")
              : monthStart,
            rangeEnd
              ? moment.min(moment(rangeEnd), moment(monthEnd)).format("YYYY-MM-DD")
              : monthEnd
          ),
        };

        if (batch_id) query.batch = batch_id;

        return Student.countDocuments(query);
      })
    );

    const data = months.map(({ month }, index) => ({
      [month]: studentCounts[index],
    }));
    res.json(data);
  } catch (error) {
    console.error("Error fetching student data:", error);
    res.status(500).send(error);
  }
};

export const getStudentsByBatchesGraph = async (req, res) => {
  try {
    const { batch_id, start_date, end_date } = req.query;
    const batches = batch_id
      ? await Batch.find({ _id: batch_id }).select("name").lean()
      : await Batch.find().select("name").sort({ name: 1 }).limit(500).lean();

    const match = {};
    if (batch_id) match.batch = new mongoose.Types.ObjectId(batch_id);
    applyAdmissionDateFilter(match, start_date, end_date);
    const groupedCounts = await Student.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$batch",
          total: { $sum: 1 },
          active: {
            $sum: { $cond: [{ $ne: ["$is_active", false] }, 1, 0] },
          },
          inactive: {
            $sum: { $cond: [{ $eq: ["$is_active", false] }, 1, 0] },
          },
        },
      },
    ]);
    const countsByBatch = new Map(
      groupedCounts.map((item) => [String(item._id), item])
    );

    const studentCounts = batches.map((batch) => {
      const counts = countsByBatch.get(String(batch._id)) || {};
      const total = counts.total || 0;
      return {
        batch: batch.name,
        batch_id: String(batch._id),
        total,
        active: counts.active || 0,
        inactive: counts.inactive || 0,
        count: total,
      };
    });

    res.json(studentCounts);
  } catch (error) {
    console.error("Error fetching student data:", error);
    res.status(500).json({ message: error.message || "Failed to load batch student counts" });
  }
};

export const getStudentsContacts = async (req, res) => {
  const { query } = req.query;
  try {
    const searchQuery = String(query || "").trim();
    const filter = searchQuery
      ? {
          $or: [
            { name: { $regex: searchQuery, $options: "i" } },
            { phone: { $regex: searchQuery, $options: "i" } },
          ],
        }
      : {};
    const { page, limit, skip } = getPagination(req.query);
    const [totalDocs, students] = await Promise.all([
      Student.countDocuments(filter),
      Student.find(filter).select("phone").skip(skip).limit(limit).lean(),
    ]);
    const pagination = buildPaginationResponse({
      docs: students.map((student) => student.phone).filter(Boolean),
      totalDocs,
      page,
      limit,
    });
    res.status(200).json({
      ...pagination,
      total: totalDocs,
      phones: pagination.docs,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


export const deleteAllStudents = async (req, res) => {
  try {
    await Student.deleteMany();
    await User.deleteMany({ role: "student" });
    res.status(200).json("All students deleted successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const canManageStudentStatus = async (req, student) => {
  if (isStudentRole(req)) return false;
  if (isFullAccessRole(req) || isInstitutionAdmin(req)) return true;
  if (isTeacherRole(req) && student?.batch) {
    return canAccessBatch(req, student.batch._id || student.batch);
  }
  return false;
};

export const toggleStudentStatus = async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;

  try {
    const student = await Student.findById(id).populate("batch");
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    if (!(await canManageStudentStatus(req, student))) {
      return res.status(403).json({ message: "Access denied" });
    }

    student.is_active =
      is_active !== undefined
        ? is_active === true || is_active === "true"
        : student.is_active === false;

    await student.save();
    res.status(200).json(student);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const toggleBatchStudentsStatus = async (req, res) => {
  const { batchId } = req.params;
  const { is_active } = req.body;

  try {
    if (isStudentRole(req)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const batch = await Batch.findById(batchId);
    if (!batch) {
      return res.status(404).json({ message: "Batch not found" });
    }

    if (!(await canAccessBatch(req, batchId))) {
      return res.status(403).json({ message: "Access denied" });
    }

    if (is_active === undefined) {
      return res.status(400).json({ message: "is_active is required" });
    }

    const nextStatus = is_active === true || is_active === "true";
    const result = await Student.updateMany(
      { batch: batchId },
      { $set: { is_active: nextStatus } }
    );

    res.status(200).json({
      batch_id: batchId,
      batch_name: batch.name,
      is_active: nextStatus,
      modified_count: result.modifiedCount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const FILLABLE_NULL_STUDENT_FIELDS = {
  province: "Province",
  city: "City",
  father_name: "Father name",
  father_phone: "Father phone",
  latest_degree: "Latest degree",
  university: "University",
  completion_year: "Completion year",
  marks_cgpa: "Marks / CGPA",
  date_of_birth: "Date of birth",
};

const buildNullOrEmptyFieldFilter = (field) => ({
  $or: [
    { [field]: null },
    { [field]: { $exists: false } },
    { [field]: "" },
  ],
});

/** Fill one profile field for all students where that field is null/empty. */
export const fillNullStudentField = async (req, res) => {
  try {
    if (denyUnlessStrictSuperAdmin(req, res)) return;

    if (isStudentRole(req)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const {
      field,
      value,
      batch_id,
      preview,
    } = req.body || {};

    const fieldKey = String(field || "").trim();
    if (!FILLABLE_NULL_STUDENT_FIELDS[fieldKey]) {
      return res.status(400).json({
        message:
          "Select a valid field (province, city, father name, etc.).",
      });
    }

    const isPreview =
      preview === true || preview === "true" || preview === 1 || preview === "1";
    const trimmedValue = String(value ?? "").trim();

    if (!isPreview && !trimmedValue) {
      return res.status(400).json({
        message: "Enter a value to apply to empty records.",
      });
    }

    if (
      trimmedValue &&
      fieldKey === "province" &&
      !isPakistanProvince(trimmedValue)
    ) {
      return res.status(400).json({
        message: "Select a valid Pakistan province",
      });
    }

    const filter = {
      ...buildNullOrEmptyFieldFilter(fieldKey),
    };

    const batchId = batch_id ? String(batch_id).trim() : "";
    if (batchId) {
      if (!(await canAccessBatch(req, batchId))) {
        return res.status(403).json({ message: "Access denied" });
      }
      filter.batch = batchId;
    } else if (isTeacherRole(req)) {
      return res.status(400).json({
        message: "Teachers must select a batch to fill empty fields.",
      });
    }

    const matchedCount = await Student.countDocuments(filter);

    if (isPreview) {
      const students = await Student.find(filter)
        .select(
          "name phone roll_number city province father_name father_phone latest_degree university completion_year marks_cgpa date_of_birth batch"
        )
        .populate("batch", "name")
        .sort({ name: 1 })
        .limit(1000)
        .lean();

      return res.status(200).json({
        field: fieldKey,
        field_label: FILLABLE_NULL_STUDENT_FIELDS[fieldKey],
        value: trimmedValue || null,
        batch_id: batchId || null,
        matched_count: matchedCount,
        students,
        preview: true,
      });
    }

    if (matchedCount === 0) {
      return res.status(200).json({
        field: fieldKey,
        field_label: FILLABLE_NULL_STUDENT_FIELDS[fieldKey],
        value: trimmedValue,
        batch_id: batchId || null,
        matched_count: 0,
        modified_count: 0,
        message: "No students found with an empty value for this field.",
      });
    }

    const result = await Student.updateMany(filter, {
      $set: { [fieldKey]: trimmedValue },
    });

    return res.status(200).json({
      field: fieldKey,
      field_label: FILLABLE_NULL_STUDENT_FIELDS[fieldKey],
      value: trimmedValue,
      batch_id: batchId || null,
      matched_count: matchedCount,
      modified_count: result.modifiedCount,
      message: `Updated ${result.modifiedCount} student(s) with empty ${FILLABLE_NULL_STUDENT_FIELDS[fieldKey]}.`,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

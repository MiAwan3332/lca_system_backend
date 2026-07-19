import Student from "../models/students.js";
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
} from "../utils/lmsAccess.js";
import { addEmailToQueue } from "../utils/emailQueue.js";
import dotenv, { populate } from "dotenv";
import moment from "moment";
import QRCode from "qrcode";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { compressImage, uploadFile } from "../utils/fileStorage.js";
import {
  createStudentAdmissionFee,
  syncStudentFeeFromLogs,
} from "../utils/feePayment.js";
import Fee from "../models/fees.js";
import FeeLog from "../models/feeLogs.js";
import PendingFeeSlip from "../models/pendingFeeSlips.js";
import Enrollment from "../models/enrollments.js";
import ActivityLog from "../models/activityLogs.js";
import path from "path";
import {
  getNextStudentRollNumber,
  backfillMissingRollNumbersForBatch,
} from "../utils/studentRollNumber.js";
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

const coerceBooleanFlag = (value) =>
  value === true || value === "true" || value === "1" || value === 1;

const parseSpecialFeeOptionsFromBatch = (body, batchRecord) => {
  const batchFees = batchRecord.special_fee_options || {};
  const selections = {
    test_session: coerceBooleanFlag(body.special_test_session),
    optional_revision: coerceBooleanFlag(body.special_optional_revision),
    compulsory_revision: coerceBooleanFlag(body.special_compulsory_revision),
  };

  const selectedKeys = Object.keys(selections).filter((key) => selections[key]);

  if (selectedKeys.length === 0) {
    return {
      error:
        "Select at least one special batch option (Test Session, Optional Revision, or Compulsory Revision)",
    };
  }

  const options = {
    test_session: { selected: false, fee: 0 },
    optional_revision: { selected: false, fee: 0 },
    compulsory_revision: { selected: false, fee: 0 },
  };

  for (const key of selectedKeys) {
    const fee = Number(batchFees[key]) || 0;
    if (!Number.isFinite(fee) || fee <= 0) {
      return {
        error: `Selected option "${key.replace(/_/g, " ")}" has no fee configured on this batch`,
      };
    }
    options[key] = { selected: true, fee };
  }

  const totalFee = selectedKeys.reduce((sum, key) => sum + options[key].fee, 0);
  return { options, totalFee };
};

export const addStudent = async (req, res) => {
  const { name, email, phone, batch, remarks } = req.body;
  const admission_date = req.body.admission_date || new Date();
  const payingNow = Number(req.body.paying_now) || 0;
  const paymentMethod = req.body.payment_method;
  const nextInstallmentDate = req.body.next_installment_date;

  try {
    // Check if the email already exists
    const existingStudent = await Student.findOne({ email });
    if (existingStudent) {
      return res.status(400).json({ message: "Email already exists" });
    }

    let batchRecord = null;
    let totalFee = 0;
    let rollNumber = "";
    let isSpecialBatch = false;
    let specialFeeOptions = {
      test_session: { selected: false, fee: 0 },
      optional_revision: { selected: false, fee: 0 },
      compulsory_revision: { selected: false, fee: 0 },
    };

    if (batch) {
      batchRecord = await Batch.findById(batch);
      if (!batchRecord) {
        return res.status(400).json({ message: "Selected batch not found" });
      }
      if (batchRecord.is_active === false) {
        return res.status(400).json({ message: "Selected batch is inactive" });
      }

      isSpecialBatch = batchRecord.is_special_batch === true;

      if (isSpecialBatch) {
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
      });
    }

    const grossFee = totalFee;
    const discountAmount = Number(req.body.discount_amount) || 0;
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
      if (!paymentMethod || !["Cash", "Online"].includes(paymentMethod)) {
        return res
          .status(400)
          .json({ message: "Payment method is required (Cash or Online)" });
      }
      if (paymentMethod === "Online" && !req.files?.payment_evidence) {
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
      if (moment(nextInstallmentDate).isBefore(moment(), "day")) {
        return res.status(400).json({
          message: "Next installment date must be today or in the future",
        });
      }
    }

    const pendingFee = Math.max(totalFee - payingNow, 0);

    // Generate a random password
    // const randomPassword = crypto.randomBytes(4).toString("hex"); 
    const randomPassword = "lca@123456";

    // Hash the password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(randomPassword, saltRounds);

    if (await User.findOne({ email })) {
      return res.status(400).json({ message: "Email already exists" });
    }

    const newUser = new User({
      name,
      email,
      password: hashedPassword, // Save the hashed password
      role: "student", // Assign the role
    });

    await newUser.save();

    const newStudent = new Student({
      roll_number: rollNumber,
      name,
      email,
      phone,
      admission_date,
      batch: batch || undefined,
      remarks: remarks || "",
      total_fee: totalFee,
      paid_fee: payingNow,
      pending_fee: pendingFee,
      is_special_batch: isSpecialBatch,
      special_fee_options: specialFeeOptions,
      password: hashedPassword, // Save the hashed password
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
    });

    await newStudent.save();

    const imageFile = req.files?.image;
    if (imageFile) {
      const filesStorageUrl = process.env.FILES_STORAGE_URL;
      const filesStoragePath = process.env.FILES_STORAGE_PATH;
      const fileExt = path.extname(imageFile.name) || ".jpg";
      const fileName = `avatar_${newStudent._id}${fileExt}`;
      await uploadFile(imageFile, fileName, `${filesStoragePath}/students/avatars`);
      const webpFileName = `avatar_${newStudent._id}.jpeg`;
      await compressImage(
        `${filesStoragePath}/students/avatars/${fileName}`,
        `${filesStoragePath}/students/avatars/${webpFileName}`,
        50
      );
      newStudent.image = `${filesStorageUrl}/files/students/avatars/${webpFileName}`;
      await newStudent.save();
    }

    await generateQrCode(newStudent._id);

    let paymentEvidenceUrl = "";
    const evidenceFile = req.files?.payment_evidence;
    if (payingNow > 0 && paymentMethod === "Online" && evidenceFile) {
      const filesStorageUrl = process.env.FILES_STORAGE_URL;
      const filesStoragePath = process.env.FILES_STORAGE_PATH;
      const fileExt = path.extname(evidenceFile.name) || ".jpg";
      const baseName = `payment_evidence_${newStudent._id}_${Date.now()}`;
      const fileName = `${baseName}${fileExt}`;
      const folderPath = `${filesStoragePath}/students/payment-evidence`;
      await uploadFile(evidenceFile, fileName, folderPath);

      const isImage = /\.(jpe?g|png|webp|gif)$/i.test(fileExt);
      if (isImage) {
        const webpFileName = `${baseName}.jpeg`;
        await compressImage(
          `${folderPath}/${fileName}`,
          `${folderPath}/${webpFileName}`,
          70
        );
        paymentEvidenceUrl = `${filesStorageUrl}/files/students/payment-evidence/${webpFileName}`;
      } else {
        paymentEvidenceUrl = `${filesStorageUrl}/files/students/payment-evidence/${fileName}`;
      }
    }

    if (batch && grossFee > 0) {
      const actionUserId = req.user?.user?.id;
      await createStudentAdmissionFee({
        studentId: newStudent._id,
        batchId: batch,
        totalFee: grossFee,
        payingNow,
        discountAmount,
        discountDescription,
        actionUserId,
        paymentMethod: payingNow > 0 ? paymentMethod : undefined,
        paymentEvidence: paymentEvidenceUrl,
        nextInstallmentDate: isPartialPayment ? nextInstallmentDate : undefined,
      });
    }

    // Send welcome email to the student with the random password
    // await addEmailToQueue(email, name, randomPassword);

    const savedStudent = await Student.findById(newStudent._id).populate("batch");
    res.status(200).json(savedStudent);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const DEFAULT_STUDENT_PASSWORD = "lca@123456";

const validateStudentImportRow = (row, rowNumber) => {
  const name = String(row?.name ?? "").trim();
  const email = String(row?.email ?? "").trim().toLowerCase();
  const phone = String(row?.phone ?? "").trim();
  const totalFee = Number(row?.total_fee);
  const paidFee = Number(row?.paid_fee);
  const pendingFee = Number(row?.pending_fee);

  if (!name) {
    throw new Error("Name is required");
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Valid email is required");
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
  if (paidFee > totalFee) {
    throw new Error("Paid amount cannot exceed total fee");
  }
  if (Math.abs(pendingFee - (totalFee - paidFee)) > 0.01) {
    throw new Error("Pending amount must equal total fee minus paid amount");
  }

  return {
    name,
    email,
    phone,
    totalFee,
    paidFee,
    pendingFee,
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

  const existingStudent = await Student.findOne({ email: validated.email });
  if (existingStudent) {
    throw new Error("Email already exists for a student");
  }

  if (await User.findOne({ email: validated.email })) {
    throw new Error("Email already exists for a user");
  }

  const rollNumber = await getNextStudentRollNumber({
    batchId: batchRecord._id,
    batchName: batchRecord.name,
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

    if (validated.totalFee > 0) {
      const isPartialPayment =
        validated.paidFee > 0 && validated.paidFee < validated.totalFee;
      const nextInstallmentDate = isPartialPayment
        ? moment().add(30, "days").format("YYYY-MM-DD")
        : undefined;

      await createStudentAdmissionFee({
        studentId: newStudent._id,
        batchId,
        totalFee: validated.totalFee,
        payingNow: validated.paidFee,
        actionUserId,
        paymentMethod: validated.paidFee > 0 ? "Cash" : undefined,
        nextInstallmentDate,
      });
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
    const results = {
      imported: 0,
      failed: [],
      imported_students: [],
      backfilled_roll_numbers: [],
    };

    const seenEmails = new Set();

    for (let index = 0; index < students.length; index += 1) {
      const row = students[index];
      const rowNumber = row.excelRow || index + 2;

      try {
        const email = String(row?.email ?? "").trim().toLowerCase();
        if (seenEmails.has(email)) {
          throw new Error("Duplicate email in import file");
        }
        seenEmails.add(email);

        const newStudent = await importStudentFromRow({
          row: { ...row, excelRow: rowNumber },
          batchId: batchRecord._id,
          batchRecord,
          actionUserId,
        });

        const savedStudent = await Student.findById(newStudent._id).select(
          "name email roll_number"
        );

        results.imported += 1;
        results.imported_students.push({
          row: rowNumber,
          name: savedStudent?.name || newStudent.name,
          email: savedStudent?.email || newStudent.email,
          roll_number: savedStudent?.roll_number || newStudent.roll_number,
        });
      } catch (error) {
        results.failed.push({
          row: rowNumber,
          email: row?.email || "",
          message: error.message,
        });
      }
    }

    // Assign rolls to any students in this batch still missing one
    results.backfilled_roll_numbers = await backfillMissingRollNumbersForBatch({
      batchId: batchRecord._id,
      batchName: batchRecord.name,
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
    enrollment_status,
    start_date,
    end_date,
    city,
    search_field,
    is_active,
  } = req.query;

  try {
    if (isStudentRole(req)) {
      const studentId = await resolveStudentId(req);
      if (!studentId) {
        return res.status(404).json({ message: "Student profile not found" });
      }

      const student = await Student.findById(studentId).populate("batch");
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

    const escapeRegex = (value) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const rawQuery = query ? query.trim() : "";
    const searchQuery = rawQuery ? escapeRegex(rawQuery) : "";
    const filter = {};

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
      filter.batch = { $ne: null };
    } else if (enrollment_status === "unenrolled") {
      filter.batch = null;
    }

    if (isTeacherRole(req)) {
      await applyTeacherBatchFilter(req, filter, "batch");
      if (filter.batch?.$in?.length === 0) {
        return res.status(200).json(buildEmptyPaginatedResponse(parseInt(req.query.limit, 10) || 10));
      }
    }

    if (start_date || end_date) {
      filter.admission_date = {};
      if (start_date) filter.admission_date.$gte = start_date;
      if (end_date) filter.admission_date.$lte = end_date;
    }

    if (city) {
      filter.city = { $regex: city, $options: "i" };
    }

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

    res.status(200).json(students);
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
        batch: batchId 
      },
      {
        page: parseInt(req.query.page),
        limit: parseInt(req.query.limit),
        populate: ["batch"],
        sort: { _id: -1 },
      });
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
      "name batch_fee is_active"
    );
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    await syncStudentFeeFromLogs(id);

    const refreshedStudent = await Student.findById(id).populate(
      "batch",
      "name batch_fee is_active"
    );

    const [fees, enrollments, pendingFeeSlips, activityLogs] = await Promise.all([
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

    const summary = {
      total_fee: Number(refreshedStudent.total_fee) || 0,
      paid_fee: Number(refreshedStudent.paid_fee) || 0,
      pending_fee: Number(refreshedStudent.pending_fee) || 0,
      fee_records: fees.length,
      payment_events: paymentLogs.length,
      batches_touched: batchHistory.length,
      pending_fee_slips: pendingFeeSlips.length,
      enrollments: enrollments.length,
      activity_events: activityLogs.length,
      is_active: refreshedStudent.is_active !== false,
    };

    res.status(200).json({
      student: refreshedStudent,
      summary,
      batch_history: batchHistory,
      fees: feesWithLogs,
      payment_logs: paymentLogs,
      enrollments,
      pending_fee_slips: pendingFeeSlips,
      activity_logs: activityLogs,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getStudent = async (req, res) => {
  const { id } = req.params;
  try {
    if (!(await denyUnlessOwnStudent(req, res, id))) {
      return;
    }

    const student = await Student.findById(id);
    res.status(200).json(student);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteStudent = async (req, res) => {
  const { id } = req.params;
  try {
    const student = await Student.findById(id);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }
    await User.findOneAndDelete({ email: student.email });
    await Student.findByIdAndDelete(id);
    res.status(200).json("student deleted successfully");
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
  const {
    name,
    email,
    phone,
    cnic,
    admission_date,
    city,
    date_of_birth,
    father_name,
    father_phone,
    latest_degree,
    university,
    completion_year,
    marks_cgpa,
    batch,
    paid_fee,
    pending_fee,
    total_fee,
  } = req.body;
  const { image, cnic_image, cnic_back_image, latest_degree_image } = req.files;

  try {
    const student = await Student.findById(id);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    // Check if the new email is already in use by another student
    if (email && email !== student.email) {
      const existingStudent = await Student.findOne({ email });
      if (existingStudent) {
        return res.status(400).json({ message: "Email already exists" });
      }
    }

    const filesStorageUrl = process.env.FILES_STORAGE_URL;
    const filesStoragePath = process.env.FILES_STORAGE_PATH;

    // Save image to File Storage
    const imageFile = image;
    const imageFileExt = path.extname(imageFile.name);
    const imageFileName = `avatar_${id}${imageFileExt}`;
    await uploadFile(imageFile, imageFileName, `${filesStoragePath}/students/avatars`);
    const imageWebpFileName = `avatar_${id}.jpeg`;
    await compressImage(`${filesStoragePath}/students/avatars/${imageFileName}`, `${filesStoragePath}/students/avatars/${imageWebpFileName}`, 50);
    const imagePath = `${filesStorageUrl}/files/students/avatars/${imageWebpFileName}`

    // Save CNIC image to Firebase storage
    const cnicImageFile = cnic_image;
    const cnicImageFileExt = path.extname(cnicImageFile.name);
    const cnicImageFileName = `cnic_front_${id}${cnicImageFileExt}`;
    await uploadFile(cnicImageFile, cnicImageFileName, `${filesStoragePath}/students/cnic_images`);
    const cnicImageWebpFileName = `cnic_front_${id}.jpeg`;
    await compressImage(`${filesStoragePath}/students/cnic_images/${cnicImageFileName}`, `${filesStoragePath}/students/cnic_images/${cnicImageWebpFileName}`, 50);
    const cnic_imagePath = `${filesStorageUrl}/files/students/cnic_images/${cnicImageWebpFileName}`

    // Save CNIC back image to Firebase storage
    const cnicBackImageFile = cnic_back_image;
    const cnicBackImageFileExt = path.extname(cnicBackImageFile.name);
    const cnicBackImageFileName = `cnic_back_${id}${cnicBackImageFileExt}`;
    await uploadFile(cnicBackImageFile, cnicBackImageFileName, `${filesStoragePath}/students/cnic_images`);
    const cnicBackImageWebpFileName = `cnic_back_${id}.jpeg`;
    await compressImage(`${filesStoragePath}/students/cnic_images/${cnicBackImageFileName}`, `${filesStoragePath}/students/cnic_images/${cnicBackImageWebpFileName}`, 50);
    const cnic_back_imagePath = `${filesStorageUrl}/files/students/cnic_images/${cnicBackImageWebpFileName}`


    // Save Letest Degree image to Firebase storage
    const latestDegreeImageFile = latest_degree_image;
    const latestDegreeImageFileExt = path.extname(latestDegreeImageFile.name);
    const latestDegreeImageFileName = `latest_degree_${id}${latestDegreeImageFileExt}`;
    await uploadFile(latestDegreeImageFile, latestDegreeImageFileName, `${filesStoragePath}/students/latest_degree`);
    const latestDegreeImageWebpFileName = `latest_degree_${id}.jpeg`;
    await compressImage(`${filesStoragePath}/students/latest_degree/${latestDegreeImageFileName}`, `${filesStoragePath}/students/latest_degree/${latestDegreeImageWebpFileName}`, 50);
    const latest_degree_imagePath = `${filesStorageUrl}/files/students/latest_degree/${latestDegreeImageWebpFileName}`

    // Update the student record
    await Student.findByIdAndUpdate(id, {
      name,
      email,
      phone,
      cnic,
      admission_date,
      city,
      date_of_birth,
      father_name,
      father_phone,
      latest_degree,
      university,
      completion_year,
      marks_cgpa,
      batch,
      cnic_image: cnic_imagePath,
      image: imagePath,
      cnic_back_image: cnic_back_imagePath,
      latest_degree_image: latest_degree_imagePath,
      paid_fee,
      pending_fee,
      total_fee,
    });

    res.status(200).json("Student updated successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
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
  const { batch } = req.body;

  if (isStudentRole(req)) {
    return res.status(403).json({ message: "Access denied" });
  }

  if (!batch) {
    return res.status(400).json({ message: "Destination batch is required" });
  }

  try {
    const student = await Student.findById(id);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

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

    if (!(await canAccessBatch(req, batch))) {
      return res.status(403).json({ message: "You do not have access to this batch" });
    }

    const pendingAmount = await getSyncedPendingAmount(id);
    if (pendingAmount > 0) {
      return res
        .status(409)
        .json(await buildPendingFeeBlockPayload(id, pendingAmount));
    }

    student.batch = batch;
    await student.save();

    const updatedStudent = await Student.findById(id).populate("batch");
    res.status(200).json(updatedStudent);
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
          admission_date: {
            $gte: rangeStart
              ? moment.max(moment(rangeStart), moment(monthStart)).format("YYYY-MM-DD")
              : monthStart,
            $lte: rangeEnd
              ? moment.min(moment(rangeEnd), moment(monthEnd)).format("YYYY-MM-DD")
              : monthEnd,
          },
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
      ? await Batch.find({ _id: batch_id })
      : await Batch.find();

    const studentCounts = await Promise.all(
      batches.map(async (batch) => {
        const query = { batch: batch._id };

        if (start_date || end_date) {
          query.admission_date = {};
          if (start_date) query.admission_date.$gte = start_date;
          if (end_date) query.admission_date.$lte = end_date;
        }

        const count = await Student.countDocuments(query);
        return { batch: batch.name, count };
      })
    );

    res.json(studentCounts);
  } catch (error) {
    console.error("Error fetching student data:", error);
    res.status(500).send(error);
  }
};

export const getStudentsContacts = async (req, res) => {
  const { query } = req.query;
  try {
    const searchQuery = query ? query : "";
    const students = await Student.find();
    // Extracting phone numbers from students
    const studentPhones = students.map(student => student.phone);
    res.status(200).json({ total: studentPhones.length, phones: studentPhones });
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

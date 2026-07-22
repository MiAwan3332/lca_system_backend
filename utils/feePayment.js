import Fee from "../models/fees.js";
import FeeLog from "../models/feeLogs.js";
import Student from "../models/students.js";
import moment from "moment-timezone";

export async function createStudentAdmissionFee({
  studentId,
  batchId,
  totalFee,
  payingNow = 0,
  discountAmount = 0,
  discountDescription = "Discount applied on student admission",
  actionUserId,
  paymentMethod,
  paymentEvidence,
  nextInstallmentDate,
}) {
  if (!studentId || !batchId || totalFee <= 0) {
    return null;
  }

  const existingFee = await Fee.findOne({ student: studentId, batch: batchId });
  if (existingFee) {
    throw new Error("Fee record already exists for this student and batch");
  }

  const discount = Number(discountAmount) || 0;
  if (discount < 0) {
    throw new Error("Discount cannot be negative");
  }
  if (discount > totalFee) {
    throw new Error("Discount cannot be greater than total fee");
  }

  const netFee = Math.max(totalFee - discount, 0);
  const isPartialPayment = payingNow > 0 && payingNow < netFee;
  let dueDate = moment().tz("Asia/Karachi").format("YYYY-MM-DD");

  if (isPartialPayment) {
    if (!nextInstallmentDate) {
      throw new Error("Next installment date is required for partial payment");
    }
    dueDate = moment(nextInstallmentDate).tz("Asia/Karachi").format("YYYY-MM-DD");
  }

  const newFee = new Fee({
    student: studentId,
    batch: batchId,
    amount: totalFee,
    due_date: dueDate,
    status: "Pending",
  });
  await newFee.save();

  await new FeeLog({
    amount: totalFee,
    action_amount: totalFee,
    action_date: new Date(),
    action_type: "Created",
    action_by: actionUserId,
    fee: newFee._id,
    student: studentId,
    description: "Fee assigned on student admission",
  }).save();

  if (discount > 0) {
    const originalAmount = newFee.amount;
    newFee.amount = Math.max(originalAmount - discount, 0);
    if (newFee.amount <= 0) {
      newFee.amount = 0;
      newFee.status = "Paid";
    }
    await newFee.save();

    await new FeeLog({
      amount: originalAmount,
      action_amount: discount,
      action_date: new Date(),
      action_type: "Discounted",
      action_by: actionUserId,
      fee: newFee._id,
      student: studentId,
      description: discountDescription || "Discount applied on student admission",
    }).save();
  }

  if (payingNow > 0) {
    await recordFeePayment({
      fee: newFee,
      paymentAmount: payingNow,
      actionUserId,
      studentId,
      paymentMethod,
      paymentEvidence,
      description: `Payment received on student admission (${paymentMethod || "Cash"})`,
    });

    if (isPartialPayment) {
      const updatedFee = await Fee.findById(newFee._id);
      if (updatedFee) {
        updatedFee.due_date = dueDate;
        await updatedFee.save();
      }
    }
  } else if (discount > 0) {
    await syncStudentFeeFromLogs(studentId);
  }

  return newFee;
}

export async function recordFeePayment({
  feeId,
  fee: feeDoc,
  paymentAmount,
  actionUserId,
  studentId,
  paymentMethod,
  paymentEvidence,
  description = "",
  nextInstallmentDate,
}) {
  const fee = feeDoc || (feeId ? await Fee.findById(feeId) : null);
  if (!fee) {
    throw new Error("Fee not found");
  }

  const resolvedStudentId = studentId || fee.student?.toString();
  const amount = Number(paymentAmount);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Payment amount must be greater than 0");
  }

  if (amount > fee.amount) {
    throw new Error("Payment amount exceeds the fee balance");
  }

  if (fee.status === "Paid") {
    throw new Error("Fee already paid");
  }

  const originalAmount = fee.amount;
  fee.amount -= amount;

  if (fee.amount <= 0) {
    fee.amount = 0;
    fee.status = "Paid";
  } else if (nextInstallmentDate) {
    fee.due_date = moment(nextInstallmentDate)
      .tz("Asia/Karachi")
      .format("YYYY-MM-DD");
  }

  await fee.save();

  await new FeeLog({
    amount: originalAmount,
    action_amount: amount,
    action_date: new Date(),
    action_type: "Paid",
    action_by: actionUserId,
    fee: fee._id,
    student: resolvedStudentId,
    payment_method: paymentMethod || "Cash",
    payment_evidence: paymentEvidence || "",
    description,
  }).save();

  if (resolvedStudentId) {
    await syncStudentFeeFromLogs(resolvedStudentId);
  }

  return fee;
}

/**
 * Apply a payment against a student's pending fee records (oldest due first).
 */
export async function collectStudentPendingPayment({
  studentId,
  paymentAmount,
  actionUserId,
  paymentMethod,
  paymentEvidence = "",
  remarks,
  nextInstallmentDate,
  payFull = false,
}) {
  const trimmedRemarks = String(remarks || "").trim();
  if (!trimmedRemarks) {
    throw new Error("Remarks are required");
  }

  let pendingFees = await Fee.find({
    student: studentId,
    status: "Pending",
    amount: { $gt: 0 },
  }).sort({ due_date: 1, _id: 1 });

  // If student shows pending balance but fee rows are missing, create one to collect against
  if (!pendingFees.length) {
    const student = await Student.findById(studentId);
    const studentPending = Math.max(Number(student?.pending_fee) || 0, 0);
    if (!student || studentPending <= 0) {
      throw new Error("No pending fee found for this student");
    }
    if (!student.batch) {
      throw new Error(
        "Student has pending balance but no batch/fee record. Assign a batch first."
      );
    }

    const dueDate = nextInstallmentDate
      ? moment(nextInstallmentDate).tz("Asia/Karachi").format("YYYY-MM-DD")
      : moment().tz("Asia/Karachi").format("YYYY-MM-DD");

    const recoveryFee = await new Fee({
      student: studentId,
      batch: student.batch,
      amount: studentPending,
      due_date: dueDate,
      status: "Pending",
    }).save();

    pendingFees = [recoveryFee];
  }

  const outstanding = pendingFees.reduce(
    (sum, fee) => sum + (Number(fee.amount) || 0),
    0
  );

  let amount = payFull ? outstanding : Number(paymentAmount);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Payment amount must be greater than 0");
  }

  if (amount > outstanding) {
    throw new Error(
      `Payment amount cannot exceed outstanding balance (${outstanding} Rs.)`
    );
  }

  const isPartial = amount < outstanding;
  if (isPartial) {
    if (!nextInstallmentDate) {
      throw new Error("Next installment date is required for partial payment");
    }
    if (moment(nextInstallmentDate).isBefore(moment(), "day")) {
      throw new Error("Next installment date must be today or in the future");
    }
  }

  let remainingToApply = amount;
  const paidFeeIds = [];

  for (const fee of pendingFees) {
    if (remainingToApply <= 0) break;

    const payNow = Math.min(remainingToApply, Number(fee.amount) || 0);
    if (payNow <= 0) continue;

    const willLeaveBalance = payNow < Number(fee.amount);
    const installmentForThisFee =
      willLeaveBalance && isPartial ? nextInstallmentDate : undefined;

    const descriptionParts = [trimmedRemarks];
    if (installmentForThisFee) {
      descriptionParts.push(
        `Next installment due: ${moment(installmentForThisFee)
          .tz("Asia/Karachi")
          .format("YYYY-MM-DD")}`
      );
    }

    await recordFeePayment({
      fee,
      paymentAmount: payNow,
      actionUserId,
      studentId,
      paymentMethod,
      paymentEvidence,
      description: descriptionParts.join(" | "),
      nextInstallmentDate: installmentForThisFee,
    });

    paidFeeIds.push(fee._id);
    remainingToApply -= payNow;
  }

  // If payment cleared one fee but others remain, set installment on remaining
  if (isPartial && nextInstallmentDate) {
    const dueDate = moment(nextInstallmentDate)
      .tz("Asia/Karachi")
      .format("YYYY-MM-DD");
    await Fee.updateMany(
      { student: studentId, status: "Pending", amount: { $gt: 0 } },
      { $set: { due_date: dueDate } }
    );
  }

  const student = await Student.findById(studentId)
    .populate("batch", "name")
    .lean();

  return {
    student,
    amount_paid: amount,
    outstanding_before: outstanding,
    outstanding_after: Math.max(outstanding - amount, 0),
    is_partial: isPartial,
    next_installment_date: isPartial
      ? moment(nextInstallmentDate).tz("Asia/Karachi").format("YYYY-MM-DD")
      : null,
    payment_method: paymentMethod,
    remarks: trimmedRemarks,
    fee_ids: paidFeeIds,
  };
}

export async function syncStudentFeeFromLogs(studentId) {
  const student = await Student.findById(studentId);
  if (!student) return;

  const fees = await Fee.find({ student: studentId });
  if (!fees.length) return;

  const feeIds = fees.map((item) => item._id);

  const [createdLogs, paidLogs, discountedLogs] = await Promise.all([
    FeeLog.find({ fee: { $in: feeIds }, action_type: "Created" }),
    FeeLog.find({ fee: { $in: feeIds }, action_type: "Paid" }),
    FeeLog.find({ fee: { $in: feeIds }, action_type: "Discounted" }),
  ]);

  const totalFee = createdLogs.reduce(
    (sum, log) => sum + (Number(log.action_amount) || Number(log.amount) || 0),
    0
  );
  const paidFee = paidLogs.reduce(
    (sum, log) => sum + (Number(log.action_amount) || 0),
    0
  );
  const discountedFee = discountedLogs.reduce(
    (sum, log) => sum + (Number(log.action_amount) || 0),
    0
  );
  const pendingFee = fees
    .filter((item) => item.status === "Pending")
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

  student.total_fee = Math.max(totalFee - discountedFee, 0);
  student.paid_fee = paidFee;
  student.pending_fee = Math.max(pendingFee, 0);

  await student.save();
}

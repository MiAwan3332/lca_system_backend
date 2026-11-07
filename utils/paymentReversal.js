import mongoose from 'mongoose';
import Fee from '../models/fees.js';
import FeeLog from '../models/feeLogs.js';
import FeeReceipt from '../models/feeReceipts.js';
import Student from '../models/students.js';
import RefundRequest from '../models/refundRequests.js';
import AdmissionSlipVerification from '../models/admissionSlipVerification.js';
import PaymentReversal from '../models/paymentReversals.js';
import { accessContext } from './accessContext.js';
import { studentFeeTotals, syncStudentFeeFromLogs } from './feePayment.js';

export const REVERSAL_REASONS = ['Payment never received', 'Wrong amount', 'Wrong student', 'Duplicate entry', 'Other'];
// Steps of a student's fee timeline that can be undone, newest first, each exactly as it was made.
export const UNDO_STEP_TYPES = ['Paid', 'Discounted', 'Refund', 'Created'];
export const STEP_LABELS = { Paid: 'Payment', Discounted: 'Discount', Refund: 'Refund', Created: 'Fee assignment' };
// Entries of one older collection (saved before payments carried a payment_id) were written within this window.
const LEGACY_WINDOW_MS = 2 * 60 * 1000;
const TOTAL_FIELDS = ['total_fee', 'paid_fee', 'pending_fee', 'cash_amount', 'online_amount'];

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const amountOf = (log) => Number(log.action_amount) || 0;
const time = (value) => new Date(value || 0).getTime();
const pick = (doc, keys) => Object.fromEntries(keys.map((key) => [key, doc?.[key] ?? 0]));
const rs = (value) => `Rs ${Number(value || 0).toLocaleString('en-PK')}`;

/** Timeline order: when the step was made, then the order it was saved (steps of one admission share a time). */
export const timelineOrder = (a, b) => time(a.action_date) - time(b.action_date) || String(a._id).localeCompare(String(b._id));

async function studentLogs(studentId) {
  const fees = await Fee.find({ student: studentId }).lean();
  const logs = await FeeLog.find({ $or: [{ student: studentId }, { fee: { $in: fees.map((fee) => fee._id) } }] }).lean();
  return { fees, logs: logs.filter((item) => UNDO_STEP_TYPES.includes(item.action_type)).sort(timelineOrder) };
}

// The whole collection a payment entry belongs to, used only to find the receipt and slip issued for it.
function paymentCollection(log, logs) {
  const paid = logs.filter((item) => item.action_type === 'Paid');
  if (log.payment_id) return { legacy: false, entries: paid.filter((item) => item.payment_id === log.payment_id) };
  return { legacy: true, entries: paid.filter((item) => !item.payment_id && String(item.action_by || '') === String(log.action_by || '') &&
    Math.abs(time(item.action_date) - time(log.action_date)) <= LEGACY_WINDOW_MS) };
}

async function linkedReceipts(student, group, total, legacy) {
  if (!legacy) return FeeReceipt.find({ student: student._id, payment_id: group[0].payment_id }).lean();
  const first = Math.min(...group.map((item) => time(item.action_date)));
  const last = Math.max(...group.map((item) => time(item.action_date)));
  return FeeReceipt.find({ student: student._id, payment_id: null, 'payload.payingNow': total,
    createdAt: { $gte: new Date(first - LEGACY_WINDOW_MS), $lte: new Date(last + LEGACY_WINDOW_MS) } }).lean();
}

async function linkedSlips(student, group, total, legacy) {
  const ids = group.map((item) => item._id);
  const linked = { slip_type: 'fee', cancelled_at: null, $or: [{ payment_log: { $in: ids } }, ...(legacy ? [] : [{ payment_id: group[0].payment_id }])] };
  if (!legacy) return AdmissionSlipVerification.find(linked).lean();
  // Older slips carry no link: match the fee slips issued for this student and amount after the payment.
  const first = Math.min(...group.map((item) => time(item.action_date)));
  return AdmissionSlipVerification.find({ $or: [linked, { slip_type: 'fee', cancelled_at: null, payment_id: null, payment_log: null,
    $and: [{ $or: [{ student: student._id }, { student: null, student_name: student.name }] }],
    amount_received: total, issued_at: { $gte: new Date(first - LEGACY_WINDOW_MS) } }] }).lean();
}

/** Everything undoing this timeline step would change, and what stops or warns about it. Runs outside the caller's record scope:
 *  the route already authorized the chosen entry, and the student's whole timeline is needed to check it is the newest step. */
export function planPaymentReversal(logId) {
  return accessContext.run(undefined, async () => {
    const log = mongoose.isValidObjectId(logId) ? await FeeLog.findById(logId).lean() : null;
    if (!log || !UNDO_STEP_TYPES.includes(log.action_type)) throw fail('Choose a payment, discount, refund or fee assignment to undo.', 404);
    const fee = log.fee ? await Fee.findById(log.fee).lean() : null;
    const student = await Student.findById(log.student || fee?.student).populate('batch', 'name').lean();
    if (!student) throw fail('The student for this entry no longer exists.', 404);
    const { fees, logs } = await studentLogs(student._id);
    const type = log.action_type, label = STEP_LABELS[type], amount = amountOf(log);
    const blockers = [], warnings = [];

    const newest = logs[logs.length - 1];
    if (newest && String(newest._id) !== String(log._id)) {
      blockers.push(`Steps are undone newest first. Undo the latest step first: ${STEP_LABELS[newest.action_type].toLowerCase()} of ${rs(amountOf(newest))} on ${new Date(newest.action_date).toLocaleDateString('en-GB')}.`);
    }

    // The fee balance goes back exactly as the step changed it; a fee assignment removes the fee it created.
    const fee_changes = [];
    if (type !== 'Refund') {
      if (!fee) blockers.push(`The fee record this ${label.toLowerCase()} belongs to has been deleted, so it cannot be undone.`);
      else if (type === 'Created') fee_changes.push({ fee: fee._id, before_amount: Number(fee.amount) || 0, before_status: fee.status, removes_fee: true });
      else {
        const after = (Number(fee.amount) || 0) + amount;
        fee_changes.push({ fee: fee._id, before_amount: Number(fee.amount) || 0, before_status: fee.status, after_amount: after, after_status: after > 0 ? 'Pending' : fee.status });
      }
      if (fee && String(fee.batch || '') !== String(student.batch?._id || '')) warnings.push(`The student has moved to another batch since this ${label.toLowerCase()}. It is undone on the fee of the earlier batch.`);
    }

    let receipts = [], slips = [], legacy = false, refund_request = null;
    if (type === 'Paid') {
      const collection = paymentCollection(log, logs);
      legacy = collection.legacy;
      const total = collection.entries.reduce((sum, item) => sum + amountOf(item), 0);
      [receipts, slips] = await Promise.all([linkedReceipts(student, collection.entries, total, legacy), linkedSlips(student, collection.entries, total, legacy)]);
      const open = await RefundRequest.countDocuments({ student: student._id, status: { $ne: 'Rejected' }, is_refunded: { $ne: true },
        createdAt: { $gte: new Date(time(log.action_date) - LEGACY_WINDOW_MS) } });
      if (open) blockers.push('A refund request made after this payment is still open. Reject it before undoing the payment.');
      if (legacy && (receipts.length || slips.length)) warnings.push('This payment was recorded before payments were linked to their receipts and slips. The receipt and slip below were found by matching the amount and time; check they are the right ones.');
    }
    if (type === 'Refund') {
      refund_request = await RefundRequest.findOne({ fee_log: log._id }).lean();
      if (!refund_request) warnings.push('No refund request is linked to this refund. Only the refund entry is removed.');
    }

    const afterFees = fees.flatMap((item) => {
      const change = fee_changes.find((entry) => String(entry.fee) === String(item._id));
      if (!change) return [item];
      return change.removes_fee ? [] : [{ ...item, amount: change.after_amount, status: change.after_status }];
    });
    return {
      log, type, label, amount, student, fee, legacy, receipts, slips, refund_request, blockers, warnings, fee_changes,
      totals_before: pick(student, TOTAL_FIELDS),
      totals_after: studentFeeTotals(afterFees, logs.filter((item) => String(item._id) !== String(log._id))),
    };
  });
}

/** The confirmation popup's view of an undo plan. */
export async function paymentReversalPreview(plan) {
  const [batch, actor] = await accessContext.run(undefined, () => Promise.all([
    plan.fee?.batch ? mongoose.models.Batch.findById(plan.fee.batch).select('name').lean() : null,
    plan.log.action_by ? mongoose.models.User.findById(plan.log.action_by).select('name').lean() : null,
  ]));
  return {
    student: { _id: plan.student._id, name: plan.student.name, roll_number: plan.student.roll_number, batch: plan.student.batch?.name || '' },
    step: { _id: plan.log._id, type: plan.type, label: plan.label, amount: plan.amount, date: plan.log.action_date, by: actor?.name || '',
      description: plan.log.description || '', payment_method: plan.log.payment_method || '', payment_evidence: plan.log.payment_evidence || '', batch: batch?.name || '' },
    receipts: plan.receipts.map((item) => ({ _id: item._id, amount: item.payload?.payingNow, created_at: item.createdAt })),
    slips: plan.slips.map((item) => ({ _id: item._id, amount: item.amount_received, issued_at: item.issued_at })),
    fee_changes: plan.fee_changes.map((item) => ({ ...item, batch: batch?.name || '' })),
    refund_request: plan.refund_request ? { _id: plan.refund_request._id, amount: plan.refund_request.amount, reason: plan.refund_request.reason || '' } : null,
    totals_before: plan.totals_before, totals_after: plan.totals_after,
    blockers: plan.blockers, warnings: plan.warnings, legacy: plan.legacy, reasons: REVERSAL_REASONS,
  };
}

// Each step is safe to repeat: a step already done is skipped, and a change is only made while the record still holds the value it was planned from.
async function runSteps(reversal) {
  const mark = async (step) => { reversal.steps[step] = true; await PaymentReversal.updateOne({ _id: reversal._id }, { $set: { [`steps.${step}`]: true } }); };
  if (!reversal.steps.fees) {
    for (const change of reversal.fee_changes) {
      if (change.removes_fee) {
        const result = await Fee.deleteOne({ _id: change.fee, amount: change.before_amount, status: change.before_status });
        if (!result.deletedCount && await Fee.exists({ _id: change.fee })) throw fail('The fee changed while it was being undone. Nothing more was changed; open the entry again to review it.');
        continue;
      }
      const result = await Fee.updateOne({ _id: change.fee, amount: change.before_amount, status: change.before_status },
        { $set: { amount: change.after_amount, status: change.after_status } });
      if (!result.modifiedCount && !(await Fee.exists({ _id: change.fee, amount: change.after_amount, status: change.after_status }))) {
        throw fail('A fee balance changed while the entry was being undone. Nothing more was changed; open the entry again to review it.');
      }
    }
    await mark('fees');
  }
  if (!reversal.steps.receipts) {
    await FeeReceipt.deleteMany({ _id: { $in: (reversal.removed.receipts || []).map((item) => item._id) } });
    await mark('receipts');
  }
  if (!reversal.steps.slips) {
    await AdmissionSlipVerification.updateMany({ _id: { $in: (reversal.removed.slips || []).map((item) => item._id) }, cancelled_at: null },
      { $set: { cancelled_at: reversal.reverted_at, cancelled_reason: `Payment undone: ${reversal.reason_category}` } });
    await mark('slips');
  }
  // A refund goes back to approved and not yet paid out, and the student it deactivated is active again.
  if (!reversal.steps.refund) {
    for (const request of reversal.removed.refund_requests || []) {
      await RefundRequest.updateOne({ _id: request._id, fee_log: reversal.payment_log },
        { $set: { is_refunded: false, refund_evidence: '' }, $unset: { refunded_amount: 1, refunded_by: 1, refunded_at: 1, fee_log: 1 } });
    }
    if ((reversal.step_type || 'Paid') === 'Refund') await Student.updateOne({ _id: reversal.student }, { $set: { is_active: true } });
    await mark('refund');
  }
  // The timeline entry goes last: while it remains, the undo can still be found and finished from it.
  if (!reversal.steps.logs) {
    await FeeLog.deleteOne({ _id: reversal.payment_log });
    await mark('logs');
  }
}

/** Undoes the newest timeline step, or finishes an earlier undo of it that was interrupted. */
export function revertPayment({ logId, reasonCategory, reasonNote, acknowledged, actorId, ip }) {
  return accessContext.run(undefined, async () => {
    let reversal = await PaymentReversal.findOne({ payment_log: logId });
    if (reversal?.status === 'completed') throw fail('This entry has already been undone.');
    if (!reversal) {
      if (!REVERSAL_REASONS.includes(reasonCategory)) throw fail('Choose why this entry is being undone.', 400);
      if (String(reasonNote || '').trim().length < 10) throw fail('Describe the reason in at least 10 characters.', 400);
      const plan = await planPaymentReversal(logId);
      if (plan.blockers.length) throw fail(plan.blockers.join(' '));
      if (plan.warnings.length && acknowledged !== true) throw fail('Confirm the warnings before undoing this entry.', 400);
      reversal = await PaymentReversal.create({
        student: plan.student._id, payment_log: plan.log._id, payment_id: plan.log.payment_id, step_type: plan.type, amount: plan.amount,
        payment_method: plan.log.payment_method || '', payment_date: plan.log.action_date,
        collected_by: plan.log.action_by, reason_category: reasonCategory, reason_note: String(reasonNote).trim(), warnings: plan.warnings,
        reverted_by: actorId, ip, fee_changes: plan.fee_changes, totals_before: plan.totals_before, totals_after: plan.totals_after,
        removed: { logs: [plan.log], fees: plan.fee ? [plan.fee] : [], receipts: plan.receipts, slips: plan.slips,
          refund_requests: plan.refund_request ? [plan.refund_request] : [], students: plan.type === 'Refund' ? [{ _id: plan.student._id, is_active: plan.student.is_active }] : [] },
      });
    }
    try {
      await runSteps(reversal);
    } catch (error) {
      await PaymentReversal.updateOne({ _id: reversal._id }, { $set: { status: 'incomplete', error: error.message } });
      throw Object.assign(error, { status: error.status || 500, message: `${error.message} The undo was saved as incomplete; open this entry and undo it again to finish.` });
    }
    // The student totals are a cache rebuilt from fees and logs (also on every profile open), so they never block completion.
    const student = await syncStudentFeeFromLogs(reversal.student).catch(() => null);
    const totals = student ? pick(student, TOTAL_FIELDS) : reversal.totals_after;
    await PaymentReversal.updateOne({ _id: reversal._id }, { $set: { status: 'completed', error: '', totals_after: totals } });
    return PaymentReversal.findById(reversal._id).lean();
  });
}

/** Undone steps shown on a student's fee timeline (without the stored copies). */
export function studentPaymentReversals(studentId) {
  return accessContext.run(undefined, () => PaymentReversal.find({ student: studentId }).select('-removed -ip').sort({ reverted_at: -1 })
    .populate('reverted_by', 'name').populate('collected_by', 'name').lean());
}

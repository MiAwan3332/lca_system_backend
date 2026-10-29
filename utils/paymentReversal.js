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
// Entries of one older collection (saved before payments carried a payment_id) were written within this window.
const LEGACY_WINDOW_MS = 2 * 60 * 1000;
const TOTAL_FIELDS = ['total_fee', 'paid_fee', 'pending_fee', 'cash_amount', 'online_amount'];

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const amountOf = (log) => Number(log.action_amount) || 0;
const time = (value) => new Date(value || 0).getTime();
const pick = (doc, keys) => Object.fromEntries(keys.map((key) => [key, doc?.[key] ?? 0]));

async function studentLogs(studentId) {
  const fees = await Fee.find({ student: studentId }).lean();
  const logs = await FeeLog.find({ $or: [{ student: studentId }, { fee: { $in: fees.map((fee) => fee._id) } }] }).lean();
  return { fees, logs };
}

// Every Paid entry recorded by the same collection as the chosen one.
function paymentGroup(log, logs) {
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

/** Everything reverting the payment would change, and what stops or warns about it. Runs outside the caller's record scope:
 *  the route already authorized the chosen payment entry, and the student's whole record is needed to check it safely. */
export function planPaymentReversal(logId) {
  return accessContext.run(undefined, async () => {
    const log = mongoose.isValidObjectId(logId) ? await FeeLog.findById(logId).lean() : null;
    if (!log || log.action_type !== 'Paid') throw fail('Choose a recorded payment to revert.', 404);
    const fee = log.fee ? await Fee.findById(log.fee).lean() : null;
    const student = await Student.findById(log.student || fee?.student).populate('batch', 'name').lean();
    if (!student) throw fail('The student for this payment no longer exists.', 404);
    const { fees, logs } = await studentLogs(student._id);
    const { legacy, entries } = paymentGroup(log, logs);
    const ids = new Set(entries.map((item) => String(item._id)));
    const total = entries.reduce((sum, item) => sum + amountOf(item), 0);
    const paidAt = Math.max(...entries.map((item) => time(item.action_date)));
    const feesById = new Map(fees.map((item) => [String(item._id), item]));
    const blockers = [], warnings = [];

    const changes = new Map();
    for (const entry of entries) {
      const record = feesById.get(String(entry.fee));
      if (!record) { blockers.push('A fee record this payment was applied to has been deleted, so its balance cannot be restored.'); continue; }
      const change = changes.get(String(record._id)) || { fee: record._id, batch: record.batch, before_amount: Number(record.amount) || 0, before_status: record.status };
      change.after_amount = (change.after_amount ?? change.before_amount) + amountOf(entry);
      change.after_status = change.after_amount > 0 ? 'Pending' : change.before_status;
      changes.set(String(record._id), change);
    }
    const later = logs.filter((item) => !ids.has(String(item._id)) && time(item.action_date) > paidAt);
    const laterPaid = later.filter((item) => item.action_type === 'Paid');
    if (laterPaid.length) blockers.push(`${laterPaid.length === 1 ? 'A later payment' : `${laterPaid.length} later payments`} of Rs ${laterPaid.map(amountOf).join(', Rs ')} ${laterPaid.length === 1 ? 'was' : 'were'} recorded after this one. Undo the newest payment first.`);
    if (later.some((item) => item.action_type === 'Refund')) blockers.push('A refund was paid out after this payment. Payments with a refund cannot be reverted.');
    const refunds = await RefundRequest.countDocuments({ student: student._id, status: { $ne: 'Rejected' }, createdAt: { $gte: new Date(paidAt - LEGACY_WINDOW_MS) } });
    if (refunds) blockers.push('A refund request was made after this payment. Reject or settle it before reverting.');
    if (later.some((item) => item.action_type === 'Discounted' && changes.has(String(item.fee)))) warnings.push('A discount was given on this fee after the payment. The discount stays as it is.');
    const sameTime = logs.filter((item) => item.action_type === 'Discounted' && String(item.action_by || '') === String(log.action_by || '') &&
      Math.abs(time(item.action_date) - paidAt) <= LEGACY_WINDOW_MS);
    if (sameTime.length) warnings.push(`A discount of Rs ${sameTime.reduce((sum, item) => sum + amountOf(item), 0)} was given together with this payment. Only the payment is reverted; the discount stays.`);
    if ([...changes.values()].some((item) => String(item.batch || '') !== String(student.batch?._id || ''))) warnings.push('The student has moved to another batch since this payment. The amount goes back onto the fee of the earlier batch.');
    if (legacy) warnings.push('This payment was recorded before payments were linked to their receipts and slips. The receipt and slip below were found by matching the amount and time; check they are the right ones.');

    const [receipts, slips] = await Promise.all([linkedReceipts(student, entries, total, legacy), linkedSlips(student, entries, total, legacy)]);
    const afterFees = fees.map((item) => changes.has(String(item._id)) ? { ...item, amount: changes.get(String(item._id)).after_amount, status: changes.get(String(item._id)).after_status } : item);
    return {
      log, student, legacy, entries, receipts, slips, blockers, warnings, total,
      fee_changes: [...changes.values()].map(({ batch, ...change }) => change),
      totals_before: pick(student, TOTAL_FIELDS),
      totals_after: studentFeeTotals(afterFees, logs.filter((item) => !ids.has(String(item._id)))),
    };
  });
}

/** The confirmation popup's view of a reversal plan. */
export async function paymentReversalPreview(plan) {
  const [fees, collector] = await accessContext.run(undefined, () => Promise.all([
    Fee.find({ _id: { $in: plan.fee_changes.map((item) => item.fee) } }).select('batch').populate('batch', 'name').lean(),
    plan.log.action_by ? mongoose.models.User.findById(plan.log.action_by).select('name').lean() : null,
  ]));
  const feeBatch = new Map(fees.map((item) => [String(item._id), item.batch?.name || '']));
  return {
    student: { _id: plan.student._id, name: plan.student.name, roll_number: plan.student.roll_number, batch: plan.student.batch?.name || '' },
    payment: { _id: plan.log._id, amount: plan.total, date: plan.log.action_date, collected_by: collector?.name || '', description: plan.log.description || '',
      methods: [...new Set(plan.entries.map((item) => item.payment_method || 'Cash'))], payment_evidence: plan.log.payment_evidence || '' },
    entries: plan.entries.map((item) => ({ _id: item._id, amount: amountOf(item), payment_method: item.payment_method, date: item.action_date, batch: feeBatch.get(String(item.fee)) || '' })),
    receipts: plan.receipts.map((item) => ({ _id: item._id, amount: item.payload?.payingNow, created_at: item.createdAt })),
    slips: plan.slips.map((item) => ({ _id: item._id, amount: item.amount_received, issued_at: item.issued_at })),
    fee_changes: plan.fee_changes.map((item) => ({ ...item, batch: feeBatch.get(String(item.fee)) || '' })),
    totals_before: plan.totals_before, totals_after: plan.totals_after,
    blockers: plan.blockers, warnings: plan.warnings, legacy: plan.legacy, reasons: REVERSAL_REASONS,
  };
}

// Each step is safe to repeat: a step already done is skipped, and a change is only made while the record still holds the value it was planned from.
async function runSteps(reversal) {
  const mark = async (step) => { reversal.steps[step] = true; await PaymentReversal.updateOne({ _id: reversal._id }, { $set: { [`steps.${step}`]: true } }); };
  if (!reversal.steps.fees) {
    for (const change of reversal.fee_changes) {
      const result = await Fee.updateOne({ _id: change.fee, amount: change.before_amount, status: change.before_status },
        { $set: { amount: change.after_amount, status: change.after_status } });
      if (!result.modifiedCount && !(await Fee.exists({ _id: change.fee, amount: change.after_amount, status: change.after_status }))) {
        throw fail('A fee balance changed while the payment was being reverted. Nothing more was changed; open the payment again to review it.');
      }
    }
    await mark('fees');
  }
  if (!reversal.steps.receipts) {
    await FeeReceipt.deleteMany({ _id: { $in: reversal.removed.receipts.map((item) => item._id) } });
    await mark('receipts');
  }
  if (!reversal.steps.slips) {
    await AdmissionSlipVerification.updateMany({ _id: { $in: reversal.removed.slips.map((item) => item._id) }, cancelled_at: null },
      { $set: { cancelled_at: reversal.reverted_at, cancelled_reason: `Payment reverted: ${reversal.reason_category}` } });
    await mark('slips');
  }
  // Payment entries go last: while any remain, the reversal can still be found and finished from its payment.
  if (!reversal.steps.logs) {
    await FeeLog.deleteMany({ _id: { $in: reversal.removed.logs.map((item) => item._id) }, action_type: 'Paid' });
    await mark('logs');
  }
}

/** Reverts a payment, or finishes an earlier reversal of it that was interrupted. */
export function revertPayment({ logId, reasonCategory, reasonNote, acknowledged, actorId, ip }) {
  return accessContext.run(undefined, async () => {
    let reversal = await PaymentReversal.findOne({ payment_log: logId });
    if (reversal?.status === 'completed') throw fail('This payment has already been reverted.');
    if (!reversal) {
      if (!REVERSAL_REASONS.includes(reasonCategory)) throw fail('Choose why this payment is being reverted.', 400);
      if (String(reasonNote || '').trim().length < 10) throw fail('Describe the reason in at least 10 characters.', 400);
      const plan = await planPaymentReversal(logId);
      if (plan.blockers.length) throw fail(plan.blockers.join(' '));
      if (plan.warnings.length && acknowledged !== true) throw fail('Confirm the warnings before reverting this payment.', 400);
      const feeDocs = await Fee.find({ _id: { $in: plan.fee_changes.map((item) => item.fee) } }).lean();
      reversal = await PaymentReversal.create({
        student: plan.student._id, payment_log: plan.log._id, payment_id: plan.log.payment_id, amount: plan.total,
        payment_method: [...new Set(plan.entries.map((item) => item.payment_method || 'Cash'))].join(', '), payment_date: plan.log.action_date,
        collected_by: plan.log.action_by, reason_category: reasonCategory, reason_note: String(reasonNote).trim(), warnings: plan.warnings,
        reverted_by: actorId, ip, fee_changes: plan.fee_changes, totals_before: plan.totals_before, totals_after: plan.totals_after,
        removed: { logs: plan.entries, fees: feeDocs, receipts: plan.receipts, slips: plan.slips },
      });
    }
    try {
      await runSteps(reversal);
    } catch (error) {
      await PaymentReversal.updateOne({ _id: reversal._id }, { $set: { status: 'incomplete', error: error.message } });
      throw Object.assign(error, { status: error.status || 500, message: `${error.message} The reversal was saved as incomplete; open this payment and revert it again to finish.` });
    }
    // The student totals are a cache rebuilt from fees and logs (also on every profile open), so they never block completion.
    const student = await syncStudentFeeFromLogs(reversal.student).catch(() => null);
    const totals = student ? pick(student, TOTAL_FIELDS) : reversal.totals_after;
    await PaymentReversal.updateOne({ _id: reversal._id }, { $set: { status: 'completed', error: '', totals_after: totals } });
    return PaymentReversal.findById(reversal._id).lean();
  });
}

/** Reversals shown on a student's payment timeline (without the stored copies). */
export function studentPaymentReversals(studentId) {
  return accessContext.run(undefined, () => PaymentReversal.find({ student: studentId }).select('-removed -ip').sort({ reverted_at: -1 })
    .populate('reverted_by', 'name').populate('collected_by', 'name').lean());
}

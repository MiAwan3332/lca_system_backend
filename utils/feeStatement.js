import Fee from '../models/fees.js';
import FeeLog from '../models/feeLogs.js';

export async function batchFeeStatements(studentIds) {
  const result = new Map();
  if (!studentIds.length) return result;
  const fees = await Fee.find({ student: { $in: studentIds } }).select('_id student batch amount status').lean();
  const byFee = new Map();
  for (const fee of fees) {
    const key = `${fee.student}:${fee.batch}`;
    byFee.set(String(fee._id), key);
    const totals = result.get(key) || { totalFee: 0, paidFee: 0, remainingAfter: 0 };
    if (fee.status === 'Pending') totals.remainingAfter += Math.max(Number(fee.amount) || 0, 0);
    result.set(key, totals);
  }
  const rows = await FeeLog.aggregate([{ $match: { fee: { $in: fees.map((fee) => fee._id) } } },
    { $group: { _id: { fee: '$fee', action: '$action_type' }, total: { $sum: { $ifNull: ['$action_amount', '$amount'] } } } }]);
  for (const row of rows) {
    const totals = result.get(byFee.get(String(row._id.fee)));
    if (row._id.action === 'Created') totals.totalFee += row.total;
    if (row._id.action === 'Discounted') totals.totalFee -= row.total;
    if (row._id.action === 'Paid') totals.paidFee += row.total;
    if (row._id.action === 'Refund') totals.paidFee -= row.total;
  }
  return result;
}

export async function feeStatement(studentId, batchIds) {
  const fees = await Fee.find({ student: studentId, ...(batchIds?.length ? { batch: { $in: batchIds } } : {}) }).select('_id amount status batch');
  const rows = await FeeLog.aggregate([{ $match: { fee: { $in: fees.map((fee) => fee._id) } } },
    { $group: { _id: '$action_type', total: { $sum: { $ifNull: ['$action_amount', '$amount'] } } } }]);
  const totals = Object.fromEntries(rows.map((row) => [row._id, row.total]));
  return { totalFee: Math.max((totals.Created || 0) - (totals.Discounted || 0), 0),
    paidFee: Math.max((totals.Paid || 0) - (totals.Refund || 0), 0),
    remainingAfter: fees.filter((fee) => fee.status === 'Pending').reduce((sum, fee) => sum + Math.max(Number(fee.amount) || 0, 0), 0) };
}

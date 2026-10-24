import Student from '../models/students.js';
import FeeReceipt from '../models/feeReceipts.js';
import { identityForRequest } from './studentIdentity.js';

export async function latestFeeReceipt(req, res, next) {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) return res.status(404).json({ message: 'Student not found' });
    await identityForRequest({ ...req, body: { phone: student.phone } });
    const receipt = await FeeReceipt.findOne({ student: student._id }).sort({ createdAt: -1 }).lean();
    if (!receipt) return res.status(404).json({ message: 'No saved payment receipt exists yet' });
    res.set('Cache-Control', 'no-store').json({ ...receipt.payload, receiptId: String(receipt._id) });
  } catch (error) { next(error); }
}

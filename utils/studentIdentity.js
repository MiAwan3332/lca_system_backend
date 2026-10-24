import Student from '../models/students.js';
import User from '../models/users.js';
import Fee from '../models/fees.js';
import { canAccessBatch, isInstitutionAdmin } from './lmsAccess.js';

export const normalizedStudentPhone = (value) => String(value || '').replace(/\D/g, '').slice(-10);
const failure = (message, code = 'IDENTITY_CONFLICT') => Object.assign(new Error(message), { status: 409, code });

export async function resolveStudentIdentity(phone) {
  const normalized = normalizedStudentPhone(phone);
  if (normalized.length !== 10) throw Object.assign(new Error('Enter a valid phone number with at least ten digits'), { status: 400 });
  const regex = new RegExp(`${normalized.split('').join('\\D*')}$`);
  const students = await Student.find({ $or: [{ normalized_phone: normalized }, { phone: regex }] }).limit(3);
  if (students.length > 1) throw failure('Multiple existing students match this phone. An administrator must resolve them before admission.');
  const student = students[0] || null;
  const users = await User.find({ $or: [{ phone: regex }, { email: student?.email || `student.${String(phone).replace(/\D/g, '')}@lca.local` },
    { email: new RegExp(`^student\\.\\d*${normalized}@lca\\.local$`, 'i') }] }).limit(3);
  if (student?.user) {
    const linked = await User.findById(student.user);
    if (linked && !users.some((user) => String(user._id) === String(linked._id))) users.push(linked);
  }
  if (users.some((user) => String(user.role).toLowerCase() !== 'student')) throw failure('This phone belongs to a non-student account. An administrator must review it.');
  if (users.length > 1) throw failure('Multiple login accounts match this student. An administrator must resolve them first.');
  const user = users[0] || null;
  if (user && await Student.exists({ ...(student ? { _id: { $ne: student._id } } : {}), $or: [{ user: user._id }, { email: user.email }] })) {
    throw failure('This login is linked to another student profile. An administrator must resolve the identity conflict.');
  }
  if (student && !user) throw failure('The existing student login is missing. Repair the account instead of creating a duplicate.');
  return { normalized, student, user };
}

export async function pendingStudentDues(studentId) {
  const dues = await Fee.aggregate([
    { $match: { student: studentId, status: 'Pending', amount: { $gt: 0 } } },
    { $group: { _id: '$batch', pending: { $sum: '$amount' }, due_date: { $min: '$due_date' } } },
    { $lookup: { from: 'batches', localField: '_id', foreignField: '_id', as: 'batch' } },
    { $project: { _id: 0, batch_id: '$_id', batch_name: { $ifNull: [{ $arrayElemAt: ['$batch.name', 0] }, 'Unassigned'] }, pending: 1, due_date: 1 } },
  ]);
  if (!dues.length && !await Fee.exists({ student: studentId })) {
    const student = await Student.findById(studentId).select('pending_fee batch');
    if (student?.pending_fee > 0) dues.push({ batch_id: student.batch, batch_name: 'Legacy balance (finance review required)', pending: student.pending_fee });
  }
  return dues;
}

export async function identityForRequest(req) {
  const actor = await User.findById(req.user?.user?.id).select('role').lean();
  const scoped = { ...req, user: { user: { ...req.user?.user, role: actor?.role } } };
  if (!actor?.role || !isInstitutionAdmin(scoped)) throw Object.assign(new Error('Staff admission access required'), { status: 403 });
  const identity = await resolveStudentIdentity(req.body?.phone || req.query.phone);
  if (identity.student?.batch && !await canAccessBatch(scoped, identity.student.batch)) throw Object.assign(new Error('Student access denied'), { status: 403 });
  return identity;
}

export async function lookupStudentIdentity(req, res, next) {
  try {
    const { student, user } = await identityForRequest(req);
    const dues = student ? await pendingStudentDues(student._id) : [];
    res.set('Cache-Control', 'no-store').json({ found: Boolean(student || user), student: student ? {
      _id: student._id, name: student.name, phone: student.phone, cnic: student.cnic, batch: student.batch, roll_number: student.roll_number,
    } : null, existing_user: Boolean(user), dues, pending_total: dues.reduce((sum, item) => sum + item.pending, 0) });
  } catch (error) { next(error); }
}

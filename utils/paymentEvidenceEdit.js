import crypto from 'node:crypto';
import Student from '../models/students.js';
import User from '../models/users.js';
import FeeLog from '../models/feeLogs.js';
import CreationRequest from '../models/creationRequests.js';
import { stageCreationFiles, creationResponse } from './creationService.js';
import { getPaymentEvidenceUrls } from './paymentEvidence.js';
import { identityForRequest } from './studentIdentity.js';

export async function listEvidencePayments(req, res, next) {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) return res.status(404).json({ message: 'Student not found' });
    await identityForRequest({ ...req, body: { phone: student.phone } });
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));
    const page = Math.max(1, Number(req.query.page) || 1);
    const result = await FeeLog.paginate({ student: student._id, action_type: 'Paid' },
      { page, limit, sort: { action_date: -1, _id: -1 }, select: 'action_date action_amount payment_method payment_evidence evidence_status evidence_edit_request' });
    res.json(result);
  } catch (error) { next(error); }
}

export async function editPaymentEvidence(req, res, next) {
  let journal;
  try {
    const student = await Student.findById(req.params.id);
    if (!student) return res.status(404).json({ message: 'Student not found' });
    await identityForRequest({ ...req, body: { phone: student.phone } });
    const log = await FeeLog.findOne({ _id: req.params.logId, student: student._id, action_type: 'Paid' });
    if (!log) return res.status(404).json({ message: 'Payment not found for this student' });
    const key = req.get('Idempotency-Key');
    if (!/^[\w-]{16,128}$/.test(key || '')) return res.status(400).json({ message: 'Idempotency-Key is required' });
    const incomingFiles = req.files?.payment_evidence ? [].concat(req.files.payment_evidence) : [];
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ target: String(log._id), keep: req.body.keep_evidence || '[]',
      files: incomingFiles.map((file) => ({ name: file.name, size: file.size, md5: file.md5 })) })).digest('hex');
    const previous = await CreationRequest.findOne({ actor: req.user.user.id, kind: 'student', key });
    if (previous) {
      if (previous.operation !== 'evidence' || previous.target !== String(log._id) || String(previous.recordId) !== String(student._id) || previous.fingerprint !== fingerprint) {
        return res.status(409).json({ message: 'This submission key belongs to a different operation' });
      }
      return res.status(202).json(await creationResponse(previous));
    }
    let keep;
    try { keep = JSON.parse(req.body.keep_evidence || '[]'); }
    catch { return res.status(400).json({ message: 'Invalid retained evidence list' }); }
    const original = getPaymentEvidenceUrls(log.payment_evidence);
    if (!Array.isArray(keep) || keep.some((url) => !original.includes(url))) return res.status(400).json({ message: 'Only existing payment attachments may be retained' });
    const incoming = req.files?.payment_evidence;
    const count = Array.isArray(incoming) ? incoming.length : incoming ? 1 : 0;
    if (keep.length + count > 10 || keep.length + count < 1) return res.status(400).json({ message: 'Retain or upload between one and ten evidence files' });
    if (log.evidence_status === 'pending') return res.status(409).json({ message: 'Payment evidence is already processing' });
    const user = student.user ? await User.findById(student.user) : await User.findOne({ email: student.email, role: 'student' });
    if (!user) return res.status(409).json({ message: 'Student account needs repair' });
    journal = await CreationRequest.create({ actor: req.user.user.id, kind: 'student', key, aliases: [key],
      fingerprint, recordId: student._id,
      leaseEpoch: Date.now() * 1000, requestId: req.requestId, operation: 'evidence', target: String(log._id) });
    const locked = await FeeLog.updateOne({ _id: log._id, evidence_edit_request: { $exists: false } }, { $set: { evidence_edit_request: journal._id } });
    if (!locked.modifiedCount) throw Object.assign(new Error('Another evidence edit is processing'), { status: 409 });
    const assets = await stageCreationFiles(journal, { payment_evidence: incoming }, true);
    await CreationRequest.updateOne({ _id: journal._id }, { $set: { state: 'complete', plan: { user: { _id: user._id },
      student: { batch: student.batch }, assets, evidenceEdit: { logId: log._id, keep, previous: original },
      fee: { logs: [{ _id: log._id, action_type: 'Paid' }] } }, jobs: [...assets.map((asset) => ({ name: asset.name, state: 'pending', attempts: 0, nextRun: new Date() })),
        { name: 'evidence-edit', state: 'pending', attempts: 0, nextRun: new Date() }] } },
    { writeConcern: { w: 1, j: true } });
    await FeeLog.updateOne({ _id: log._id }, { $set: { evidence_status: 'pending' } });
    res.status(202).json(await creationResponse(await CreationRequest.findById(journal._id)));
  } catch (error) {
    if (journal) {
      const deleted = await CreationRequest.deleteOne({ _id: journal._id, state: 'preparing' });
      if (deleted.deletedCount) await FeeLog.updateOne({ evidence_edit_request: journal._id }, { $unset: { evidence_edit_request: 1 } });
    }
    next(error);
  }
}

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import QRCode from 'qrcode';
import bcrypt from 'bcryptjs';
import moment from 'moment-timezone';
import { DEFAULT_STUDENT_PASSWORD, DEFAULT_STAFF_PASSWORD } from './creationDefaults.js';
import CreationRequest from '../models/creationRequests.js';
import Student from '../models/students.js';
import User from '../models/users.js';
import Fee from '../models/fees.js';
import FeeLog from '../models/feeLogs.js';
import { uploadCreationAsset } from './fileStorage.js';
import { sendStudentWelcomeWhatsApp, sendUserWelcomeWhatsApp } from './whatsappMessaging.js';
import { creationAudit, creationContext, creationStep } from './creationAudit.js';
import { isPlatformSuperAdminRole } from './lmsAccess.js';
import { recentRequestMetrics } from './requestObservability.js';
import { alertChannelConfigured, notifyOperationalAlert } from './operationalAlerts.js';
import { identityForRequest, pendingStudentDues } from './studentIdentity.js';
import Enrollment from '../models/enrollments.js';
import StudentBatchShift from '../models/studentBatchShifts.js';
import { syncStudentFeeFromLogs } from './feePayment.js';

const id = () => new mongoose.Types.ObjectId();
const modelFor = (kind) => kind === 'student' ? Student : User;
const root = () => path.resolve(process.env.CREATION_STAGING_DIR || '.creation-staging');
const safeError = (error) => error?.code === 'ENOENT' ? 'Staged file is missing; contact an administrator.' : 'Background operation failed; retry is available.';
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

async function assertWorkerLease(request) {
  if (!await CreationRequest.exists({ _id: request._id, leaseToken: request.leaseToken, finalized: false, leaseUntil: { $gt: new Date() } })) {
    throw Object.assign(new Error('Creation worker lease lost'), { code: 'CREATION_LEASE_LOST' });
  }
}

export const processingSummary = (request) => request.state === 'failed' || request.jobs.some((job) => job.state === 'failed')
  ? 'failed' : request.state !== 'complete' ? 'pending' : request.jobs.every((job) => job.state === 'complete')
    ? 'complete' : request.jobs.some((job) => job.state === 'processing') ? 'processing' : 'pending';

export async function creationResponse(request) {
  const summary = {
    idempotency_key: request.key, submission_status: request.state,
    processing_status: processingSummary(request), record_id: request.recordId,
    jobs: request.jobs.map(({ name, state, attempts, error, result }) => ({ name, state, attempts, error, result })),
  };
  if (request.state === 'deleted') return { ...summary, submission_status: 'deleted', message: 'The original record was deleted.' };
  const record = request.state === 'complete'
    ? await modelFor(request.kind).findById(request.recordId).select('-password').lean() : null;
  if (request.state === 'complete' && !record) return { ...summary, submission_status: 'deleted', message: 'The created record has since been deleted.' };
  if (request.kind === 'student' && record) {
    record.batch = record.batch ? await mongoose.model('Batch').findById(record.batch).lean() : null;
  }
  return { ...record, ...summary, ...(request.kind === 'user' ? { user: record, message: 'User creation accepted' } : {}),
    whatsapp_welcome: { queued: true, sent: false } };
}

export const claimCreation = (kind) => async (req, res, next) => {
  try {
    if (req.get('X-Creation-Protocol') !== '2') return res.status(426).json({ code: 'PORTAL_RELOAD_REQUIRED',
      message: 'The portal has been updated. Reload this page before creating a record. Nothing has been created.' });
    const actor = req.user?.user?.id;
    if (!actor) return res.status(401).json({ message: 'Authentication required' });
    const key = req.get('Idempotency-Key') || crypto.randomUUID();
    if (!/^[\w-]{16,128}$/.test(key)) return res.status(400).json({ message: 'Invalid Idempotency-Key' });
    res.setHeader('Idempotency-Key', key);
    const resolved = kind === 'student' && req.body.reuse_existing === 'true' ? await identityForRequest(req) : null;
    req.studentIdentity = resolved;
    const identity = resolved?.student ? `${resolved.normalized}:${req.body.batch || 'current'}` : kind === 'student' ? String(req.body.phone || '').replace(/\D/g, '').slice(-10)
      : String(req.body.email || '').trim().toLowerCase();
    if (!identity) return res.status(400).json({ message: kind === 'student' ? 'Phone number is required' : 'Email is required' });
    const files = Object.entries(req.files || {}).flatMap(([field, list]) => (Array.isArray(list) ? list : [list])
      .map((file) => ({ field, size: file.size, hash: file.md5 })));
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(canonical({ body: req.body, files }))).digest('hex');
    let request;
    try {
      request = await new CreationRequest({ actor, kind, key, aliases: [key], identity, fingerprint, recordId: id(), requestId: req.requestId, leaseEpoch: Date.now() * 1000 })
        .save({ writeConcern: { w: 1, j: true } });
    } catch (error) {
      if (error.code !== 11000) throw error;
      request = await CreationRequest.findOne({ actor, kind, $or: [{ key }, { aliases: key }] }) || await CreationRequest.findOne({ kind, identity });
      if (!request) throw error;
      if (request.state === 'deleted') return res.status(410).json({ message: 'The original record was deleted. Start a new submission with a new key.' });
      if (request.state === 'expired') {
        await CreationRequest.deleteOne({ _id: request._id, state: 'expired' });
        return claimCreation(kind)(req, res, next);
      }
      if (request.state === 'preparing' && Date.now() - request.updatedAt.getTime() > 5 * 60000) {
        const removed = await CreationRequest.deleteOne({ _id: request._id, state: 'preparing', updatedAt: request.updatedAt,
          plan: { $exists: false } });
        if (removed.deletedCount) return claimCreation(kind)(req, res, next);
      }
      // An intentional delete may free the identity, but never steal a live or partially committed request.
      if (request.state === 'complete' && !await modelFor(kind).exists({ _id: request.recordId })) {
        await tombstoneCreation(kind, request.recordId);
        if (request.key === key || request.aliases.includes(key)) return res.status(410).json({ message: 'The original record was deleted. A new submission must use a new key.' });
        return claimCreation(kind)(req, res, next);
      }
      const own = String(request.actor) === String(actor);
      const sameKey = request.key === key || request.aliases.includes(key);
      const recent = Date.now() - request.createdAt.getTime() < 10 * 60000;
      if (!own || request.fingerprint !== fingerprint || (!sameKey && !recent)) {
        return res.status(409).json({ message: 'This identity or submission key is already in use. Inspect the existing record before retrying.' });
      }
      if (!sameKey) {
        if (request.aliases.length >= 50) return res.status(409).json({ message: 'Too many retry keys; inspect the existing record' });
        await CreationRequest.updateOne({ _id: request._id }, { $addToSet: { aliases: key } });
      }
      return res.status(request.state === 'complete' ? 200 : 202).json(await creationResponse(request));
    }
    req.creationRequest = request;
    // Validation failure has no side effects. Allow the corrected form to reuse its key.
    res.once('finish', () => {
      if (res.statusCode >= 400) CreationRequest.deleteOne({ _id: request._id, state: 'preparing', plan: { $exists: false } })
        .catch(() => creationAudit('creation_validation_cleanup_failed'));
      if (res.statusCode >= 400) Student.updateOne({ admission_request: request._id }, { $unset: { admission_request: 1 } }).catch(() => {});
    });
    return creationContext.run({ requestId: req.requestId, creationId: String(request._id), kind }, next);
  } catch (error) { next(error); }
};

export async function stageCreationFiles(request, uploads, hasPayment) {
  const directory = path.join(root(), String(request._id));
  const assets = [];
  const entries = [ ...(uploads?.image ? [{ name: 'avatar', file: uploads.image }] : []),
    ...(hasPayment ? (Array.isArray(uploads?.payment_evidence) ? uploads.payment_evidence : uploads?.payment_evidence ? [uploads.payment_evidence] : [])
      .map((file) => ({ name: 'evidence', file })) : []) ];
  if (entries.length > 11 || entries.filter((entry) => entry.name === 'evidence').length > 10) {
    throw Object.assign(new Error('At most ten evidence files and one avatar are allowed'), { status: 400 });
  }
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const { name, file } of entries) {
      if (!file || Array.isArray(file) || file.truncated || !file.size || file.size > 10 * 1024 * 1024) {
        throw Object.assign(new Error('Each attachment must be nonempty and no larger than 10 MB'), { status: 400 });
      }
      const ext = path.extname(file.name).toLowerCase();
      const allowed = name === 'avatar' ? ['.jpg', '.jpeg', '.png', '.webp'] : ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
      if (!allowed.includes(ext)) throw Object.assign(new Error('Unsupported attachment format'), { status: 400 });
      const token = crypto.randomUUID();
      const stagedPath = path.join(directory, `${token}${ext}`);
      await file.mv(stagedPath);
      await fs.chmod(stagedPath, 0o600);
      const handle = await fs.open(stagedPath, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      assets.push({ name: `${name}:${token}`, type: name, stagedPath, ext });
    }
    return assets;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    if (['ENOSPC', 'EDQUOT'].includes(error.code)) throw Object.assign(new Error('Upload staging storage is full. No account or student was created. Contact an administrator.'), { status: 507, code: 'CREATION_NOT_COMMITTED' });
    throw error;
  }
}

export async function tombstoneCreation(kind, recordId) {
  return CreationRequest.updateMany({ kind, recordId, state: 'complete' }, {
    $set: { state: 'deleted', finalized: true, leaseUntil: new Date(0) },
    $unset: { identity: 1, plan: 1, leaseToken: 1 },
  }, { writeConcern: { w: 1, j: true } });
}

// Persist the entire recoverable DB plan before writing any account, student, or fee.
export async function prepareCreation(request, { user, student, fee, assets = [], existingStudent, existingUser }) {
  const recordId = existingStudent?._id || request.recordId;
  const userId = existingUser?._id || (student ? id() : recordId);
  const plan = { user: { ...user, _id: userId }, student: student ? { ...student, _id: recordId, user: userId } : null,
    reuseStudent: Boolean(existingStudent), reuseUser: Boolean(existingUser), assets, fee: null };
  if (existingStudent) {
    const dues = await pendingStudentDues(existingStudent._id);
    if (dues.length) throw Object.assign(new Error('Pending dues must be cleared before admission'), { status: 409, code: 'PENDING_FEE_BLOCK' });
    plan.previous = { batch: existingStudent.batch, roll: existingStudent.roll_number };
    plan.shiftId = id();
  }
  if (fee?.totalFee > 0) {
    const feeId = id();
    const net = Math.max(fee.totalFee - fee.discountAmount, 0);
    const remaining = Math.max(net - fee.payingNow, 0);
    const base = { student: recordId, fee: feeId, action_by: request.actor, action_date: request.createdAt };
    const logs = [{ ...base, _id: id(), amount: fee.totalFee, action_amount: fee.totalFee,
      action_type: 'Created', description: 'Fee assigned on student admission' }];
    if (fee.discountAmount > 0) logs.push({ ...base, _id: id(), amount: fee.totalFee, action_amount: fee.discountAmount,
      action_type: 'Discounted', description: fee.discountDescription });
    if (fee.payingNow > 0) logs.push({ ...base, _id: id(), amount: net, action_amount: fee.payingNow, action_type: 'Paid',
      payment_method: fee.paymentMethod || 'Cash', payment_evidence: '',
      evidence_status: assets.some((asset) => asset.type === 'evidence') ? 'pending' : 'complete',
      description: `Payment received on student admission (${fee.paymentMethod || 'Cash'})` });
    plan.fee = { document: { _id: feeId, student: recordId, batch: fee.batchId, amount: remaining,
      due_date: moment(fee.nextInstallmentDate || request.createdAt).tz('Asia/Karachi').format('YYYY-MM-DD'),
      status: remaining > 0 ? 'Pending' : 'Paid' }, logs };
    const online = ['Online', 'Online Payment', 'Bank Transfer'].includes(fee.paymentMethod);
    plan.student.cash_amount = online ? 0 : fee.payingNow;
    plan.student.online_amount = online ? fee.payingNow : 0;
  }
  const jobs = [...assets.map((asset) => ({ name: asset.name, state: 'pending', attempts: 0, nextRun: new Date() })),
    ...(!existingUser ? [{ name: 'welcome', state: 'pending', attempts: 0, nextRun: new Date() }] : [])];
  const saved = await CreationRequest.updateOne({ _id: request._id, state: 'preparing' }, { $set: { plan, jobs, recordId, state: 'committing',
    leaseToken: crypto.randomUUID(), leaseUntil: new Date(Date.now() + 60000) } }, { writeConcern: { w: 1, j: true } });
  if (!saved.modifiedCount) throw new Error('Creation claim expired; check the submission status');
  return CreationRequest.findById(request._id).select('+plan');
}

export async function commitCreation(request, releaseLease = true, { afterWrite = async () => {} } = {}) {
  const { plan } = request;
  const checkLease = async () => {
    if (!await CreationRequest.exists({ _id: request._id, state: 'committing', leaseToken: request.leaseToken, leaseUntil: { $gt: new Date() } })) {
      throw new Error('Core commit lease lost');
    }
  };
  const write = async (name, run) => { await checkLease(); const result = await run(); await afterWrite(name); return result; };
  const insert = (Model, doc) => write(Model.modelName, () => Model.updateOne({ _id: doc._id }, { $setOnInsert: doc },
    { upsert: true, runValidators: true, writeConcern: { w: 1, j: true } }));
  const heartbeat = releaseLease ? setInterval(() => {
    CreationRequest.updateOne({ _id: request._id, state: 'committing', leaseToken: request.leaseToken },
      { $set: { leaseUntil: new Date(Date.now() + 60000) } }).catch(() => creationAudit('creation_commit_lease_renewal_failed'));
  }, 10000) : null;
  heartbeat?.unref();
  try { await creationStep('database_commit', async () => {
    if (!plan.reuseUser) await insert(User, { ...plan.user, creation_pending: true, processing_status: 'pending', creation_request: request._id });
    if (plan.student && !plan.reuseStudent) {
      const qrcode = await QRCode.toString(String(request.recordId), { type: 'svg', errorCorrectionLevel: 'H' });
      await insert(Student, { ...plan.student, qrcode, creation_pending: true, processing_status: 'pending', creation_request: request._id });
    }
    if (plan.fee) {
      // Fixed IDs and insert-only writes make a crash between these writes safely resumable.
      for (const log of plan.fee.logs) await insert(FeeLog, log);
      await insert(Fee, plan.fee.document);
    }
    if (plan.student?.batch) {
      if (plan.previous?.batch) await write('previous_enrollment', () => Enrollment.updateOne({ student: request.recordId, batch: plan.previous.batch },
        { $setOnInsert: { student: request.recordId, batch: plan.previous.batch, roll_number: plan.previous.roll } }, { upsert: true }));
      await write('enrollment', () => Enrollment.updateOne({ student: request.recordId, batch: plan.student.batch },
        { $setOnInsert: { student: request.recordId, batch: plan.student.batch, roll_number: plan.student.roll_number } }, { upsert: true }));
    }
    if (plan.reuseStudent) {
      await write('reuse_student', () => Student.updateOne({ _id: request.recordId, admission_request: request._id }, { $set: {
        batch: plan.student.batch, roll_number: plan.student.roll_number, normalized_phone: plan.student.normalized_phone,
        user: plan.user._id, processing_status: 'pending', creation_request: request._id,
      } }));
      await write('batch_history', () => StudentBatchShift.updateOne({ _id: plan.shiftId }, { $setOnInsert: {
        student: request.recordId, student_name: plan.student.name, student_phone: plan.student.phone,
        from_batch: plan.previous.batch, from_roll_number: plan.previous.roll,
        to_batch: plan.student.batch, to_roll_number: plan.student.roll_number, shifted_by: request.actor,
      } }, { upsert: true }));
      await write('reuse_finance_sync', () => syncStudentFeeFromLogs(request.recordId));
    }
    if (plan.student) await write('publish_student', () => Student.updateOne({ _id: request.recordId }, { $set: { creation_pending: false } }));
    if (!plan.reuseUser) await write('publish_user', () => User.updateOne({ _id: plan.user._id }, { $set: { creation_pending: false } }));
    await checkLease();
    const completed = await CreationRequest.updateOne({ _id: request._id, state: 'committing', leaseToken: request.leaseToken },
      { $set: { state: 'complete', ...(releaseLease ? { leaseUntil: new Date(0) } : {}), error: null, nextRun: new Date() },
        $unset: { 'plan.user.password': 1, 'plan.student.password': 1 } }, { writeConcern: { w: 1, j: true } });
    if (!completed.modifiedCount) throw new Error('Core commit ownership changed');
    await afterWrite('journal_complete');
    request.state = 'complete';
    if (plan.reuseStudent) await Student.updateOne({ _id: request.recordId, admission_request: request._id }, { $unset: { admission_request: 1 } });
  }); } finally { if (heartbeat) clearInterval(heartbeat); }
}

export const getCreationByKey = (kind) => async (req, res, next) => {
  try {
    const request = await CreationRequest.findOne({ kind, actor: req.user.user.id, $or: [{ key: req.params.key }, { aliases: req.params.key }] });
    if (!request) return res.status(404).json({ message: 'Submission not found' });
    res.status(request.state === 'complete' ? 200 : 202).json(await creationResponse(request));
  } catch (error) { next(error); }
};

async function authorizedRequest(req, kind) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  if (req.query?.request_id && !mongoose.isValidObjectId(req.query.request_id)) return null;
  const request = await CreationRequest.findOne({ kind, recordId: req.params.id,
    ...(req.query?.request_id ? { _id: req.query.request_id } : {}),
    ...(req.get?.('Idempotency-Key') ? { aliases: req.get('Idempotency-Key') } : {}) }).sort({ createdAt: -1 });
  if (!request) return null;
  const actor = await User.findById(req.user.user.id).select('role').lean();
  const role = String(actor?.role || '').trim().toLowerCase();
  const schoolAdministrator = kind === 'student' && ['admin', 'administrator'].includes(role);
  if (!actor || (String(request.actor) !== String(req.user.user.id) && !schoolAdministrator && !isPlatformSuperAdminRole({ user: { user: actor } }))) return null;
  return request;
}

export const getCreationStatus = (kind) => async (req, res, next) => {
  try {
    const request = await authorizedRequest(req, kind);
    if (!request) return res.status(404).json({ message: 'Processing record not found or access denied' });
    res.json(await creationResponse(request));
  } catch (error) { next(error); }
};

export const retryCreation = (kind) => async (req, res, next) => {
  try {
    const request = await authorizedRequest(req, kind);
    if (!request) return res.status(404).json({ message: 'Processing record not found or access denied' });
    if (request.state !== 'failed' && !request.jobs.some((job) => job.state === 'failed')) {
      return res.status(409).json({ message: 'There is no failed work to retry' });
    }
    const jobs = request.jobs.map((job) => job.toObject());
    for (const job of jobs) if (job.state === 'failed') Object.assign(job, { state: 'pending', attempts: 0, nextRun: new Date(), error: null });
    const result = await CreationRequest.updateOne({ _id: request._id, leaseUntil: { $lt: new Date() }, updatedAt: request.updatedAt },
      { $set: { jobs, finalized: false, state: request.state === 'failed' ? 'committing' : request.state, attempts: 0, nextRun: new Date(), error: null } });
    if (!result.modifiedCount) return res.status(409).json({ message: 'Work is already running; refresh its status' });
    creationAudit('creation_retry_requested', { creationId: String(request._id), actorId: String(req.user.user.id) });
    res.status(202).json({ message: 'Failed work queued for retry' });
  } catch (error) { next(error); }
};

export async function creationMetrics() {
  const now = Date.now();
  const [failed, stuck, pending] = await Promise.all([
    CreationRequest.countDocuments({ state: { $nin: ['deleted', 'expired'] }, $or: [{ state: 'failed' }, { 'jobs.state': 'failed' }] }),
    CreationRequest.countDocuments({ state: { $in: ['preparing', 'committing', 'complete'] }, finalized: false,
      createdAt: { $lt: new Date(now - 300000) } }),
    CreationRequest.countDocuments({ state: { $in: ['preparing', 'committing', 'complete'] }, finalized: false }),
  ]);
  return { failed, stuck, pending, alerts: { configured: alertChannelConfigured() }, httpLastFiveMinutes: recentRequestMetrics() };
}

export async function getCreationMetrics(req, res, next) {
  try {
    const actor = await User.findById(req.user.user.id).select('role').lean();
    if (!isPlatformSuperAdminRole({ user: { user: actor } })) return res.status(403).json({ message: 'Administrator access required' });
    const metrics = await creationMetrics();
    res.status(metrics.failed || metrics.stuck || !metrics.alerts.configured ? 503 : 200).json(metrics);
  } catch (error) { next(error); }
}

let stopping = false;
let timer;
let active;
let lastAlert = 0;

async function maintainStaging() {
  await CreationRequest.updateMany({ state: 'preparing', plan: { $exists: false },
    updatedAt: { $lt: new Date(Date.now() - 300000) } }, { $set: { state: 'expired', finalized: true } });
  const admissionLocks = await Student.find({ admission_request: { $exists: true } }).select('admission_request').limit(100).lean();
  const unlocked = await CreationRequest.find({ _id: { $in: admissionLocks.map((student) => student.admission_request) }, state: { $in: ['expired', 'complete', 'deleted'] } }).distinct('_id');
  if (unlocked.length) await Student.updateMany({ admission_request: { $in: unlocked } }, { $unset: { admission_request: 1 } });
  const evidenceLocks = await FeeLog.find({ evidence_edit_request: { $exists: true } }).select('evidence_edit_request').limit(100).lean();
  const expired = await CreationRequest.find({ _id: { $in: evidenceLocks.map((log) => log.evidence_edit_request) }, state: { $in: ['expired', 'deleted'] } }).distinct('_id');
  if (expired.length) await FeeLog.updateMany({ evidence_edit_request: { $in: expired } }, { $unset: { evidence_edit_request: 1 } });
  const directory = root();
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{24}$/.test(entry.name)) continue;
    const target = path.resolve(directory, entry.name);
    if (path.dirname(target) !== directory) continue;
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || Date.now() - stat.mtimeMs < 86400000) continue;
    const request = await CreationRequest.findById(entry.name).select('state jobs');
    if (!request || ['expired', 'deleted'].includes(request.state) || request.jobs.every((job) => job.state === 'complete')) {
      await fs.rm(target, { recursive: true, force: true });
    }
  }
}

async function performJob(request, job) {
  if (job.name === 'evidence-edit') return 'updated';
  const asset = request.plan.assets.find((entry) => entry.name === job.name);
  if (asset) {
    // Never resurrect deleted accounts or send orphaned payment evidence.
    if (!await modelFor(request.kind).exists({ _id: request.recordId })) throw new Error('Record deleted');
    const url = await creationStep('storage_upload', () => uploadCreationAsset(asset, request.recordId));
    await assertWorkerLease(request);
    if (asset.type === 'avatar') await Student.updateOne({ _id: request.recordId, creation_worker_epoch: request.leaseEpoch }, { $set: { image: url } });
    return url;
  }
  const record = await modelFor(request.kind).findById(request.recordId).select('-password');
  if (!record) throw new Error('Record deleted');
  const password = request.kind === 'student' ? DEFAULT_STUDENT_PASSWORD : DEFAULT_STAFF_PASSWORD;
  const account = await User.findById(request.plan.user._id).select('password').lean();
  if (!account) throw new Error('Account deleted');
  if (!await bcrypt.compare(password, account.password)) return 'skipped_password_changed';
  const sender = await User.findById(request.actor).select('name').lean();
  const batch = request.plan.student?.batch ? await mongoose.model('Batch').findById(request.plan.student.batch) : null;
  const options = { created_by: request.actor, created_by_name: sender?.name || '', immediate: true, background: true, historyId: request._id };
  const result = await creationStep('whatsapp_send', () => request.kind === 'student'
    ? sendStudentWelcomeWhatsApp({ ...options, student: record, batch, password,
      paymentMethod: request.plan.fee?.logs.find((log) => log.action_type === 'Paid')?.payment_method || 'Pay Later' })
    : sendUserWelcomeWhatsApp({ ...options, user: record, password }));
  if (!result?.sent && (!result?.skipped || /session|pacing|limit/i.test(result?.reason || ''))) throw new Error('WhatsApp send failed');
  // Missing templates/configuration is visible, not incorrectly reported as delivered.
  return result.sent ? 'sent' : 'skipped';
}

export async function processCreationOnce({ perform = performJob, afterClaim = async () => {} } = {}) {
  const token = crypto.randomUUID();
  const now = new Date();
  const request = await CreationRequest.findOneAndUpdate({ state: { $in: ['committing', 'complete'] }, nextRun: { $lte: now },
    leaseUntil: { $lte: now }, finalized: false },
  { $inc: { leaseEpoch: 1 }, $set: { leaseToken: token, leaseUntil: new Date(Date.now() + 60000) } }, { new: true, sort: { nextRun: 1 } }).select('+plan');
  if (!request) return;
  await afterClaim(request);
  const heartbeat = setInterval(() => {
    CreationRequest.updateOne({ _id: request._id, leaseToken: token, leaseUntil: { $gt: new Date() }, finalized: false }, { $set: { leaseUntil: new Date(Date.now() + 60000) } })
      .catch(() => creationAudit('creation_lease_renewal_failed', { creationId: String(request._id) }));
  }, 10000);
  heartbeat.unref();
  try {
    await creationContext.run({ creationId: String(request._id), requestId: request.requestId, kind: request.kind }, async () => {
      if (request.state === 'committing') {
        // Keep the worker lease while committing; commitCreation releases its request-path lease.
        await commitCreation(request, false);
      }
      // Monotonic fences prevent a paused former owner overwriting a newer owner's record status/evidence.
      await modelFor(request.kind).updateOne({ _id: request.recordId }, { $max: { creation_worker_epoch: request.leaseEpoch } });
      if (request.kind === 'student') await User.updateOne({ _id: request.plan.user._id }, { $max: { creation_worker_epoch: request.leaseEpoch } });
      const paidLogIds = request.plan.fee?.logs.filter((log) => log.action_type === 'Paid').map((log) => log._id) || [];
      if (paidLogIds.length) await FeeLog.updateMany({ _id: { $in: paidLogIds } }, { $max: { creation_worker_epoch: request.leaseEpoch } });
      for (let index = 0; index < request.jobs.length; index++) {
        const job = request.jobs[index];
        if (!['pending', 'processing'].includes(job.state) || job.nextRun > new Date() || stopping) continue;
        await assertWorkerLease(request);
        if (job.attempts >= 5) {
          job.state = 'failed';
          job.error = 'Automatic retry budget exhausted after worker interruptions. Inspect the result before retrying.';
          await CreationRequest.updateOne({ _id: request._id, leaseToken: token }, { $set: { [`jobs.${index}`]: job.toObject() } });
          continue;
        }
        job.state = 'processing';
        job.attempts++;
        job.startedAt = new Date();
        await assertWorkerLease(request);
        await modelFor(request.kind).updateOne({ _id: request.recordId, creation_worker_epoch: request.leaseEpoch }, { $set: { processing_status: 'processing' } });
        await CreationRequest.updateOne({ _id: request._id, leaseToken: token }, { $set: { [`jobs.${index}`]: job.toObject() } });
        try {
          job.result = await perform(request, job);
          await assertWorkerLease(request);
          job.state = 'complete';
          job.error = null;
        } catch (error) {
          if (error.code === 'CREATION_LEASE_LOST') throw error;
          job.state = job.attempts >= 5 ? 'failed' : 'pending';
          job.error = safeError(error);
          job.nextRun = new Date(Date.now() + Math.min(300000, 5000 * 2 ** (job.attempts - 1)));
          creationAudit('creation_job_failed', { job: job.name.split(':')[0], attempt: job.attempts, errorType: error.name });
        }
        await CreationRequest.updateOne({ _id: request._id, leaseToken: token }, { $set: { [`jobs.${index}`]: job.toObject() } });
      }
      await assertWorkerLease(request);
      const evidence = request.jobs.filter((job) => job.name.startsWith('evidence:'));
      if (request.plan.fee && evidence.length) {
        const urls = [...(request.plan.evidenceEdit?.keep || []), ...evidence.filter((job) => job.state === 'complete').map((job) => job.result)];
        await FeeLog.updateMany({ _id: { $in: paidLogIds }, creation_worker_epoch: request.leaseEpoch },
          { $set: { ...(!request.plan.evidenceEdit || evidence.every((job) => job.state === 'complete') ? { payment_evidence: urls.length === 1 ? urls[0] : urls } : {}), evidence_status:
            evidence.every((job) => job.state === 'complete') ? 'complete' : evidence.some((job) => job.state === 'failed') ? 'failed' : 'pending' } });
      }
      if (request.plan.evidenceEdit && !evidence.length) {
        await FeeLog.updateOne({ _id: request.plan.evidenceEdit.logId, evidence_edit_request: request._id },
          { $set: { payment_evidence: request.plan.evidenceEdit.keep, evidence_status: 'complete' } });
      }
      const summary = processingSummary(request);
      if (request.plan.evidenceEdit && request.jobs.every((job) => job.state === 'complete')) {
        await FeeLog.updateOne({ _id: request.plan.evidenceEdit.logId, evidence_edit_request: request._id }, { $unset: { evidence_edit_request: 1 } });
        creationAudit('payment_evidence_updated', { paymentId: String(request.plan.evidenceEdit.logId), actorId: String(request.actor),
          previousCount: request.plan.evidenceEdit.previous.length, retainedCount: request.plan.evidenceEdit.keep.length, newCount: evidence.length });
      }
      await modelFor(request.kind).updateOne({ _id: request.recordId, creation_worker_epoch: request.leaseEpoch }, { $set: { processing_status: summary } });
      if (request.kind === 'student') await User.updateOne({ _id: request.plan.user._id, creation_worker_epoch: request.leaseEpoch }, { $set: { processing_status: summary } });
      const next = request.jobs.filter((job) => ['pending', 'processing'].includes(job.state)).map((job) => job.nextRun.getTime());
      await CreationRequest.updateOne({ _id: request._id, leaseToken: token }, { $set: { leaseUntil: new Date(0),
        finalized: next.length === 0, nextRun: new Date(next.length ? Math.min(...next) : Date.now()), error: null },
        ...(request.jobs.every((job) => job.state === 'complete') ? { $unset: { plan: 1 } } : {}) },
      { writeConcern: { w: 1, j: true } });
      for (const asset of request.plan.assets) {
        if (request.jobs.find((job) => job.name === asset.name)?.state === 'complete') await fs.unlink(asset.stagedPath).catch(() => {});
      }
      await Student.updateOne({ _id: request.recordId, admission_request: request._id }, { $unset: { admission_request: 1 } });
    });
  } catch (error) {
    await CreationRequest.updateOne({ _id: request._id, leaseToken: token }, { $inc: { attempts: 1 }, $set: {
      ...(request.attempts >= 7 && request.state !== 'complete' ? { state: 'failed' } : {}),
      error: safeError(error), leaseUntil: new Date(0), nextRun: new Date(Date.now() + 30000) } });
    creationAudit('creation_worker_failed', { creationId: String(request._id), errorType: error.name });
  } finally { clearInterval(heartbeat); }
}

export async function startCreationWorker() {
  // The unique indexes must exist before the API accepts its first create request.
  await CreationRequest.init();
  await CreationRequest.createIndexes();
  await Student.init();
  await Student.createIndexes();
  stopping = false;
  const tick = async () => {
    if (stopping) return;
    try {
      await processCreationOnce();
      if (Date.now() - lastAlert > 60000) {
        lastAlert = Date.now();
        await maintainStaging();
        const metrics = await creationMetrics();
        if (metrics.failed || metrics.stuck) {
          creationAudit('creation_queue_alert', { level: 'error', ...metrics });
          await notifyOperationalAlert('creation-queue', { failed: metrics.failed, stuck: metrics.stuck, pending: metrics.pending });
        }
        const http = metrics.httpLastFiveMinutes;
        if (http.gatewayTimeouts || http.disconnected >= 5 || (http.requests >= 20 && http.serverErrors / http.requests >= 0.05)) {
          creationAudit('http_error_rate_alert', { level: 'error', ...http });
          await notifyOperationalAlert('http-errors', http);
        }
      }
    } catch (error) { creationAudit('creation_worker_unavailable', { errorType: error.name }); }
    if (!stopping) timer = setTimeout(() => { active = tick(); }, 1000);
  };
  active = tick();
}

export async function stopCreationWorker() {
  stopping = true;
  clearTimeout(timer);
  // On forced termination the lease expires and another worker resumes durable work.
  await Promise.race([active, new Promise((resolve) => { const t = setTimeout(resolve, 20000); t.unref(); })]);
}

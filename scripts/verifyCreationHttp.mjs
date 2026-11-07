// Isolated real-HTTP acceptance test. No production database or provider credentials are loaded.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lca-http-verify-'));
await fs.mkdir(path.join(directory, 'data'));
process.chdir(directory);
const freePort = async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};
const mongoPort = await freePort();
const port = await freePort();
const uri = `mongodb://127.0.0.1:${mongoPort}/lca_verify_http`;
const environment = { ...process.env, MONGO_URI: uri, PORT: String(port), JWT_SECRET: 'isolated-http-verification-only',
  OPENWA_BASE_URL: '', OPENWA_API_KEY: '', S3_ENDPOINT: '', S3_BUCKET: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '',
  EMAIL_USER: '', EMAIL_PASS: '', ALERT_EMAIL_TO: '', CORS_ORIGINS: 'https://lca-portal.com',
  CREATION_STAGING_DIR: path.join(directory, 'staging'), CREATION_LOG_DIR: path.join(directory, 'logs'),
  FILES_STORAGE_PATH: path.join(directory, 'files'), FILES_STORAGE_URL: '/public' };
Object.assign(process.env, environment);
const mongo = spawn(process.env.MONGOD_BINARY || 'mongod', ['--dbpath', path.join(directory, 'data'), '--port', String(mongoPort),
  '--bind_ip', '127.0.0.1', '--logpath', path.join(directory, 'mongo.log'), '--quiet'], { stdio: 'ignore' });
let api;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  for (let attempt = 0; ; attempt++) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 }); break; }
    catch (error) { if (attempt === 40) throw error; await pause(200); }
  }
  const { default: User } = await import('../models/users.js');
  const { default: Role } = await import('../models/roles.js');
  const { default: Batch } = await import('../models/batches.js');
  const { default: Student } = await import('../models/students.js');
  const { default: Fee } = await import('../models/fees.js');
  const { default: FeeLog } = await import('../models/feeLogs.js');
  const actor = await User.create({ name: 'Isolated acceptance admin', email: 'http-admin@example.invalid', role: 'superadmin' });
  await Role.create({ name: 'admin' });
  const batch = await Batch.create({ name: 'Isolated acceptance batch', batch_type: 'On Campus', roll_nickname: 'HTTP', batch_fee: '1000' });
  let output = '';
  api = spawn(process.execPath, [path.join(source, 'index.js')], { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout.on('data', (chunk) => { output = (output + chunk).slice(-10000); });
  api.stderr.on('data', (chunk) => { output = (output + chunk).slice(-10000); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    try { assert.equal((await fetch(`${base}/health/ready`)).status, 200); break; }
    catch (error) { if (attempt === 100 || api.exitCode !== null) throw new Error(`API failed startup: ${output}`); await pause(200); }
  }
  const token = jwt.sign({ user: { id: String(actor._id), role: actor.role } }, environment.JWT_SECRET, { expiresIn: '5m' });
  const key = crypto.randomUUID();
  const headers = { authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Creation-Protocol': '2' };
  const body = { name: 'Isolated HTTP Student', phone: '0000000000', batch: String(batch._id), paying_now: '200',
    discount_amount: '100', payment_method: 'Cash', next_installment_date: '2030-01-01' };
  const oldClient = await fetch(`${base}/students/add`, { method: 'POST', headers: { ...headers, 'X-Creation-Protocol': '1' }, body: JSON.stringify(body) });
  assert.equal(oldClient.status, 426);
  assert.equal(await Student.countDocuments(), 0);
  console.log('PASS real HTTP old client is rejected without creating records');
  const started = Date.now();
  const created = await fetch(`${base}/students/add`, { method: 'POST', headers, body: JSON.stringify(body) });
  const result = await created.json();
  assert.equal(created.status, 201, JSON.stringify(result));
  assert.equal(result.roll_number, 'OC-HTTP-1');
  assert.equal(result.total_fee, 900);
  assert.equal(result.pending_fee, 700);
  assert.equal(await Fee.countDocuments({ student: result.record_id }), 1);
  assert.equal(await FeeLog.countDocuments({ student: result.record_id }), 3);
  console.log(`PASS real HTTP student creation, roll, account and fee records (${Date.now() - started} ms)`);
  const replay = await fetch(`${base}/students/add`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).record_id, result.record_id);
  assert.equal(await Student.countDocuments(), 1);
  const lookup = await fetch(`${base}/students/by-key/${key}`, { headers });
  assert.equal((await lookup.json()).record_id, result.record_id);
  console.log('PASS real HTTP replay and by-key recovery preserve one student');
  const staff = await fetch(`${base}/users/add`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ name: 'Isolated HTTP staff', email: 'http-staff@example.invalid', phone: 'test-only-no-phone', role: 'admin' }) });
  assert.equal(staff.status, 201, await staff.text());
  console.log('PASS real HTTP staff creation');
  const unauthenticated = await fetch(`${base}/operations/creation-metrics`);
  assert.equal(unauthenticated.status, 401);
  const capabilities = await fetch(`${base}/operations/creation-capabilities`, { headers });
  assert.equal((await capabilities.json()).protocol, 2);
  console.log('PASS real HTTP authorization and creation capabilities');
  const post = async (route, payload, requestKey = crypto.randomUUID()) => {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': requestKey }, body: JSON.stringify(payload) });
    return { status: response.status, data: await response.json() };
  };
  const batch2 = await Batch.create({ name: 'Second test batch', batch_type: 'Online', roll_nickname: 'SECOND', batch_fee: '2000' });
  const repeatBody = { ...body, phone: '+92 000 0000000', batch: String(batch2._id), reuse_existing: 'true', paying_now: '0', discount_amount: '0' };
  const duesLookup = await post('/students/identity/lookup', { phone: body.phone });
  assert.equal(duesLookup.data.pending_total, 700);
  assert.equal(duesLookup.data.dues[0].batch_name, batch.name);
  const blocked = await post('/students/add', repeatBody);
  assert.equal(blocked.status, 409, JSON.stringify(blocked));
  assert.equal(blocked.data.code, 'PENDING_FEE_BLOCK');
  assert.equal(await Student.countDocuments(), 1);
  console.log('PASS lookup shows batch-wise dues and save rechecks/rejects outstanding balance');
  const firstFee = await Fee.findOne({ student: result.record_id });
  await FeeLog.create({ fee: firstFee._id, student: result.record_id, action_type: 'Paid', action_amount: 700, amount: 700, action_date: new Date(), payment_method: 'Cash' });
  await Fee.updateOne({ _id: firstFee._id }, { $set: { amount: 0, status: 'Paid' } });
  const { syncStudentFeeFromLogs } = await import('../utils/feePayment.js');
  await syncStudentFeeFromLogs(result.record_id);
  const beforeUsers = await User.countDocuments();
  const existingLogin = await User.findOne({ email: result.email });
  const savedHash = existingLogin.password;
  const repeatKey = crypto.randomUUID();
  const reused = await post('/students/add', repeatBody, repeatKey);
  assert.equal(reused.status, 201, JSON.stringify(reused));
  assert.equal(reused.data.record_id, result.record_id);
  assert.equal(reused.data.roll_number, 'On-SECOND-1');
  assert.equal(await Student.countDocuments(), 1);
  assert.equal(await User.countDocuments(), beforeUsers);
  assert.equal((await User.findById(existingLogin._id)).password, savedHash);
  assert.equal(await Fee.countDocuments({ student: result.record_id }), 2);
  const { default: Enrollment } = await import('../models/enrollments.js');
  const { default: Shift } = await import('../models/studentBatchShifts.js');
  assert.equal(await Enrollment.countDocuments({ student: result.record_id }), 2);
  assert.equal(await Shift.countDocuments({ student: result.record_id }), 1);
  const repeated = await post('/students/add', repeatBody, repeatKey);
  assert.equal(repeated.status, 200);
  assert.equal(await Shift.countDocuments({ student: result.record_id }), 1);
  console.log('PASS settled student reuses same profile/login/password, preserves old ledger/enrollment/roll history and replay');
  const staffConflict = await post('/students/identity/lookup', { phone: '03001230000' });
  assert.equal(staffConflict.status, 200);
  await User.create({ name: 'Non-student contact', role: 'admin', phone: '03001230000', email: 'phone-staff@example.invalid' });
  assert.equal((await post('/students/identity/lookup', { phone: '03001230000' })).status, 409);
  console.log('PASS matching staff account is never converted into a student');
  const paid = await FeeLog.findOne({ student: result.record_id, action_type: 'Paid' });
  const evidence = new FormData();
  evidence.append('keep_evidence', '[]');
  evidence.append('payment_evidence', new Blob(['%PDF-1.4\nverification-one']), 'one.pdf');
  evidence.append('payment_evidence', new Blob(['%PDF-1.4\nverification-two']), 'two.pdf');
  const evidenceKey = crypto.randomUUID();
  const response = await fetch(`${base}/students/${result.record_id}/payment-evidence/${paid._id}`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'Idempotency-Key': evidenceKey }, body: evidence });
  assert.equal(response.status, 202, await response.text());
  for (let attempt = 0; ; attempt++) {
    const payment = await FeeLog.findById(paid._id);
    if (payment.evidence_status === 'complete' && Array.isArray(payment.payment_evidence) && payment.payment_evidence.length === 2) break;
    if (attempt > 80) throw new Error(`Evidence did not complete: ${output}`);
    await pause(200);
  }
  assert.equal((await Fee.findById(firstFee._id)).amount, 0);
  console.log('PASS multiple evidence uploads complete asynchronously without changing payment amounts');
  const oldUrls = (await FeeLog.findById(paid._id)).payment_evidence;
  const editAgain = await post(`/students/${result.record_id}/payment-evidence/${paid._id}`, { keep_evidence: JSON.stringify([oldUrls[1]]) });
  assert.equal(editAgain.status, 202, JSON.stringify(editAgain));
  for (let attempt = 0; ; attempt++) {
    const payment = await FeeLog.findById(paid._id);
    if (!payment.evidence_edit_request && Array.isArray(payment.payment_evidence) && payment.payment_evidence.length === 1) break;
    if (attempt > 80) throw new Error(`Retained evidence did not complete: ${output}`);
    await pause(200);
  }
  console.log('PASS subsequent evidence edit retains chosen files and releases its edit lock');
  const paymentBody = { amount: '600', payment_option: 'partial', payment_method: 'Cash', remarks: 'Isolated payment', next_installment_date: '2030-01-01' };
  const receipt1 = await post(`/fees/collect-pending/${result.record_id}`, paymentBody);
  assert.equal(receipt1.status, 200, JSON.stringify(receipt1));
  assert.equal(receipt1.data.receipt.totalFee, 2000);
  assert.equal(receipt1.data.receipt.paidFee, 600);
  const receipt2 = await post(`/fees/collect-pending/${result.record_id}`, { ...paymentBody, amount: '700' });
  assert.equal(receipt2.status, 200, JSON.stringify(receipt2));
  assert.equal(receipt2.data.receipt.totalFee, 2000);
  assert.equal(receipt2.data.receipt.paidFee, 1300);
  assert.equal(receipt2.data.receipt.remainingAfter, 700);
  const { default: Receipt } = await import('../models/feeReceipts.js');
  assert.equal((await Receipt.findById(receipt1.data.receipt.receiptId)).payload.paidFee, 600);
  const duplicate = await fetch(`${base}/students/${result.record_id}/last-payment-receipt`, { headers });
  assert.equal((await duplicate.json()).receiptId, receipt2.data.receipt.receiptId);
  console.log('PASS repeated collections return batch-scoped cumulative totals and immutable duplicate receipt snapshots');
  const orphan = await User.create({ name: 'Existing login only', email: 'student.03115557777@lca.local', role: 'student', password: 'unchanged-hash' });
  const usersBeforeOrphanAdmission = await User.countDocuments();
  const orphanAdmission = await post('/students/add', { name: 'Existing login only', phone: '+92 311 5557777', batch: String(batch._id), reuse_existing: 'true', paying_now: '0' });
  assert.equal(orphanAdmission.status, 201, JSON.stringify(orphanAdmission));
  assert.equal(await User.countDocuments(), usersBeforeOrphanAdmission);
  assert.equal(String((await Student.findById(orphanAdmission.data.record_id)).user), String(orphan._id));
  assert.equal((await User.findById(orphan._id)).password, 'unchanged-hash');
  const studentToken = jwt.sign({ user: { id: String(existingLogin._id), role: 'student' } }, environment.JWT_SECRET);
  const denied = await fetch(`${base}/students/${result.record_id}/evidence-payments`, { headers: { authorization: `Bearer ${studentToken}` } });
  assert.equal(denied.status, 403);
  const badRetention = await post(`/students/${result.record_id}/payment-evidence/${paid._id}`, { keep_evidence: JSON.stringify(['https://example.invalid/unowned.pdf']) });
  assert.equal(badRetention.status, 400);
  console.log('PASS login-only identity reuse preserves credentials; student evidence access and unowned attachments are denied');
  const secondFee = await Fee.findOne({ student: result.record_id, batch: batch2._id });
  await FeeLog.create({ fee: secondFee._id, student: result.record_id, action_type: 'Paid', action_amount: 700, amount: 700, action_date: new Date(), payment_method: 'Cash' });
  await Fee.updateOne({ _id: secondFee._id }, { $set: { amount: 0, status: 'Paid' } });
  await syncStudentFeeFromLogs(result.record_id);
  const batch3 = await Batch.create({ name: 'Concurrent A', batch_type: 'Online', roll_nickname: 'RACEA', batch_fee: '1000' });
  const batch4 = await Batch.create({ name: 'Concurrent B', batch_type: 'Online', roll_nickname: 'RACEB', batch_fee: '1000' });
  const studentsBeforeRace = await Student.countDocuments();
  const race = await Promise.all([batch3, batch4].map((target) => post('/students/add', { ...repeatBody, batch: String(target._id) })));
  assert.equal(race.filter((item) => item.status === 201).length, 1, JSON.stringify(race));
  assert.equal(race.filter((item) => item.status === 409).length, 1);
  assert.equal(await Student.countDocuments(), studentsBeforeRace);
  const reportDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
  const report = await fetch(`${base}/fees/report?period=daily&date=${reportDate}`, { headers });
  const finance = await report.json();
  assert.equal(report.status, 200, JSON.stringify(finance));
  const historical = finance.transactions.filter((item) => item.student_id === result.record_id && item.batch_id === String(batch2._id));
  assert.ok(historical.length >= 2);
  assert.ok(historical.every((item) => item.total_batch_fee === 2000 && item.roll_number === 'On-SECOND-1'));
  console.log('PASS concurrent admissions serialize one student; historical daily finance retains original batch totals and roll');
  console.log('HTTP_ACCEPTANCE_PASSED (isolated database; providers disabled)');
} finally {
  if (api) { api.kill('SIGTERM'); await new Promise((resolve) => api.exitCode !== null ? resolve() : api.once('exit', resolve)); }
  await mongoose.disconnect();
  mongo.kill('SIGTERM');
  await new Promise((resolve) => mongo.exitCode !== null ? resolve() : mongo.once('exit', resolve));
  process.chdir(os.tmpdir());
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

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
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lca-transfer-verify-'));
await fs.mkdir(path.join(directory, 'data'));
process.chdir(directory);
const port = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const mongoPort = await port(), apiPort = await port();
const uri = `mongodb://127.0.0.1:${mongoPort}/transfer_verify`;
const environment = { ...process.env, MONGO_URI: uri, PORT: String(apiPort), JWT_SECRET: 'isolated-transfer-only', AUTHORIZATION_MODE: 'enforce', PRIVATE_MEDIA_ACCESS: 'false', OPENWA_BASE_URL: '', OPENWA_API_KEY: '', S3_ENDPOINT: '', S3_BUCKET: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '', EMAIL_USER: '', EMAIL_PASS: '', ALERT_EMAIL_TO: '', CREATION_STAGING_DIR: path.join(directory, 'staging'), CREATION_LOG_DIR: path.join(directory, 'logs') };
Object.assign(process.env, environment);
const standalone = process.argv.includes('--standalone');
const mongo = spawn(process.env.MONGOD_BINARY || 'mongod', [...(!standalone ? ['--replSet', 'verifyRs'] : []), '--dbpath', path.join(directory, 'data'), '--port', String(mongoPort), '--bind_ip', '127.0.0.1', '--logpath', path.join(directory, 'mongo.log'), '--quiet'], { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(r => setTimeout(r, ms));
let api, output = '', checks = 0;
try {
  for (let i = 0; ; i++) { try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 300, directConnection: true }); break; } catch (e) { if (i > 60) throw e; await pause(200); } }
  if (!standalone) {
    await mongoose.connection.db.admin().command({ replSetInitiate: { _id: 'verifyRs', members: [{ _id: 0, host: `127.0.0.1:${mongoPort}` }] } });
    for (let i = 0; ; i++) { if ((await mongoose.connection.db.admin().command({ hello: 1 })).isWritablePrimary) break; if (i > 100) throw Error('No isolated primary'); await pause(200); }
  }
  const { default: User } = await import('../models/users.js');
  const { default: Role } = await import('../models/roles.js');
  const { default: Assignment } = await import('../models/accessAssignment.js');
  const { default: Batch } = await import('../models/batches.js');
  const { default: Student } = await import('../models/students.js');
  const { default: Fee } = await import('../models/fees.js');
  const { default: FeeLog } = await import('../models/feeLogs.js');
  const { default: Shift } = await import('../models/studentBatchShifts.js');
  const { default: Counter } = await import('../models/studentRollCounters.js');
  const { createStudentAdmissionFee } = await import('../utils/feePayment.js');
  const { completeWorkflowAccess } = await import('../utils/accessWorkflowRules.js');
  const { accessCatalog } = await import('../utils/accessCatalog.js');
  for (const model of [Student, Fee, FeeLog, Shift, Counter]) await model.init();
  const owner = await User.create({ name: 'Isolated owner', role: 'superadmin', platformOwner: true, email: 'owner@example.invalid' });
  const staff = await User.create({ name: 'Shift only', role: 'Staff', accountType: 'staff', accessManaged: true });
  const limited = await User.create({ name: 'Limited discounts', role: 'Staff', accountType: 'staff', accessManaged: true });
  for (const [user, extra] of [[staff, []], [limited, [{ permission: 'fees.discount.fee', scope: 'all', maxAmount: 5000 }]]]) {
    const role = await Role.create({ name: user.name, code: `transfer-${user._id}`, managed: true, active: true, grants: completeWorkflowAccess([{ permission: 'students.transfer.student.batch', scope: 'all' }, ...extra], accessCatalog) });
    await Assignment.create({ user: user._id, role: role._id, assignedBy: owner._id });
  }
  const from = await Batch.create({ name: 'Source', batch_fee: '10000', is_paid_batch: true, batch_type: 'Online', roll_nickname: 'SRC' });
  const to = await Batch.create({ name: 'Destination', batch_fee: '15000', is_paid_batch: true, batch_type: 'Online', roll_nickname: 'DST' });
  const other = await Batch.create({ name: 'Other destination', batch_fee: '15000', is_paid_batch: true, batch_type: 'Online', roll_nickname: 'ALT' });
  const tiny = await Batch.create({ name: 'Too small', batch_fee: '1000', is_paid_batch: true });
  let seq = 0;
  const student = async (name = 'Transfer fixture') => {
    const s = await Student.create({ name, phone: `0300000${String(++seq).padStart(4, '0')}`, batch: from._id, roll_number: `SRC-${seq}` });
    await createStudentAdmissionFee({ studentId: s._id, batchId: from._id, totalFee: 10000, payingNow: 4000, actionUserId: owner._id, nextInstallmentDate: '2035-01-01' });
    return s;
  };
  api = spawn(process.execPath, [path.join(source, 'index.js')], { cwd: directory, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout.on('data', c => output = (output + c).slice(-12000)); api.stderr.on('data', c => output = (output + c).slice(-12000));
  const base = `http://127.0.0.1:${apiPort}`;
  for (let i = 0; ; i++) { try { assert.equal((await fetch(base + '/health/ready')).status, 200); break; } catch { if (i > 600 || api.exitCode !== null) throw Error(`API startup exit=${api.exitCode}: ${output}`); await pause(200); } }
  const request = async (user, s, body, status) => {
    const token = jwt.sign({ user: { id: String(user._id), role: user.role } }, environment.JWT_SECRET);
    const r = await fetch(`${base}/students/transfer-batch/${s._id}`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ batch: String(to._id), transfer_pending_dues: true, remarks: 'Reviewed previous balance', ...body }) });
    const d = await r.json(); if (status !== undefined) assert.equal(r.status, status, JSON.stringify(d)); checks++; return { status: r.status, data: d };
  };
  const snapshot = async s => JSON.stringify({ student: await Student.findById(s._id).lean(), fees: await Fee.find({ student: s._id }).sort({ _id: 1 }).lean(), logs: await FeeLog.find({ student: s._id }).sort({ _id: 1 }).lean(), shifts: await Shift.find({ student: s._id }).lean() });
  const denied = await student(); let before = await snapshot(denied);
  await request(staff, denied, {}, 403); assert.equal(await snapshot(denied), before); checks++;
  await request(limited, denied, {}, 403); assert.equal(await snapshot(denied), before); checks++;
  await request(owner, denied, { remarks: '' }, 400);
  await request(owner, denied, { batch: String(tiny._id) }, 400);
  if (standalone) {
    await request(owner, denied, {}, 503); assert.equal(await snapshot(denied), before); checks++;
  } else {
    const ok = await student(); const r = await request(owner, ok, {}, 200);
    assert.equal(r.data.new_batch_payable, 6000); checks++;
    const fees = await Fee.find({ student: ok._id }).lean();
    assert.equal(fees.find(f => String(f.batch) === String(from._id)).amount, 0);
    assert.equal(fees.find(f => String(f.batch) === String(to._id)).amount, 6000); checks += 2;
    const saved = await Student.findById(ok._id).lean(); assert.equal(saved.pending_fee, 6000); assert.equal(saved.paid_fee, 4000); assert.equal(saved.total_fee, 10000); checks += 3;
    assert.equal(await Shift.countDocuments({ student: ok._id }), 1); checks++;
    await request(owner, ok, {}, 400);
    const rollback = await student('ROLLBACK FIXTURE'); before = await snapshot(rollback);
    await mongoose.connection.db.command({ collMod: Shift.collection.collectionName, validator: { student_name: { $ne: 'ROLLBACK FIXTURE' } } });
    await request(owner, rollback, {}, 500); assert.equal(await snapshot(rollback), before, 'Transaction must restore both ledgers and batch on failure'); checks++;
    await mongoose.connection.db.command({ collMod: Shift.collection.collectionName, validator: {} });
    const concurrent = await student(); const results = await Promise.all([request(owner, concurrent, {}), request(owner, concurrent, { batch: String(other._id) })]);
    assert.equal(results.filter(r => r.status === 200).length, 1, JSON.stringify(results)); checks++;
    assert.equal(await Shift.countDocuments({ student: concurrent._id }), 1); assert.equal(await Fee.countDocuments({ student: concurrent._id }), 2); checks += 2;
  }
  console.log(JSON.stringify({ pendingDuesTransferChecks: checks, standalone, isolatedDatabase: true, externalServicesCalled: false }));
} finally {
  if (api) { api.kill('SIGTERM'); await new Promise(r => api.exitCode !== null ? r() : api.once('exit', r)); }
  await mongoose.disconnect(); mongo.kill('SIGTERM'); await new Promise(r => mongo.exitCode !== null ? r() : mongo.once('exit', r));
  process.chdir(os.tmpdir()); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

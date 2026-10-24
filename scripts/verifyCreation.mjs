// Explicit opt-in integration verification. Never reads an application .env or accepts a remote DB URI.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lca-creation-verify-'));
await fs.mkdir(path.join(temp, 'data'));
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const uri = `mongodb://127.0.0.1:${port}/lca_verify_${Date.now()}`;
process.chdir(temp); // Prevent dotenv in transitive imports from loading the real project's env.
Object.assign(process.env, { MONGO_URI: uri, CREATION_TEST_URI: uri, CREATION_STAGING_DIR: path.join(temp, 'staging'),
  OPENWA_BASE_URL: '', OPENWA_API_KEY: '', S3_ENDPOINT: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '',
  EMAIL_USER: '', EMAIL_PASS: '', ALERT_EMAIL_TO: '', CREATION_LOG_DIR: '' });
const startMongo = () => spawn(process.env.MONGOD_BINARY || 'mongod', ['--dbpath', path.join(temp, 'data'), '--port', String(port),
  '--bind_ip', '127.0.0.1', '--logpath', path.join(temp, 'mongo.log'), '--logappend', '--quiet'], { windowsHide: true, stdio: 'ignore' });
let mongod = startMongo();
const children = new Set();
const results = [];
let service, Request, Student, User, Fee, FeeLog, Batch, Counter, defaults;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const record = async (name, run) => { await run(); results.push(name); console.log(`PASS ${name}`); };
const response = () => ({ statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
  status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, once() {} });
const requestFor = (actor, key, body, protocol = '2') => ({ user: { user: { id: String(actor._id) } }, body,
  get(name) { return name === 'Idempotency-Key' ? key : name === 'X-Creation-Protocol' ? protocol : undefined; } });
const claim = async (req, kind = 'student') => {
  const res = response(); let passed = false;
  await service.claimCreation(kind)(req, res, (error) => { if (error) throw error; passed = true; });
  return { res, passed, journal: req.creationRequest };
};
async function fixture({ discount = 100, paid = 200, total = 1000 } = {}) {
  for (const collection of await mongoose.connection.db.collections()) await collection.deleteMany({});
  const actor = await User.create({ name: 'Verification staff', email: 'staff@example.invalid', role: 'admin' });
  const batch = await Batch.create({ name: 'Verification On Campus', batch_type: 'On Campus', roll_nickname: 'VERIFY', batch_fee: String(total) });
  const body = { name: 'Test Student', phone: '03001234567', batch: String(batch._id) };
  const req = requestFor(actor, crypto.randomUUID(), body);
  const { journal } = await claim(req);
  const { getNextStudentRollNumber } = await import('../utils/studentRollNumber.js');
  const roll = await getNextStudentRollNumber({ batchId: batch._id, batchName: batch.name, batchType: batch.batch_type, rollNickname: batch.roll_nickname });
  const hash = await bcrypt.hash(defaults.DEFAULT_STUDENT_PASSWORD, 4);
  const prepared = await service.prepareCreation(journal, {
    user: { name: body.name, email: 'student.03001234567@lca.local', password: hash, role: 'student' },
    student: { name: body.name, phone: body.phone, email: 'student.03001234567@lca.local', batch: batch._id,
      roll_number: roll, total_fee: total - discount, paid_fee: paid, pending_fee: total - discount - paid, password: hash },
    fee: { batchId: batch._id, totalFee: total, discountAmount: discount, payingNow: paid, paymentMethod: 'Cash', discountDescription: 'Test discount' },
  });
  return { actor, batch, req, prepared, total, discount, paid };
}
async function consistent(f) {
  const journal = await Request.findById(f.prepared._id).select('+plan');
  assert.equal(journal.state, 'complete');
  const student = await Student.findById(journal.recordId);
  assert.equal(await Student.countDocuments(), 1);
  assert.equal(await User.countDocuments({ role: 'student' }), 1);
  assert.equal(student.roll_number, 'OC-VERIFY-1');
  assert.ok(student.qrcode.includes('<svg'));
  assert.equal(student.creation_pending, false);
  const login = await User.findOne({ email: student.email });
  assert.equal(login.creation_pending, false);
  assert.equal(await bcrypt.compare(defaults.DEFAULT_STUDENT_PASSWORD, login.password), true);
  const fees = await Fee.find({ student: student._id });
  assert.equal(fees.length, 1);
  assert.equal(fees[0].amount, f.total - f.discount - f.paid);
  assert.equal(fees[0].status, fees[0].amount ? 'Pending' : 'Paid');
  const logs = await FeeLog.find({ student: student._id });
  assert.equal(logs.length, 1 + Number(f.discount > 0) + Number(f.paid > 0));
  assert.equal(logs.filter((log) => log.action_type === 'Paid').reduce((n, log) => n + log.action_amount, 0), f.paid);
  assert.equal(student.paid_fee, f.paid);
  assert.equal(student.total_fee, f.total - f.discount);
  assert.equal(logs.filter((log) => log.action_type === 'Created').reduce((n, log) => n + log.action_amount, 0), f.total);
  assert.equal(logs.filter((log) => log.action_type === 'Discounted').reduce((n, log) => n + log.action_amount, 0), f.discount);
  assert.ok(logs.every((log) => String(log.fee) === String(fees[0]._id)));
  assert.equal(String(student.creation_request), String(journal._id));
  assert.equal(String(login.creation_request), String(journal._id));
  assert.equal(student.pending_fee, fees[0].amount);
  assert.equal((await Counter.findOne({ batch: f.batch._id })).seq, 1);
}
async function child(mode, journalId, boundary) {
  const process = fork(path.join(scripts, 'creationVerificationChild.mjs'), [mode, String(journalId), String(boundary)],
    { cwd: temp, env: globalThis.process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.add(process);
  let stderr = ''; process.stderr.on('data', (chunk) => { stderr += chunk; });
  const message = await Promise.race([once(process, 'message').then(([value]) => value),
    once(process, 'exit').then(([code]) => { throw new Error(`Child exited (${code}): ${stderr}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`Child timed out: ${stderr}`)), 15000); timer.unref(); })]);
  return { process, message };
}
async function kill(process) { const exit = once(process, 'exit'); process.kill('SIGKILL'); await exit; children.delete(process); }

try {
  for (let attempt = 0; ; attempt++) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 }); break; }
    catch (error) { if (attempt >= 30) throw error; await pause(200); }
  }
  service = await import('../utils/creationService.js');
  ({ default: Request } = await import('../models/creationRequests.js'));
  ({ default: Student } = await import('../models/students.js'));
  ({ default: User } = await import('../models/users.js'));
  ({ default: Fee } = await import('../models/fees.js'));
  ({ default: FeeLog } = await import('../models/feeLogs.js'));
  ({ default: Batch } = await import('../models/batches.js'));
  ({ default: Counter } = await import('../models/studentRollCounters.js'));
  defaults = await import('../utils/creationDefaults.js');
  await Request.createIndexes();
  const build = await mongoose.connection.db.admin().command({ buildInfo: 1 });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.equal(hello.setName, undefined, 'Verification must use standalone MongoDB');
  console.log(`Isolated standalone MongoDB ${build.version} at localhost:${port}`);
  for (const boundary of [0, 1]) await record(`real crash after ${boundary ? 'roll reservation' : 'journal claim'}, before plan`, async () => {
    const f = await fixture();
    await Request.deleteMany({}); await Counter.deleteMany({});
    const input = { actor: String(f.actor._id), key: crypto.randomUUID(), body: f.req.body };
    const crashed = await child('preflight', JSON.stringify(input), boundary); await kill(crashed.process);
    assert.equal(await Student.countDocuments(), 0); assert.equal(await User.countDocuments({ role: 'student' }), 0);
    assert.equal(await Fee.countDocuments(), 0); assert.equal(await FeeLog.countDocuments(), 0);
    const journal = await Request.findById(crashed.message.journal).select('+plan');
    assert.equal(journal.state, 'preparing'); assert.equal(journal.plan, undefined);
    // Expire a killed preflight; its unused roll reservation is allowed to leave a gap.
    await Request.collection.updateOne({ _id: journal._id }, { $set: { updatedAt: new Date(Date.now() - 360000) } });
    const restarted = await claim(requestFor(f.actor, input.key, input.body)); assert.equal(restarted.passed, true);
    const { getNextStudentRollNumber } = await import('../utils/studentRollNumber.js');
    const roll = await getNextStudentRollNumber({ batchId: f.batch._id, batchName: f.batch.name, batchType: f.batch.batch_type, rollNickname: f.batch.roll_nickname });
    assert.equal(roll, `OC-VERIFY-${boundary + 1}`);
    const plan = await service.prepareCreation(restarted.journal, { user: f.prepared.plan.user,
      student: { ...f.prepared.plan.student, roll_number: roll }, fee: { batchId: f.batch._id, totalFee: 1000, discountAmount: 100,
        payingNow: 200, paymentMethod: 'Cash' } });
    await service.commitCreation(plan);
    assert.equal(await Student.countDocuments(), 1); assert.equal(await Fee.countDocuments(), 1);
    assert.equal((await Student.findOne()).roll_number, roll);
  });
  for (let boundary = 1; boundary <= 10; boundary++) await record(`real process crash after core write ${boundary}`, async () => {
    const f = await fixture();
    const crashed = await child('commit', f.prepared._id, boundary);
    assert.equal(crashed.message.writes, boundary);
    await kill(crashed.process);
    const current = await Request.findById(f.prepared._id).select('+plan');
    if (current.state !== 'complete') {
      await Request.updateOne({ _id: current._id }, { $set: { leaseUntil: new Date(0) } });
      await service.processCreationOnce({ perform: async () => 'verification-skipped-network' });
    }
    await consistent(f);
    await service.processCreationOnce({ perform: async () => 'verification-skipped-network' });
    await consistent(f); // Repeated recovery must not insert more records, fees, or roll numbers.
  });
  for (let boundary = 1; boundary <= 3; boundary++) await record(`staff core crash after write ${boundary}`, async () => {
    const f = await fixture(); await Request.deleteMany({});
    const body = { name: 'New staff', email: 'new-staff@example.invalid', phone: '03001230000', role: 'admin' };
    const { journal } = await claim(requestFor(f.actor, crypto.randomUUID(), body), 'user');
    const prepared = await service.prepareCreation(journal, { user: { ...body, password: await bcrypt.hash(defaults.DEFAULT_STAFF_PASSWORD, 4) } });
    const crashed = await child('commit', prepared._id, boundary); await kill(crashed.process);
    const current = await Request.findById(prepared._id);
    if (current.state !== 'complete') {
      await Request.updateOne({ _id: current._id }, { $set: { leaseUntil: new Date(0) } });
      await service.processCreationOnce({ perform: async () => 'verification-skipped-network' });
    }
    assert.equal((await Request.findById(prepared._id)).state, 'complete');
    assert.equal(await User.countDocuments({ email: body.email }), 1);
    assert.equal((await User.findOne({ email: body.email })).creation_pending, false);
    assert.equal(await Student.countDocuments(), 0); assert.equal(await Fee.countDocuments(), 0);
  });
  await record('unclean MongoDB plus API process restart repairs partial core commit', async () => {
    const f = await fixture();
    const crashed = await child('commit', f.prepared._id, 4); await kill(crashed.process);
    await mongoose.disconnect();
    const exited = once(mongod, 'exit'); mongod.kill('SIGKILL'); await exited;
    mongod = startMongo();
    for (let attempt = 0; ; attempt++) {
      try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 }); break; }
      catch (error) { if (attempt >= 30) throw error; await pause(200); }
    }
    await Request.updateOne({ _id: f.prepared._id }, { $set: { leaseUntil: new Date(0) } });
    await service.processCreationOnce({ perform: async () => 'verification-recovered-after-db-crash' });
    await consistent(f);
  });
  await record('crash after durable plan, before first core write', async () => {
    const f = await fixture();
    await Request.updateOne({ _id: f.prepared._id }, { $set: { leaseUntil: new Date(0) } });
    await service.processCreationOnce({ perform: async () => 'verification-skipped-network' }); await consistent(f);
  });
  await record('published student cannot be deleted while core journal still needs recovery', async () => {
    const f = await fixture();
    await assert.rejects(service.commitCreation(f.prepared, true, { afterWrite: async (name) => {
      if (name === 'publish_student') throw new Error('Verification interruption before publishing login');
    } }), /Verification interruption/);
    assert.equal((await Student.findById(f.prepared.recordId)).creation_pending, false);
    const { deleteStudentCascade } = await import('../utils/deleteStudentCascade.js');
    await assert.rejects(deleteStudentCascade(f.prepared.recordId), /journal must finish recovery/);
    assert.equal(await Student.countDocuments(), 1); assert.equal(await Fee.countDocuments(), 1);
    await Request.updateOne({ _id: f.prepared._id }, { $set: { leaseUntil: new Date(0) } });
    await service.processCreationOnce({ perform: async () => 'verification-recovered' }); await consistent(f);
  });
  for (const options of [{ discount: 1000, paid: 0 }, { discount: 0, paid: 1000 }]) await record(`financial variant discount=${options.discount} paid=${options.paid}`, async () => {
    const f = await fixture(options); await service.commitCreation(f.prepared); await consistent(f);
  });
  await record('same key replay and different-key recent replay do not duplicate', async () => {
    const f = await fixture(); await service.commitCreation(f.prepared);
    assert.equal((await claim(f.req)).res.statusCode, 200);
    const retry = requestFor(f.actor, crypto.randomUUID(), f.req.body);
    assert.equal((await claim(retry)).res.statusCode, 200);
    assert.equal(await Request.countDocuments(), 1);
    const res = response(); await service.getCreationByKey('student')({ ...retry, params: { key: retry.get('Idempotency-Key') } }, res, (e) => { throw e; });
    assert.equal(String(res.body._id), String(f.prepared.recordId)); await consistent(f);
  });
  await record('siblings sharing a phone are explicitly rejected, never merged', async () => {
    const f = await fixture(); await service.commitCreation(f.prepared);
    const sibling = requestFor(f.actor, crypto.randomUUID(), { ...f.req.body, name: 'Different Sibling' });
    assert.equal((await claim(sibling)).res.statusCode, 409); assert.equal(await Student.countDocuments(), 1);
  });
  await record('delete, re-add same phone, then replay old key stays blocked', async () => {
    const f = await fixture(); await service.commitCreation(f.prepared);
    await Student.deleteOne({ _id: f.prepared.recordId });
    await User.deleteOne({ role: 'student' });
    await service.tombstoneCreation('student', f.prepared.recordId);
    const readded = await claim(requestFor(f.actor, crypto.randomUUID(), f.req.body));
    assert.equal(readded.passed, true);
    assert.notEqual(String(readded.journal._id), String(f.prepared._id));
    assert.equal((await claim(f.req)).res.statusCode, 410);
    assert.equal(await Request.countDocuments({ state: 'deleted' }), 1);
    assert.equal((await Request.findById(f.prepared._id)).identity, undefined);
  });
  await record('two processes claim once; killed owner is recoverable', async () => {
    const f = await fixture(); await service.commitCreation(f.prepared);
    const [one, two] = await Promise.all([child('claim', f.prepared._id), child('claim', f.prepared._id)]);
    assert.equal(Number(one.message.claimed) + Number(two.message.claimed), 1);
    const owner = one.message.claimed ? one : two;
    await kill(owner.process);
    await Request.updateOne({ _id: f.prepared._id }, { $set: { leaseUntil: new Date(0) } });
    await service.processCreationOnce({ perform: async () => 'verification-recovered' });
    assert.equal((await Request.findById(f.prepared._id)).finalized, true);
  });
  await record('real crash mid-provider upload keeps file and resumes the unfinished job', async () => {
    const f = await fixture();
    const directory = path.join(process.env.CREATION_STAGING_DIR, String(f.prepared._id)); await fs.mkdir(directory, { recursive: true });
    const stagedPath = path.join(directory, 'verification.jpg'); await fs.writeFile(stagedPath, 'isolated upload fixture');
    f.prepared.plan.assets = [{ name: 'avatar:verification', type: 'avatar', stagedPath, ext: '.jpg' }];
    f.prepared.markModified('plan');
    f.prepared.jobs.unshift({ name: 'avatar:verification', state: 'pending', attempts: 0, nextRun: new Date() });
    await f.prepared.save(); await service.commitCreation(f.prepared);
    const crashed = await child('job', f.prepared._id);
    assert.equal(crashed.message.jobStarted, 'avatar:verification'); await kill(crashed.process);
    let stored = await Request.findById(f.prepared._id);
    assert.equal(stored.jobs[0].state, 'processing'); assert.equal(stored.jobs[0].attempts, 1);
    assert.equal((await fs.stat(stagedPath)).isFile(), true);
    await Request.updateOne({ _id: stored._id }, { $set: { leaseUntil: new Date(0) } });
    await service.processCreationOnce({ perform: async () => 'https://example.invalid/test-upload' });
    stored = await Request.findById(stored._id);
    assert.equal(stored.jobs[0].state, 'complete'); assert.equal(stored.jobs[0].attempts, 2); assert.equal(stored.finalized, true);
    assert.equal(await fs.stat(stagedPath).then(() => true).catch(() => false), false);
    await consistent(f);
  });
  await record('independent retry budgets and manual retry only rerun failed uploads', async () => {
    const f = await fixture();
    const directory = path.join(process.env.CREATION_STAGING_DIR, String(f.prepared._id)); await fs.mkdir(directory, { recursive: true });
    const avatar = path.join(directory, 'avatar.jpg'), evidence = path.join(directory, 'proof.pdf');
    await fs.writeFile(avatar, 'test avatar'); await fs.writeFile(evidence, 'test evidence');
    f.prepared.plan.assets = [{ name: 'avatar:test', type: 'avatar', stagedPath: avatar, ext: '.jpg' },
      { name: 'evidence:test', type: 'evidence', stagedPath: evidence, ext: '.pdf' }]; f.prepared.markModified('plan');
    f.prepared.jobs.unshift({ name: 'avatar:test', state: 'pending', nextRun: new Date() }, { name: 'evidence:test', state: 'pending', nextRun: new Date() });
    await f.prepared.save(); await service.commitCreation(f.prepared);
    const counts = { avatar: 0, evidence: 0, welcome: 0 };
    const perform = async (_request, job) => {
      const kind = job.name.split(':')[0]; counts[kind]++;
      if (kind === 'avatar') throw new Error('Simulated slow storage');
      return kind === 'evidence' ? 'https://example.invalid/proof.pdf' : 'sent';
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      await Request.updateOne({ _id: f.prepared._id }, { $set: { nextRun: new Date(0), 'jobs.0.nextRun': new Date(0) } });
      await service.processCreationOnce({ perform });
    }
    assert.deepEqual(counts, { avatar: 5, evidence: 1, welcome: 1 });
    assert.equal((await Request.findById(f.prepared._id)).jobs[0].state, 'failed');
    assert.equal((await FeeLog.findOne({ action_type: 'Paid' })).payment_evidence, 'https://example.invalid/proof.pdf');
    assert.equal((await FeeLog.findOne({ action_type: 'Paid' })).evidence_status, 'complete');
    assert.equal((await fs.stat(avatar)).isFile(), true);
    const res = response(); await service.retryCreation('student')({ user: { user: { id: f.actor._id } }, params: { id: String(f.prepared.recordId) } }, res, (e) => { throw e; });
    assert.equal(res.statusCode, 202);
    await service.processCreationOnce({ perform: async (_request, job) => { assert.equal(job.name, 'avatar:test'); return 'https://example.invalid/avatar.jpg'; } });
    assert.equal((await Request.findById(f.prepared._id)).finalized, true);
    assert.equal((await Student.findById(f.prepared.recordId)).processing_status, 'complete');
    await consistent(f);
  });
  await record('disk-full staging leaves no core records or staged files', async () => {
    const f = await fixture(); // Remove the prepared plan to test the actual pre-commit staging boundary.
    await Request.updateOne({ _id: f.prepared._id }, { $set: { state: 'preparing' }, $unset: { plan: 1 } });
    const image = { name: 'avatar.jpg', size: 10, mv: async (target) => fs.writeFile(target, 'first staged file') };
    const evidence = { name: 'evidence.pdf', size: 10, mv: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
    await assert.rejects(service.stageCreationFiles(f.prepared, { image, payment_evidence: evidence }, true),
      (error) => error.status === 507 && error.code === 'CREATION_NOT_COMMITTED');
    assert.equal(await Student.countDocuments(), 0); assert.equal(await User.countDocuments({ role: 'student' }), 0);
    assert.equal(await Fee.countDocuments(), 0); assert.equal(await FeeLog.countDocuments(), 0);
    assert.equal(await fs.stat(path.join(process.env.CREATION_STAGING_DIR, String(f.prepared._id))).then(() => true).catch(() => false), false);
  });
  await record('no plaintext credential in journal; hashes cleared after core commit', async () => {
    const f = await fixture();
    let raw = await Request.collection.findOne({ _id: f.prepared._id });
    assert.ok(!JSON.stringify(raw).includes(defaults.DEFAULT_STUDENT_PASSWORD));
    assert.match(raw.plan.user.password, /^\$2/);
    await service.commitCreation(f.prepared);
    raw = await Request.collection.findOne({ _id: f.prepared._id });
    assert.equal(raw.plan.user.password, undefined); assert.equal(raw.plan.student.password, undefined);
  });
  await record('lost lease owner cannot overwrite recovered job results', async () => {
    const f = await fixture(); await service.commitCreation(f.prepared);
    let entered, release;
    const started = new Promise((resolve) => { entered = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    const oldWorker = service.processCreationOnce({ perform: async () => { entered(); await waiting; return 'stale-result'; } });
    await started;
    await Request.updateOne({ _id: f.prepared._id }, { $set: { leaseUntil: new Date(0) } });
    await service.processCreationOnce({ perform: async () => 'new-owner-result' });
    release(); await oldWorker;
    const stored = await Request.findById(f.prepared._id);
    assert.equal(stored.jobs[0].result, 'new-owner-result'); assert.equal(stored.finalized, true);
    assert.equal((await Student.findById(f.prepared.recordId)).processing_status, 'complete');
    assert.equal((await Student.findById(f.prepared.recordId)).creation_worker_epoch, stored.leaseEpoch);
  });
  await record('five interrupted attempts become failed instead of retrying forever', async () => {
    const f = await fixture(); await service.commitCreation(f.prepared);
    await Request.updateOne({ _id: f.prepared._id }, { $set: { 'jobs.0.state': 'processing', 'jobs.0.attempts': 5 } });
    let sends = 0; await service.processCreationOnce({ perform: async () => { sends++; return 'not-allowed'; } });
    const current = await Request.findById(f.prepared._id);
    assert.equal(sends, 0); assert.equal(current.jobs[0].state, 'failed'); assert.equal(current.jobs[0].attempts, 5);
    assert.equal(current.finalized, true);
  });
  await record('departed creator: school admin can retry student, teacher cannot', async () => {
    const f = await fixture(); await service.commitCreation(f.prepared);
    await User.deleteOne({ _id: f.actor._id });
    const admin = await User.create({ name: 'Replacement admin', role: 'admin' });
    const teacher = await User.create({ name: 'Teacher', role: 'teacher' });
    await Request.updateOne({ _id: f.prepared._id }, { $set: { 'jobs.0.state': 'failed', finalized: true } });
    for (const [actor, expected] of [[admin, 200], [teacher, 404]]) {
      const res = response(); await service.getCreationStatus('student')({ user: { user: { id: actor._id } }, params: { id: String(f.prepared.recordId) } }, res, (e) => { throw e; });
      assert.equal(res.statusCode, expected);
    }
    const retry = response(); await service.retryCreation('student')({ user: { user: { id: admin._id } }, params: { id: String(f.prepared.recordId) } }, retry, (e) => { throw e; });
    assert.equal(retry.statusCode, 202); assert.equal((await Request.findById(f.prepared._id)).jobs[0].state, 'pending');
  });
  await record('welcome payload is never persisted plaintext, including WhatsApp history', async () => {
    const f = await fixture(); await service.commitCreation(f.prepared);
    process.env.OPENWA_BASE_URL = 'http://127.0.0.1:9'; process.env.OPENWA_API_KEY = 'fake-verification-key';
    const originalFetch = globalThis.fetch;
    let sends = 0;
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith('/api/sessions')) return new Response(JSON.stringify([{ id: 'verify', name: 'lca-portal', status: 'ready' }]), { status: 200 });
      assert.ok(String(url).includes('/messages/send-text'));
      sends++; assert.ok(JSON.parse(options.body).text.includes(defaults.DEFAULT_STUDENT_PASSWORD));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    try { await service.processCreationOnce(); } finally { globalThis.fetch = originalFetch; process.env.OPENWA_BASE_URL = ''; process.env.OPENWA_API_KEY = ''; }
    const { default: Message } = await import('../models/whatsappQueuedMessage.js');
    const history = await Message.findById(f.prepared._id);
    assert.equal(sends, 1); assert.equal(history.status, 'sent'); assert.ok(history.message.includes('[redacted]'));
    assert.ok(!JSON.stringify(history).includes(defaults.DEFAULT_STUDENT_PASSWORD));
    const raw = await Request.collection.findOne({ _id: f.prepared._id }); assert.equal(raw.plan, undefined);
  });
  await record('password changed before delivery prevents sending stale credentials', async () => {
    const f = await fixture(); await service.commitCreation(f.prepared);
    await User.updateOne({ role: 'student' }, { $set: { password: await bcrypt.hash('different-unique-password', 4) } });
    await service.processCreationOnce();
    const stored = await Request.findById(f.prepared._id);
    assert.equal(stored.jobs[0].result, 'skipped_password_changed'); assert.equal(stored.finalized, true);
  });
  await record('old cached frontend is blocked before any journal/core write', async () => {
    const f = await fixture(); const before = await Request.countDocuments();
    const old = requestFor(f.actor, crypto.randomUUID(), { name: 'Old tab', phone: '03009998888' }, undefined);
    old.get = (name) => name === 'Idempotency-Key' ? 'legacy-request-key-1234' : undefined;
    assert.equal((await claim(old)).res.statusCode, 426);
    assert.equal(await Request.countDocuments(), before); assert.equal(await Student.countDocuments(), 0);
  });
  for (let boundary = 1; boundary <= 9; boundary++) await record(`reused student crash after core write ${boundary}`, async () => {
    const f = await fixture();
    await service.commitCreation(f.prepared);
    await service.processCreationOnce({ perform: async () => 'verification-no-network' });
    const existing = await Student.findById(f.prepared.recordId);
    const login = await User.findOne({ email: existing.email });
    const oldHash = login.password;
    const previousFee = await Fee.findOne({ student: existing._id });
    await FeeLog.create({ student: existing._id, fee: previousFee._id, action_type: 'Paid', action_amount: 700, amount: 700, payment_method: 'Cash' });
    await Fee.updateOne({ _id: previousFee._id }, { $set: { amount: 0, status: 'Paid' } });
    const nextBatch = await Batch.create({ name: 'Recovery new batch', batch_type: 'Online', roll_nickname: 'RECOVER', batch_fee: '2000' });
    const key = crypto.randomUUID();
    const journal = await Request.create({ actor: f.actor._id, kind: 'student', key, aliases: [key], fingerprint: key,
      identity: `reuse:${existing._id}:${nextBatch._id}`, recordId: existing._id, leaseEpoch: Date.now() * 1000 });
    await Student.updateOne({ _id: existing._id }, { $set: { admission_request: journal._id } });
    const prepared = await service.prepareCreation(journal, { user: login.toObject(),
      student: { ...existing.toObject(), batch: nextBatch._id, roll_number: 'On-RECOVER-1', normalized_phone: '3001234567' },
      existingStudent: existing, existingUser: login,
      fee: { batchId: nextBatch._id, totalFee: 2000, discountAmount: 0, payingNow: 0 } });
    const crashed = await child('commit', prepared._id, boundary); await kill(crashed.process);
    await Request.updateOne({ _id: prepared._id }, { $set: { leaseUntil: new Date(0) } });
    await service.processCreationOnce({ perform: async () => 'verification-no-network' });
    assert.equal((await Request.findById(prepared._id)).state, 'complete');
    assert.equal(await Student.countDocuments(), 1); assert.equal(await User.countDocuments({ role: 'student' }), 1);
    assert.equal((await User.findById(login._id)).password, oldHash);
    assert.equal(await Fee.countDocuments({ student: existing._id }), 2);
    assert.equal((await Student.findById(existing._id)).roll_number, 'On-RECOVER-1');
    assert.equal((await Fee.findById(previousFee._id)).amount, 0);
    const { default: Enrollment } = await import('../models/enrollments.js');
    const { default: Shift } = await import('../models/studentBatchShifts.js');
    assert.equal(await Enrollment.countDocuments({ student: existing._id }), 2);
    assert.equal(await Shift.countDocuments({ student: existing._id }), 1);
    assert.equal((await Student.findById(existing._id)).admission_request, undefined);
  });
  await record('alert delivery retry, durable cooldown and no PII (fake sender)', async () => {
    const { notifyOperationalAlert } = await import('../utils/operationalAlerts.js');
    const { default: Alert } = await import('../models/operationalAlerts.js');
    const missing = await notifyOperationalAlert('verify', { failed: 1 }); assert.equal(missing.configured, false);
    Object.assign(process.env, { ALERT_EMAIL_TO: 'operator@example.invalid', EMAIL_USER: 'sender@example.invalid', EMAIL_PASS: 'fake-only' });
    const failed = await notifyOperationalAlert('verify', { failed: 1 }, { send: async () => { throw new Error('fake outage'); } });
    assert.equal(failed.delivered, false); assert.equal((await Alert.findById('verify')).attempts, 1);
    await Alert.updateOne({ _id: 'verify' }, { $set: { nextAttempt: new Date(0) } });
    let sent = 0;
    const send = async (mail) => { sent++; assert.ok(mail.text.includes('"failed": 1')); assert.ok(!mail.text.includes('Test Student')); };
    assert.equal((await notifyOperationalAlert('verify', { failed: 1 }, { send })).delivered, true);
    await mongoose.disconnect(); await mongoose.connect(uri);
    assert.equal((await notifyOperationalAlert('verify', { failed: 1 }, { send })).deferred, true); assert.equal(sent, 1);
  });
  console.log(JSON.stringify({ passed: results.length, mongoVersion: build.version, replicaSet: false, externalServicesCalled: false, artifacts: temp }));
} finally {
  for (const process of children) if (process.exitCode === null && !process.killed) process.kill('SIGKILL');
  await mongoose.disconnect();
  if (mongod.exitCode === null) { const stopped = once(mongod, 'exit'); mongod.kill(); await stopped; }
  // Only remove the disposable data directory created above; preserve the diagnostic MongoDB log.
  const disposable = path.resolve(temp, 'data');
  if (path.dirname(disposable) === temp && path.dirname(temp) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('lca-creation-verify-')) {
    await fs.rm(disposable, { recursive: true, force: true });
  }
}

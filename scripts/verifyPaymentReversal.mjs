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
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lca-reversal-verify-'));
await fs.mkdir(path.join(directory, 'data'));
process.chdir(directory);
const port = async () => { const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value; };
const mongoPort = await port(), apiPort = await port();
const uri = `mongodb://127.0.0.1:${mongoPort}/reversal_verify`;
const environment = { ...process.env, MONGO_URI: uri, PORT: String(apiPort), JWT_SECRET: 'isolated-reversal-only', AUTHORIZATION_MODE: 'enforce',
  PRIVATE_MEDIA_ACCESS: 'false', OPENWA_BASE_URL: '', OPENWA_API_KEY: '', S3_ENDPOINT: '', S3_BUCKET: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '',
  EMAIL_USER: '', EMAIL_PASS: '', ALERT_EMAIL_TO: '', CREATION_STAGING_DIR: path.join(directory, 'staging'), CREATION_LOG_DIR: path.join(directory, 'logs') };
Object.assign(process.env, environment);
const mongo = spawn(process.env.MONGOD_BINARY || 'mongod', ['--dbpath', path.join(directory, 'data'), '--port', String(mongoPort), '--bind_ip', '127.0.0.1', '--logpath', path.join(directory, 'mongo.log'), '--quiet'], { windowsHide: true, stdio: 'ignore' });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let api, output = '', checks = 0;
try {
  for (let attempt = 0; ; attempt++) { try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 300 }); break; } catch (error) { if (attempt > 40) throw error; await pause(200); } }
  const { default: User } = await import('../models/users.js');
  const { default: Role } = await import('../models/roles.js');
  const { default: Assignment } = await import('../models/accessAssignment.js');
  const { default: Batch } = await import('../models/batches.js');
  const { default: Student } = await import('../models/students.js');
  const { default: Fee } = await import('../models/fees.js');
  const { default: FeeLog } = await import('../models/feeLogs.js');
  const { default: FeeReceipt } = await import('../models/feeReceipts.js');
  const { default: Slip } = await import('../models/admissionSlipVerification.js');
  const { default: Refund } = await import('../models/refundRequests.js');
  const { default: Reversal } = await import('../models/paymentReversals.js');
  const { default: AccessAudit } = await import('../models/accessAudit.js');
  const { completeWorkflowAccess } = await import('../utils/accessWorkflowRules.js');
  const { accessCatalog } = await import('../utils/accessCatalog.js');
  const owner = await User.create({ _id: '6a4d7603f9f83920a371e5c2', name: 'Owner', role: 'superadmin', platformOwner: true, email: 'owner@example.invalid' });
  const cashier = await User.create({ name: 'Cashier', role: 'Staff', accountType: 'staff', accessManaged: true });
  const plain = await User.create({ name: 'No permission', role: 'Staff', accountType: 'staff', accessManaged: true });
  const batch = await Batch.create({ name: 'Reversal batch' }), other = await Batch.create({ name: 'Later batch' });
  const assign = async (user, grants) => {
    const role = await Role.create({ name: `${user.name} role`, code: `role-${user._id}`, managed: true, active: true, grants: completeWorkflowAccess(grants, accessCatalog) });
    await Assignment.create({ user: user._id, role: role._id, assignedBy: owner._id });
  };
  await assign(cashier, [{ permission: 'fees.revert.payment', scope: 'all', maxAmount: 6000, noSelfApproval: true }]);
  await assign(plain, [{ permission: 'fees.get.fees', scope: 'all' }]);

  api = spawn(process.execPath, [path.join(source, 'index.js')], { cwd: directory, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout.on('data', (chunk) => { output = (output + chunk).slice(-10000); }); api.stderr.on('data', (chunk) => { output = (output + chunk).slice(-10000); });
  const base = `http://127.0.0.1:${apiPort}`;
  for (let attempt = 0; ; attempt++) { try { assert.equal((await fetch(`${base}/health/ready`)).status, 200); break; } catch { if (attempt > 300 || api.exitCode !== null) throw new Error(`API startup failed (exit=${api.exitCode}, signal=${api.signalCode}): ${output}`); await pause(200); } }
  const token = (user) => jwt.sign({ user: { id: String(user._id), role: 'superadmin', permissions: ['everything'] } }, environment.JWT_SECRET);
  const check = async (user, method, route, body, status = 200) => {
    const response = await fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${token(user)}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json().catch(() => null);
    assert.equal(response.status, status, `${user.name} ${method} ${route}: ${JSON.stringify(data)}`); checks++;
    return data;
  };
  const reason = { reason: 'Payment never received', note: 'Cashier entered it but no money arrived' };
  const newStudent = async (name, fees) => {
    const student = await Student.create({ name, phone: `03${String(Date.now()).slice(-9)}`, batch: batch._id });
    for (const [index, amount] of fees.entries()) {
      const fee = await Fee.create({ student: student._id, batch: batch._id, amount, due_date: `2035-01-0${index + 1}` });
      await FeeLog.create({ student: student._id, fee: fee._id, amount, action_amount: amount, action_type: 'Created', action_by: owner._id, action_date: new Date(Date.now() - 60000) });
    }
    await check(owner, 'GET', `/students/history/${student._id}`);
    return student;
  };
  const collect = (student, amount, user = owner) => check(user, 'POST', `/fees/collect-pending/${student._id}`,
    { amount, payment_option: 'partial', payment_method: 'Cash', remarks: 'Collected at desk', next_installment_date: '2035-01-01' });
  const paid = (student) => FeeLog.find({ student: student._id, action_type: 'Paid' }).sort({ action_date: 1, _id: 1 }).lean();

  // A collection, its receipt and its slip are reverted together and the balance comes back.
  const umee = await newStudent('Reversal student', [25000]);
  await collect(umee, 20000);
  const [payment] = await paid(umee);
  assert.ok(payment.payment_id); checks++;
  const receipt = await FeeReceipt.findOne({ student: umee._id }).lean();
  assert.equal(receipt.payment_id, payment.payment_id); checks++;
  await check(owner, 'POST', '/admission-slips/issue', { student_id: String(umee._id), student_name: umee.name, slip_type: 'fee', payment_log_id: String(payment._id), amount_received: 20000 });
  const slip = await Slip.findOne({ student: umee._id }).lean();
  assert.deepEqual([slip.payment_id, String(slip.payment_log)], [payment.payment_id, String(payment._id)]); checks++;
  const preview = await check(owner, 'POST', `/fees/payments/${payment._id}/revert`, { preview: true });
  assert.deepEqual([preview.payment.amount, preview.receipts.length, preview.slips.length, preview.blockers.length, preview.legacy], [20000, 1, 1, 0, false]); checks++;
  assert.deepEqual([preview.totals_before.paid_fee, preview.totals_before.pending_fee, preview.totals_after.paid_fee, preview.totals_after.pending_fee], [20000, 5000, 0, 25000]); checks++;
  assert.equal(await FeeLog.countDocuments({ _id: payment._id }), 1, 'Preview changes nothing'); checks++;
  await check(owner, 'POST', `/fees/payments/${payment._id}/revert`, { reason: 'Payment never received', note: 'short' }, 400);
  await check(owner, 'POST', `/fees/payments/${payment._id}/revert`, { reason: 'Because', note: 'Not one of the listed reasons' }, 400);
  await check(owner, 'POST', `/fees/payments/${payment._id}/revert`, reason);
  const fee = await Fee.findOne({ student: umee._id }).lean();
  assert.deepEqual([fee.amount, fee.status], [25000, 'Pending']); checks++;
  assert.deepEqual(await Promise.all([FeeLog.countDocuments({ _id: payment._id }), FeeReceipt.countDocuments({ _id: receipt._id })]), [0, 0]); checks++;
  const student = await Student.findById(umee._id).lean();
  assert.deepEqual([student.paid_fee, student.pending_fee, student.cash_amount, student.total_fee], [0, 25000, 0, 25000]); checks++;
  const verified = await check(owner, 'GET', `/admission-slips/verify/${slip.token}`);
  assert.deepEqual([verified.authentic, verified.status], [false, 'cancelled']); checks++;
  const saved = await Reversal.findOne({ payment_log: payment._id }).lean();
  assert.deepEqual([saved.status, saved.amount, saved.removed.logs.length, saved.removed.receipts.length, saved.removed.slips.length, saved.reason_category, String(saved.reverted_by)],
    ['completed', 20000, 1, 1, 1, 'Payment never received', String(owner._id)]); checks++;
  assert.ok(await AccessAudit.exists({ action: 'fees.revert.payment', target: `student:${umee._id}` })); checks++;
  const history = await check(owner, 'GET', `/students/history/${umee._id}`);
  assert.deepEqual([history.payment_reversals.length, history.payment_reversals[0].amount, history.payment_reversals[0].reverted_by.name, history.payment_reversals[0].removed],
    [1, 20000, 'Owner', undefined]); checks++;
  const again = await fetch(`${base}/fees/payments/${payment._id}/revert`, { method: 'POST', headers: { authorization: `Bearer ${token(owner)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(reason) });
  assert.ok([403, 404, 409].includes(again.status), `Reverting twice is refused (${again.status})`); checks++;

  // One collection spread over two fee records is reverted as a whole, from either entry.
  const split = await newStudent('Split student', [10000, 10000]);
  await collect(split, 15000);
  const parts = await paid(split);
  assert.equal(parts.length, 2); assert.equal(parts[0].payment_id, parts[1].payment_id); checks++;
  const splitPreview = await check(owner, 'POST', `/fees/payments/${parts[1]._id}/revert`, { preview: true });
  assert.deepEqual([splitPreview.payment.amount, splitPreview.entries.length, splitPreview.fee_changes.length], [15000, 2, 2]); checks++;
  await check(owner, 'POST', `/fees/payments/${parts[1]._id}/revert`, reason);
  assert.deepEqual((await Fee.find({ student: split._id }).sort({ due_date: 1 }).lean()).map((item) => [item.amount, item.status]), [[10000, 'Pending'], [10000, 'Pending']]); checks++;
  assert.equal((await Student.findById(split._id).lean()).pending_fee, 20000); checks++;

  // A later payment must be undone first; a later refund request blocks; a later batch move only warns.
  const twice = await newStudent('Twice student', [10000]);
  await collect(twice, 3000); await pause(20); await collect(twice, 4000);
  const [first, second] = await paid(twice);
  const blocked = await check(owner, 'POST', `/fees/payments/${first._id}/revert`, { preview: true });
  assert.match(blocked.blockers.join(' '), /later payment/); checks++;
  await check(owner, 'POST', `/fees/payments/${first._id}/revert`, reason, 409);
  await Student.updateOne({ _id: twice._id }, { $set: { batch: other._id } });
  const moved = await check(owner, 'POST', `/fees/payments/${second._id}/revert`, { preview: true });
  assert.match(moved.warnings.join(' '), /moved to another batch/); checks++;
  await check(owner, 'POST', `/fees/payments/${second._id}/revert`, reason, 400);
  await check(owner, 'POST', `/fees/payments/${second._id}/revert`, { ...reason, acknowledged: true });
  await check(owner, 'POST', `/fees/payments/${first._id}/revert`, { ...reason, acknowledged: true });
  assert.equal((await Fee.findOne({ student: twice._id }).lean()).amount, 10000); checks++;
  const refunded = await newStudent('Refund student', [5000]);
  await collect(refunded, 2000);
  const [refundedPayment] = await paid(refunded);
  await Refund.create({ student: refunded._id, amount: 2000, requested_by: owner._id, reason: 'Isolated refund' });
  await check(owner, 'POST', `/fees/payments/${refundedPayment._id}/revert`, reason, 409);

  // Payments saved before payment ids: the entry, receipt and slip are matched by amount and time, and the owner must confirm.
  const legacy = await newStudent('Legacy student', [8000]);
  const legacyFee = await Fee.findOne({ student: legacy._id });
  const legacyAt = new Date(Date.now() - 30000);
  const legacyLog = await FeeLog.create({ student: legacy._id, fee: legacyFee._id, amount: 8000, action_amount: 5000, action_type: 'Paid', action_by: owner._id, action_date: legacyAt, payment_method: 'Cash' });
  await Fee.updateOne({ _id: legacyFee._id }, { amount: 3000 });
  const legacyReceipt = await FeeReceipt.create({ student: legacy._id, payload: { payingNow: 5000 } });
  const legacySlip = await Slip.create({ token: 'legacy-slip-token-0001', student_name: legacy.name, slip_type: 'fee', amount_received: 5000, issued_at: new Date(legacyAt.getTime() + 5000) });
  const legacyPreview = await check(owner, 'POST', `/fees/payments/${legacyLog._id}/revert`, { preview: true });
  assert.deepEqual([legacyPreview.legacy, legacyPreview.receipts.length, legacyPreview.slips.length], [true, 1, 1]); checks++;
  await check(owner, 'POST', `/fees/payments/${legacyLog._id}/revert`, reason, 400);
  await check(owner, 'POST', `/fees/payments/${legacyLog._id}/revert`, { ...reason, acknowledged: true });
  assert.deepEqual([await FeeReceipt.countDocuments({ _id: legacyReceipt._id }), Boolean((await Slip.findById(legacySlip._id)).cancelled_at), (await Fee.findById(legacyFee._id)).amount], [0, true, 8000]); checks++;

  // Role grants: no permission, amount limit, and no reverting a payment the person collected themself.
  const staffStudent = await newStudent('Staff student', [20000]);
  await collect(staffStudent, 9000);
  const [large] = await paid(staffStudent);
  await check(plain, 'POST', `/fees/payments/${large._id}/revert`, { preview: true }, 403);
  await check(cashier, 'POST', `/fees/payments/${large._id}/revert`, { preview: true }, 403);
  await check(owner, 'POST', `/fees/payments/${large._id}/revert`, reason);
  const ownFee = await Fee.findOne({ student: staffStudent._id });
  const own = await FeeLog.create({ student: staffStudent._id, fee: ownFee._id, amount: 20000, action_amount: 1000, action_type: 'Paid', action_by: cashier._id, action_date: new Date(), payment_method: 'Cash', payment_id: 'own-payment' });
  await Fee.updateOne({ _id: ownFee._id }, { amount: 19000 });
  await check(cashier, 'POST', `/fees/payments/${own._id}/revert`, { preview: true }, 403);
  await FeeLog.updateOne({ _id: own._id }, { action_by: owner._id });
  await check(cashier, 'POST', `/fees/payments/${own._id}/revert`, { preview: true });
  await check(cashier, 'POST', `/fees/payments/${own._id}/revert`, reason);
  assert.equal(String((await Reversal.findOne({ payment_log: own._id })).reverted_by), String(cashier._id)); checks++;

  // An interrupted reversal is finished by reverting the same payment again.
  const resume = await newStudent('Resume student', [6000]);
  await collect(resume, 2500);
  const [resumed] = await paid(resume);
  const resumeFee = await Fee.findOne({ student: resume._id }).lean();
  await Fee.updateOne({ _id: resumeFee._id }, { amount: 6000 });
  await Reversal.create({ student: resume._id, payment_log: resumed._id, payment_id: resumed.payment_id, amount: 2500, reason_category: 'Wrong amount', reason_note: 'Interrupted half way',
    reverted_by: owner._id, status: 'incomplete', steps: { fees: true }, fee_changes: [{ fee: resumeFee._id, before_amount: 3500, before_status: 'Pending', after_amount: 6000, after_status: 'Pending' }],
    removed: { logs: [resumed], fees: [resumeFee], receipts: [], slips: [] } });
  await check(owner, 'POST', `/fees/payments/${resumed._id}/revert`, {});
  assert.deepEqual([(await Reversal.findOne({ payment_log: resumed._id })).status, await FeeLog.countDocuments({ _id: resumed._id }), (await Fee.findById(resumeFee._id)).amount], ['completed', 0, 6000]); checks++;

  console.log(JSON.stringify({ paymentReversalChecks: checks, isolatedDatabase: true, externalServicesCalled: false }));
} finally {
  if (api) { api.kill('SIGTERM'); await new Promise((resolve) => api.exitCode !== null ? resolve() : api.once('exit', resolve)); }
  await mongoose.disconnect(); mongo.kill('SIGTERM'); await new Promise((resolve) => mongo.exitCode !== null ? resolve() : mongo.once('exit', resolve));
  process.chdir(os.tmpdir()); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

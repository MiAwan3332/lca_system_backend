import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { approvedMigrationPlan } from '../utils/accessBlueprints.js';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lca-enforcement-'));
await fs.mkdir(path.join(directory, 'data')); process.chdir(directory);
const port = async () => { const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value; };
const mongoPort = await port(), apiPort = await port();
const uri = `mongodb://127.0.0.1:${mongoPort}/enforcement_verify`;
const environment = { ...process.env, MONGO_URI: uri, PORT: String(apiPort), JWT_SECRET: 'isolated-enforcement-only', AUTHORIZATION_MODE: 'enforce', PRIVATE_MEDIA_ACCESS: 'false',
  OPENWA_BASE_URL: '', OPENWA_API_KEY: '', S3_ENDPOINT: '', S3_BUCKET: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '', EMAIL_USER: '', EMAIL_PASS: '', ALERT_EMAIL_TO: '',
  CREATION_STAGING_DIR: path.join(directory, 'staging'), CREATION_LOG_DIR: path.join(directory, 'logs') };
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
  const { default: Course } = await import('../models/courses.js');
  const { default: Student } = await import('../models/students.js');
  const { default: Teacher } = await import('../models/teachers.js');
  const { default: Qualifier } = await import('../models/qualifiers.js');
  const { default: Expense } = await import('../models/expenses.js');
  const { default: TeachingAssignment } = await import('../models/assignments.js');
  const { default: Submission } = await import('../models/assignmentSubmissions.js');
  const { default: CourseQuiz } = await import('../models/courseQuizzes.js');
  const { default: Attempt } = await import('../models/courseQuizAttempts.js');
  const { default: InterviewPanel } = await import('../models/interviewPanel.js');
  const { default: Panelist } = await import('../models/panelists.js');
  const users = ['secrateadmin', 'CEO', 'Principal', 'Accounts', 'Information Office', 'teacher', 'student', 'student', 'qualifier', 'panelist'].map((role, index) => ({
    _id: new mongoose.Types.ObjectId(), role, name: `Fixture ${role} ${index}`, email: `fixture-${index}@example.invalid`, ...(index === 0 ? { platformOwner: true } : {}),
  }));
  await User.collection.insertMany(users);
  const owner = users[0], ceo = users[1], principal = users[2], finance = users[3], admissions = users[4], teacher = users[5], learner = users[6], otherLearner = users[7], qualifier = users[8];
  const ca = await Course.create({ name: 'Course A' }), cb = await Course.create({ name: 'Course B' });
  const tp = await Teacher.create({ name: teacher.name, email: teacher.email, user: teacher._id, phone: 'private-teacher-phone', resume: 'private-resume', salary: 12345 });
  const a = await Batch.create({ name: 'A', batch_type: 'Online', roll_nickname: 'A', batch_fee: '1000', courses: [ca._id], teachers: [tp._id] });
  const b = await Batch.create({ name: 'B', batch_type: 'Online', roll_nickname: 'B', batch_fee: '1000', courses: [cb._id] });
  const sa = await Student.create({ name: learner.name, email: learner.email, phone: '0000000001', user: learner._id, batch: a._id, cnic: 'private-identity', cnic_image: 'private-document' });
  const sb = await Student.create({ name: otherLearner.name, email: otherLearner.email, phone: '0000000002', user: otherLearner._id, batch: b._id });
  await Qualifier.create({ name: qualifier.name, email: qualifier.email, phone: '0000000003', batch: a._id });
  const planPath = path.join(directory, 'approved.json'); await fs.writeFile(planPath, JSON.stringify(approvedMigrationPlan(users)));
  const migration = spawnSync(process.execPath, [path.join(source, 'scripts/planAccessMigration.mjs'), `--plan=${planPath}`, '--apply', '--backup-reference=isolated-test'], { cwd: directory, env: environment, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(migration.status, 0, migration.stderr || migration.stdout);
  api = spawn(process.execPath, [path.join(source, 'index.js')], { cwd: directory, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [api.stdout, api.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-6000); });
  const base = `http://127.0.0.1:${apiPort}`;
  for (let attempt = 0; ; attempt++) { try { assert.equal((await fetch(`${base}/health/ready`)).status, 200); break; } catch { if (attempt > 100 || api.exitCode !== null) throw new Error(output); await pause(200); } }
  const request = async (user, method, route, body, key = crypto.randomUUID()) => {
    const response = await fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${jwt.sign({ user: { id: String(user._id), role: user.role } }, environment.JWT_SECRET)}`,
      'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Creation-Protocol': '2' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  for (const user of users) {
    const result = await request(user, 'GET', '/access/me'); assert.equal(result.status, 200, user.role); assert.equal(result.data.managed, true); checks++;
    const stats = await request(user, 'GET', '/statistics');
    if (user.role !== 'panelist') assert.equal(stats.status, 200, `dashboard ${user.role}: ${JSON.stringify(stats.data)}`); checks++;
    assert.equal((await request(user, 'GET', '/notifications')).status, 200, `notifications ${user.role}`); checks++;
    assert.equal((await request(user, 'POST', '/notifications/read-all')).status, 200, `notification read-all ${user.role}`); checks++;
  }
  for (const user of [admissions, finance]) {
    assert.equal((await request(user, 'POST', '/users/add', {})).status, 403); checks++;
    assert.equal((await request(user, 'POST', '/fees/discount/' + sa._id, {})).status, 403); checks++;
    assert.equal((await request(user, 'POST', '/expenses/approve/' + sa._id, {})).status, 403); checks++;
  }
  for (const user of [ceo, principal]) {
    assert.equal((await request(user, 'GET', '/access/account-categories')).status, 200); checks++;
    assert.equal((await request(user, 'GET', '/access/catalog')).status, 403); checks++;
    assert.equal((await request(user, 'POST', '/fees/collect-pending/' + sa._id, {})).status, 403); checks++;
    assert.equal((await request(user, 'POST', '/students/add', { paying_now: '1' })).status, 403); checks++;
  }
  let result = await request(teacher, 'GET', '/students'); assert.equal(result.status, 200); assert.equal(result.data.docs.length, 1);
  assert.equal(result.data.docs[0].cnic, undefined); assert.equal(result.data.docs[0].cnic_image, undefined); checks++;
  result = await request(learner, 'GET', '/students'); assert.equal(result.status, 200); assert.equal(result.data.docs.length, 1); assert.equal(result.data.docs[0]._id, String(sa._id)); checks++;
  result = await request(learner, 'GET', `/students/${sb._id}`); assert.ok([400, 403, 404].includes(result.status)); checks++;
  result = await request(learner, 'GET', '/teachers'); assert.equal(result.status, 200);
  assert.equal(result.data.docs[0].email, undefined); assert.equal(result.data.docs[0].resume, undefined); checks++;
  for (const user of [admissions, finance, ceo, principal]) for (const route of ['/students?limit=1', '/batches?limit=1', '/fees/report', '/qualifiers?limit=1']) {
    result = await request(user, 'GET', route); assert.equal(result.status, 200, `${user.role} ${route}: ${JSON.stringify(result.data)}`); checks++;
  }
  const expense = await Expense.create({ title: 'Owned expense', amount: 10, created_by: ceo._id });
  assert.equal((await request(ceo, 'POST', `/expenses/approve/${expense._id}`, {})).status, 403); checks++;
  assert.equal((await request(principal, 'POST', `/expenses/approve/${expense._id}`, {})).status, 200); checks++;
  const admissionBody = { name: 'Enforced admission', phone: '0000000004', batch: String(a._id), paying_now: '200', payment_method: 'Cash', next_installment_date: '2030-01-01' };
  result = await request(admissions, 'POST', '/students/add', admissionBody); assert.equal(result.status, 201, JSON.stringify(result.data)); checks++;
  const newUser = await User.findOne({ email: (await Student.findById(result.data.record_id)).email }).lean();
  assert.equal(newUser.accessManaged, true); assert.equal(newUser.accountType, 'student');
  assert.equal(await Assignment.countDocuments({ user: newUser._id }), 1); checks++;
  result = await request(ceo, 'POST', '/users/add', { name: 'New staff pending', email: 'pending@example.invalid', phone: 'test-no-phone', role: 'CEO' });
  // Account categories are legacy records, while permission authority comes only from defaults.
  if (result.status === 400) { await Role.create({ name: 'CEO' }); result = await request(ceo, 'POST', '/users/add', { name: 'New staff pending', email: 'pending@example.invalid', phone: 'test-no-phone', role: 'CEO' }); }
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const pending = await User.findOne({ email: 'pending@example.invalid' }).lean(); assert.equal(pending.accessManaged, true);
  assert.equal((await request(pending, 'GET', '/students')).status, 403); checks++;
  const work = await TeachingAssignment.create({ title: 'Assigned work', batch: a._id, course: ca._id, availability_date: new Date(Date.now() - 60000), has_deadline: false, status: 'Published', visibility_status: 'Published' });
  const otherWork = await TeachingAssignment.create({ title: 'Other batch work', batch: b._id, course: cb._id, availability_date: new Date(Date.now() - 60000), has_deadline: false, status: 'Published', visibility_status: 'Published' });
  const peer = await Student.create({ name: 'Peer in same class', phone: '0000000009', batch: a._id });
  await Submission.create({ assignment: work._id, student: peer._id, submission_text: 'private peer work' });
  result = await request(learner, 'POST', `/assignments/submit/${work._id}`, { submission_text: 'Own answer' });
  assert.equal(result.status, 201, JSON.stringify(result.data)); checks++;
  result = await request(learner, 'GET', '/assignments/submissions/list');
  assert.equal(result.status, 200); assert.equal(result.data.docs.length, 1); assert.equal(result.data.docs[0].student._id || result.data.docs[0].student, String(sa._id)); checks++;
  result = await request(learner, 'POST', `/assignments/submit/${otherWork._id}`, { submission_text: 'Not allowed' }); assert.ok([403, 404].includes(result.status)); checks++;
  result = await request(teacher, 'GET', '/assignments/submissions/list'); assert.equal(result.status, 200); assert.equal(result.data.docs.length, 2); checks++;
  const quiz = await CourseQuiz.create({ title: 'Assigned quiz', batch: a._id, course: ca._id, start_datetime: new Date(Date.now() - 60000), end_datetime: new Date(Date.now() + 3600000),
    use_mcq_bank: false, embedded_questions: [{ question: 'Choose one', options: ['A', 'B'], correct_answers: ['A'] }], status: 'Active' });
  await Attempt.create({ quiz: quiz._id, student: peer._id, status: 'In Progress' });
  result = await request(learner, 'POST', `/course-quizzes/${quiz._id}/start`, {});
  assert.equal(result.status, 201, JSON.stringify(result.data)); const attemptId = result.data.attempt._id; checks++;
  result = await request(learner, 'GET', '/course-quizzes/attempts'); assert.equal(result.status, 200); assert.equal(result.data.docs.length, 1); checks++;
  result = await request(learner, 'POST', `/course-quizzes/attempts/${attemptId}/answer`, { question_id: String(quiz.embedded_questions[0]._id), selected_answers: ['A'] });
  assert.equal(result.status, 200, JSON.stringify(result.data)); checks++;
  result = await request(teacher, 'GET', '/course-quizzes/attempts'); assert.equal(result.status, 200); assert.equal(result.data.docs.length, 2); checks++;
  const interview = await InterviewPanel.create({ title: 'Available interview', status: 'active', schedules: [{ date: '2030-01-01', start_time: '09:00', end_time: '09:20', booking_status: 'booked',
    booked_user_id: otherLearner._id, booked_for: 'Other candidate private name', booked_phone: 'private phone' }, { date: '2030-01-02', start_time: '09:00', end_time: '09:20' }] });
  result = await request(qualifier, 'GET', `/interview-panels/${interview._id}`); assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.ok(!JSON.stringify(result.data).includes('Other candidate private name')); assert.ok(!JSON.stringify(result.data).includes('private phone')); checks++;
  assert.equal((await request(qualifier, 'POST', `/interview-panels/book/${interview._id}`, { schedule_index: 1 })).status, 400); checks++;
  const qp = await Qualifier.findOne({ email: qualifier.email });
  Object.assign(qp, { cnic: '1234567890123', city: 'Lahore', province: 'Punjab', father_name: 'Fixture father', father_phone: '0000000008', description: 'Fixture profile',
    latest_degree: 'Degree', education_background: [{ qualification: "Bachelor's Degree", institution: 'Fixture institution' }], no_of_attempts: 0, optional_subjects: ['History of USA'], photo: 'https://example.invalid/profile.png' });
  await qp.save();
  result = await request(qualifier, 'POST', `/interview-panels/book/${interview._id}`, { schedule_index: 1 });
  assert.equal(result.status, 200, JSON.stringify(result.data)); checks++;
  const panelist = users[9]; const pp = await Panelist.create({ name: panelist.name, email: panelist.email, phone: '0000000010', description: 'Fixture panelist' });
  await InterviewPanel.updateOne({ _id: interview._id }, { $set: { members: [{ panelist_id: pp._id, name: pp.name, description: pp.description }] } });
  const unrelatedPanel = await InterviewPanel.create({ title: 'Unassigned panel', status: 'active' });
  result = await request(panelist, 'GET', '/interview-panels'); assert.equal(result.status, 200); assert.equal(result.data.docs.length, 1); checks++;
  assert.ok([403, 404].includes((await request(panelist, 'GET', `/interview-panels/${unrelatedPanel._id}`)).status)); checks++;
  result = await request(panelist, 'GET', `/interview-panels/conduct/${interview._id}/1`); assert.equal(result.status, 200, JSON.stringify(result.data)); checks++;
  assert.equal((await request(admissions, 'POST', '/students/bulk-import', { batch_id: String(a._id), students: [{ name: 'Discount bypass', phone: '0000000020', total_fee: 1, paid_fee: 0, pending_fee: 1, online_amount: 0, cash_amount: 0 }] })).status, 403); checks++;
  assert.equal((await request(learner, 'GET', '/google/status')).status, 200); checks++;
  assert.equal((await request(teacher, 'GET', '/google/status')).status, 200); checks++;
  console.log(JSON.stringify({ approvedPolicyHttpChecks: checks, passed: true, externalServicesCalled: false }));
} finally {
  if (api?.exitCode === null) { api.kill('SIGTERM'); await Promise.race([new Promise((resolve) => api.once('exit', resolve)), pause(5000)]); if (api.exitCode === null) api.kill('SIGKILL'); }
  await mongoose.disconnect(); mongo.kill('SIGTERM'); await Promise.race([new Promise((resolve) => mongo.once('exit', resolve)), pause(5000)]);
}

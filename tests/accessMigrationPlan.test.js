import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMigrationPlan, validateMigrationPlan } from '../utils/accessMigrationPlan.js';
import { resolveLegacyLoginRole, loginRoleIdentity } from '../utils/legacyLoginRole.js';
import Role from '../models/roles.js';

const catalog = { routes: [{ handler: 'getStudents', permission: 'students.get.students' }], permissions:
  ['students.get.students', 'fields.general.read', 'users.get.user', 'users.change.password'].map((key) => ({ key })) };
const prepared = () => {
  const data = { roles: [{ _id: 'r1', name: 'Teacher', permissions: [] }, { _id: 'r2', name: 'CEO', permissions: ['p1'] }],
    permissions: [{ _id: 'p1', name: 'Get_Students' }], users: [{ _id: 'u1', role: 'teacher' }, { _id: 'u2', role: 'CEO' }] };
  const plan = buildMigrationPlan(data, catalog); plan.ownerUserIds = ['u2']; return { data, plan };
};
test('teacher casing maps explicitly; plans do not approve or activate themselves', () => {
  const { data, plan } = prepared();
  assert.equal(plan.roles[0].targets[0].userId, 'u1');
  assert.equal(plan.roles[0].targets[0].accountType, 'teacher');
  assert.equal(plan.reviewed, false); assert.equal(plan.activateUsers, false);
  assert.equal(validateMigrationPlan(plan, data.users, catalog).uncoveredUserIds.length, 0);
});
test('staging needs review and owner; changed roles and catalog are rejected', () => {
  const { data, plan } = prepared();
  assert.match(validateMigrationPlan(plan, data.users, catalog, { applying: true }).errors.join(), /reviewed/);
  plan.reviewed = true;
  assert.equal(validateMigrationPlan(plan, data.users, catalog, { applying: true }).errors.length, 0);
  assert.match(validateMigrationPlan(plan, [{ ...data.users[0], role: 'CEO' }, data.users[1]], catalog).errors.join(), /role changed/);
  assert.match(validateMigrationPlan(plan, data.users, { ...catalog, version: 2 }).errors.join(), /catalog changed/);
  plan.ownerUserIds = ['u1'];
  assert.match(validateMigrationPlan(plan, data.users, catalog).errors.join(), /non-staff owner/);
});
test('missing policies and defaults block activation', () => {
  const { data, plan } = prepared(); plan.activateUsers = true;
  const report = validateMigrationPlan(plan, data.users, catalog);
  assert.equal(report.readyToApply, false);
  for (const expected of [/separate approval/, /policy\/coverage/, /default: teacher/, /baseline/]) assert.match(report.errors.join(), expected);
});
test('reviewed policy with defaults passes activation preflight', () => {
  const { data, plan } = prepared();
  Object.assign(plan, { reviewed: true, activationReviewed: true, activateUsers: true,
    defaults: { teacher: plan.roles[0].code, staff: plan.roles[1].code } });
  for (const role of plan.roles) { role.policyReviewed = true; role.unmapped = [];
    role.grants = catalog.permissions.map(({ key }) => ({ permission: key, scope: 'all' })); }
  assert.deepEqual(validateMigrationPlan(plan, data.users, catalog, { applying: true }).errors, []);
});
test('legacy login repairs teacher casing without approximating privileged staff names', async () => {
  const original = Role.findOne, calls = [];
  Role.findOne = async (query) => { calls.push(query.name); return query.name === 'Teacher' ? { name: 'Teacher' } : null; };
  try {
    assert.equal((await resolveLegacyLoginRole('teacher')).name, 'Teacher');
    assert.deepEqual(calls, ['teacher', 'Teacher']); calls.length = 0;
    assert.equal(await resolveLegacyLoginRole('ceo'), null); assert.deepEqual(calls, ['ceo']);
  } finally { Role.findOne = original; }
});
test('renamed permission roles never change the login account category', () => {
  assert.equal(loginRoleIdentity({ role: 'teacher' }, { name: 'Teacher' }).name, 'teacher');
  assert.equal(loginRoleIdentity({ role: 'student', accountType: 'student' }, { name: 'Custom learner' }).name, 'student');
  assert.equal(loginRoleIdentity({ role: 'CEO', accountType: 'staff' }, { name: 'Operations manager' }).name, 'CEO');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedBlueprints, approvedMigrationPlan } from '../utils/accessBlueprints.js';
import { validateMigrationPlan } from '../utils/accessMigrationPlan.js';
import { accessCatalog, permissionKeys } from '../utils/accessCatalog.js';
import { validateGrants } from '../utils/accessPolicy.js';
const byCode = new Map(approvedBlueprints().map((role) => [role.code, role]));
const has = (code, permission) => byCode.get(`lca-v1-${code}`).grants.some((grant) => grant.permission === permission);
test('every approved grant is finite, classified and valid', () => {
  for (const role of byCode.values()) validateGrants(role.grants, permissionKeys);
});
test('staff management is explicit; routine accounting and approval are separated', () => {
  for (const role of ['executive', 'principal']) {
    assert.equal(has(role, 'users.add.user'), true); assert.equal(has(role, 'fees.pay.fee'), false);
    assert.equal(has(role, 'access.manage'), false);
    for (const grant of byCode.get(`lca-v1-${role}`).grants.filter((item) => /approve\.(expense|refund.request)$/.test(item.permission))) assert.equal(grant.noSelfApproval, true);
  }
  for (const role of ['finance', 'admissions']) {
    assert.equal(has(role, 'fees.pay.fee'), true); assert.equal(has(role, 'users.add.user'), false);
    assert.equal(has(role, 'fees.discount.fee'), false); assert.equal(has(role, 'refund-requests.approve.refund.request'), false);
    const write = byCode.get(`lca-v1-${role}`).grants.find((grant) => grant.permission === 'fields.financial.write');
    assert.ok(!write.fields.includes('discount_amount'));
  }
});
test('learner and teaching operations never use all-record scope', () => {
  for (const code of ['teacher', 'student', 'qualifier', 'panelist', 'pending-staff']) {
    for (const grant of byCode.get(`lca-v1-${code}`).grants) {
      const route = accessCatalog.routes.find((item) => item.permission === grant.permission);
      if (route) assert.notEqual(grant.scope, 'all', `${code}: ${grant.permission}`);
    }
  }
});
test('approved plan covers exact groups and all future account defaults', () => {
  const users = [{ _id: 'owner', role: 'secrateadmin', platformOwner: true }, ...['CEO', 'Principal', 'Vice-Principal', 'Accounts', 'Information Office', 'teacher', 'student', 'qualifier'].map((role, index) => ({ _id: String(index), role }))];
  const plan = approvedMigrationPlan(users);
  assert.equal(validateMigrationPlan(plan, users, accessCatalog, { applying: true }).readyToActivate, true);
  assert.equal(plan.defaults.staff, 'lca-v1-pending-staff');
});

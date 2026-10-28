import test from 'node:test';
import assert from 'node:assert/strict';
import { accessCatalog, canAccessField, FIELD_GROUPS } from '../utils/accessCatalog.js';
import { completeWorkflowAccess, workflowGaps } from '../utils/accessWorkflowRules.js';
import { staffRoleProfiles } from '../utils/staffRoleProfiles.js';
const group = key => Object.entries(FIELD_GROUPS).find(([, fields]) => fields.has(key))?.[0] || 'general';
const officer = () => {
  const role = staffRoleProfiles().find(r => r.code === 'lca-staff-account-officer');
  const grants = [...role.grants];
  for (const p of accessCatalog.permissions.filter(p => ['students', 'batches'].includes(p.group))) if (!grants.some(g => g.permission === p.key)) grants.push({ permission: p.key, scope: 'all' });
  return grants;
};
test('all four default staff profiles have complete supported workflows', () => {
  for (const role of staffRoleProfiles()) assert.deepEqual(workflowGaps(role.grants, accessCatalog), [], role.name);
});
test('complete student/batch workflows add precise fields without ledger edits or new approvals', () => {
  const original = officer(), saved = JSON.stringify(original);
  assert.ok(workflowGaps(original, accessCatalog).some(r => r.id === 'student-admission'));
  const next = completeWorkflowAccess(original, accessCatalog), context = { grants: next };
  for (const field of ['batch', 'paying_now', 'reuse_existing', 'special_selected_options', 'is_active', 'roll_nickname', 'batch_fee', 'batchId', 'courseIds', 'assignments', 'students']) assert.ok(canAccessField(context, group(field), field, 'write'), field);
  for (const field of ['paid_fee', 'pending_fee', 'total_fee', 'discount_amount']) assert.equal(canAccessField(context, group(field), field, 'write'), false, field);
  for (const p of ['expenses.approve.expense', 'refund-requests.approve.refund.request', 'fees.discount.fee', 'teachers.get.teachers']) assert.equal(next.some(g => g.permission === p), original.some(g => g.permission === p));
  assert.deepEqual(workflowGaps(next, accessCatalog), []);
  assert.equal(JSON.stringify(original), saved);
  assert.deepEqual(completeWorkflowAccess(next, accessCatalog), next);
});
test('lookup dependencies retain selected scope and existing financial limits', () => {
  const grants = [{ permission: 'batches.assign.teacher.courses.to.batch', scope: 'selected', maxAmount: 100, noSelfApproval: true }, { permission: 'fields.general.write', scope: 'all', fields: ['name'] }];
  const next = completeWorkflowAccess(grants, accessCatalog);
  assert.deepEqual(next[0], grants[0]);
  assert.ok(next.some(g => g.permission === 'batches.get.batch.assignment.options' && g.scope === 'selected'));
  assert.ok(!next.some(g => g.permission === 'batches.get.batch.assignment.options' && g.scope === 'all'));
});

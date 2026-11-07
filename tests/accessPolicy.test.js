import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveGrants, evaluateAccess, validateGrants, legacyAccountType } from '../utils/accessPolicy.js';
import { classifyAccessRoute, redactAccessFields, permissionKeys, accessCatalog } from '../utils/accessCatalog.js';
const context = (grants = []) => ({ userId: 'u1', owner: false, disabled: false, grants, assignedBatchIds: ['a'], assignedCourseIds: ['x'] });
test('unknown access and missing contexts are denied', () => {
  assert.equal(evaluateAccess(null, 'students.read').allowed, false);
  assert.equal(evaluateAccess(context(), 'students.read').allowed, false);
  assert.equal(evaluateAccess({ ...context(), owner: true, disabled: true }, 'anything').allowed, false);
});
test('individual grant scopes never form a batch/course cross product', () => {
  const grants = [{ permission: 'read', scope: 'selected', batchIds: ['a'], courseIds: ['x'] },
    { permission: 'read', scope: 'selected', batchIds: ['b'], courseIds: ['y'] }];
  assert.equal(evaluateAccess(context(grants), 'read', { batchId: 'a', courseId: 'x' }).allowed, true);
  assert.equal(evaluateAccess(context(grants), 'read', { batchId: 'a', courseId: 'y' }).allowed, false);
  assert.equal(evaluateAccess(context(grants), 'write', { batchId: 'a' }).allowed, false);
});
test('own, assigned, approval amount and self-approval are evaluated', () => {
  assert.equal(evaluateAccess(context([{ permission: 'read', scope: 'own' }]), 'read', { ownerId: 'u1' }).allowed, true);
  assert.equal(evaluateAccess(context([{ permission: 'read', scope: 'own' }]), 'read', { ownerId: 'u2' }).allowed, false);
  assert.equal(evaluateAccess(context([{ permission: 'read', scope: 'assigned' }]), 'read', { batchId: 'b' }).allowed, false);
  const approval = context([{ permission: 'approve', scope: 'all', maxAmount: 100, noSelfApproval: true }]);
  assert.equal(evaluateAccess(approval, 'approve', { amount: 101, createdBy: 'u2' }).allowed, false);
  assert.equal(evaluateAccess(approval, 'approve', { amount: 100, createdBy: 'u1' }).allowed, false);
  assert.equal(evaluateAccess(approval, 'approve', { amount: 100, createdBy: 'u2' }).allowed, true);
});

test('assigned courses preserve the teacher batch/course relationship', () => {
  const actor = { ...context([{ permission: 'read', scope: 'assigned' }]), assignedBatchIds: ['a', 'b'], assignedCourseIds: ['x', 'y'],
    assignedPairs: [{ batchId: 'a', courseId: 'x' }, { batchId: 'b', courseId: 'y' }] };
  assert.equal(evaluateAccess(actor, 'read', { batchId: 'a', courseId: 'y' }).allowed, false);
  assert.equal(evaluateAccess(actor, 'read', { batchId: 'b', courseId: 'y' }).allowed, true);
});
test('expired, revoked and inactive assignments never grant access', () => {
  const roles = [{ _id: 'r', active: true, grants: [{ permission: 'read', scope: 'selected' }] }];
  assert.equal(effectiveGrants([{ _id: 'a', role: 'r', expiresAt: new Date(0) }], roles).length, 0);
  assert.equal(effectiveGrants([{ _id: 'a', role: 'r', revokedAt: new Date() }], roles).length, 0);
  assert.equal(effectiveGrants([{ _id: 'a', role: 'r' }], [{ ...roles[0], active: false }]).length, 0);
  assert.deepEqual(effectiveGrants([{ _id: 'a', role: 'r', batchIds: ['b'] }], roles)[0].batchIds, ['b']);
});
test('catalog rejects invented permissions, arbitrary scopes and invalid limits', () => {
  assert.throws(() => validateGrants([{ permission: 'made-up', scope: 'all' }], permissionKeys));
  assert.throws(() => validateGrants([{ permission: 'access.read', scope: '$where' }], permissionKeys));
  assert.throws(() => validateGrants([{ permission: 'access.read', scope: 'all', maxAmount: -1 }], permissionKeys));
  assert.throws(() => validateGrants([{ permission: 'fields.contact.read', scope: 'own' }], permissionKeys));
  assert.equal(legacyAccountType('Read-only Auditor'), 'staff');
});
test('nested sensitive data and all credentials are removed independently of visible buttons', () => {
  const source = { docs: [{ name: 'Student', password: 'hash', email: 'private', cnic: 'private', pending_fee: 100,
    payment_evidence: ['https://example.invalid/file'], remarks: 'internal', user: { access_token: 'secret', name: 'Staff' } }] };
  const result = redactAccessFields(source, context([{ permission: 'fields.general.read', scope: 'all', fields: ['name', 'user'] }]));
  assert.equal(result.docs[0].name, 'Student');
  for (const key of ['password', 'email', 'cnic', 'pending_fee', 'payment_evidence', 'remarks']) assert.equal(result.docs[0][key], undefined);
  assert.equal(result.docs[0].user.access_token, undefined);
  const owner = redactAccessFields(source, { ...context(), owner: true });
  assert.equal(owner.docs[0].pending_fee, 100); assert.equal(owner.docs[0].password, undefined);
});
test('all protected route classifications map to actual catalog permissions', () => {
  assert.equal(classifyAccessRoute('POST', '/users/register').blocked, true);
  assert.equal(classifyAccessRoute('GET', '/new-unclassified-api'), undefined);
  for (const route of accessCatalog.routes.filter((item) => !item.public && !item.blocked)) assert.ok(permissionKeys.has(route.permission), route.path);
  assert.ok(classifyAccessRoute('POST', '/students/abc/payment-evidence/def').permission.includes('edit.payment.evidence'));
});

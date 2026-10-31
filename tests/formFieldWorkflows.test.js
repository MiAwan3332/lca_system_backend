import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workflowGaps, completeWorkflowAccess } from '../utils/accessWorkflowRules.js';
const catalog = JSON.parse(fs.readFileSync(new URL('../config/accessCatalog.generated.json', import.meta.url), 'utf8'));
const rule = (permission) => catalog.workflows.find((item) => item.id === `fields:${permission}`);

test('every form action lists the fields its handler reads', () => {
  for (const key of ['exam_type', 'css_pms_roll_no', 'class_type', 'province', 'city', 'father_name', 'latest_degree', 'no_of_attempts']) {
    assert.ok(rule('qualifiers.update.qualifier').write.includes(key), key);
    assert.ok(rule('qualifiers.add.qualifier').write.includes(key), key);
  }
  // Allowed-field lists copied with Object.hasOwn(req.body, key) are included.
  assert.ok(rule('students.update.student').write.includes('father_name'));
  assert.ok(rule('timetable.update.time.table').write.includes('teacher'));
  assert.ok(catalog.workflows.find(item=>item.id==='interview-booking').write.includes('schedule_id'));
});

test('fields controlled by another permission are never pulled in by a form action', () => {
  const forms = catalog.workflows.filter((item) => item.id.startsWith('fields:'));
  for (const form of forms) for (const key of ['paid_fee', 'pending_fee', 'total_fee', 'cash_amount', 'online_amount', 'discount_amount', 'discount_description', 'role']) assert.ok(!form.write.includes(key), `${form.id} ${key}`);
  for (const form of forms) if (!/password/.test(form.id)) assert.ok(!form.write.some((key) => catalog.fieldGroups.credentials.includes(key)), form.id);
  assert.ok(!rule('students.update.student').write.includes('batch'));
  assert.ok(!rule('qualifiers.update.qualifier').write.includes('is_active'));
  for (const key of ['paying_now', 'payment_method']) assert.ok(!rule('qualifiers.add.qualifier').write.includes(key));
  assert.equal(rule('users.update.user'), undefined);
});

test('feedback is a general field, not a financial one', () => {
  assert.ok(catalog.fieldGroups.general.includes('feedback'));
  assert.ok(!catalog.fieldGroups.financial.includes('feedback'));
});

test('completing a limited role adds only the missing qualifier field names', () => {
  const grants = [{ permission: 'qualifiers.update.qualifier', scope: 'all' }, { permission: 'fields.general.write', scope: 'all', fields: ['name'] }];
  const formOnly = { ...catalog, workflows: [rule('qualifiers.update.qualifier')] };
  const next = completeWorkflowAccess(grants, formOnly);
  assert.deepEqual(workflowGaps(next, formOnly), []);
  assert.ok(next.find((grant) => grant.permission === 'fields.general.write').fields.includes('no_of_attempts'));
  assert.equal(next.filter((grant) => !grant.permission.startsWith('fields.')).length, 1);
});

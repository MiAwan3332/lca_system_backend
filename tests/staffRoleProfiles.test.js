import test from 'node:test';
import assert from 'node:assert/strict';
import { staffRoleProfiles, STAFF_ROLE_CODES, staffCommunication } from '../utils/staffRoleProfiles.js';
import { validateGrants } from '../utils/accessPolicy.js';
import { permissionKeys } from '../utils/accessCatalog.js';
import { enforceStaffMessage, enforceStaffMutation, staffQueryFilters } from '../utils/staffRoleGuards.js';
const profiles=staffRoleProfiles();
const profile=(key)=>profiles.find(r=>r.code===STAFF_ROLE_CODES[key]);
const has=(key,permission)=>profile(key).grants.some(g=>g.permission===permission);
const context=(key)=>({owner:false,roles:[{code:STAFF_ROLE_CODES[key]}],grants:profile(key).grants});

test('all four approved staff roles use explicit known permissions and system-wide business scope',()=>{
 assert.equal(profiles.length,4);
 for(const role of profiles){assert.equal(validateGrants(role.grants,permissionKeys).length,role.grants.length);for(const g of role.grants){assert.ok(['all','own'].includes(g.scope));if(g.scope==='own')assert.ok(/^(users|notifications|expenses|complaints)\./.test(g.permission));}}
});
test('owner retains approvals, discounts, deletion and permission administration',()=>{
 for(const role of profiles)for(const g of role.grants){assert.ok(!['students.delete.student','students.delete.all.students','batches.delete.batch','fees.delete.fee','fees.discount.fee','expenses.approve.expense','expenses.reject.expense','refund-requests.approve.refund.request','refund-requests.reject.refund.request','access.assign','access.manage','users.add.user','users.delete.user','users.reset.password.for.all.students'].includes(g.permission));}
});
test('accounts can collect, print and report while other roles cannot collect money',()=>{
 for(const p of ['fees.pay.fee','fees.collect.pending.fee','fees.get.finance.report','students.print','fees.print','refund-requests.process.refund.request','expenses.add.expense'])assert.ok(has('accounts',p),p);
 for(const key of ['principle','vice','desk'])assert.equal(has(key,'fees.pay.fee'),false);
 assert.equal(has('desk','students.export'),false);
});
test('all roles have usable own-account access without granting staff-account mutation',()=>{
 for(const role of profiles){for(const permission of ['users.get.user','users.update.user','users.change.avatar','users.change.password'])assert.deepEqual(role.grants.filter(g=>g.permission===permission).map(g=>g.scope),['own']);assert.ok(role.grants.some(g=>g.permission==='fields.general.read'));assert.ok(role.grants.some(g=>g.permission==='fields.contact.read'));}
});
test('inline discounts and message-process escalation are rejected before work is queued',async()=>{
 for(const key of ['principle','vice','accounts','desk'])await assert.rejects(enforceStaffMutation(context(key),{resource:'fees',handler:'collectPendingFee'},{discount_amount:1}),{status:403});
 assert.throws(()=>enforceStaffMessage(context('accounts'),{template_key:'fee',body:'custom'},'custom'),{status:403});
 assert.throws(()=>enforceStaffMessage(context('desk'),{template_key:'admission'},'fee_payment'),{status:403});
 assert.doesNotThrow(()=>enforceStaffMessage(context('accounts'),{template_key:'fee',audience:'pending_dues_students'},'fee_reminder'));
 assert.doesNotThrow(()=>enforceStaffMessage(context('desk'),{template_key:'admission',audience:'students'},'student_admission'));
 assert.equal(staffCommunication(context('accounts')).savedTemplatesOnly,true);
 assert.deepEqual(staffQueryFilters(context('desk'),{resource:'whatsapp'}).WhatsAppTemplate.process.$in,['student_admission','qualifier_welcome']);
});

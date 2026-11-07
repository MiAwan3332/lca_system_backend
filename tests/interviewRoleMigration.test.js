import test from 'node:test';import assert from 'node:assert/strict';
import {interviewRolePlan} from '../scripts/migrateInterviewWorkflow.mjs';
test('interview migration adds scheduling capabilities without changing financial decisions',()=>{
 const protectedGrant={permission:'expenses.approve.expense',scope:'selected',maxAmount:123,noSelfApproval:true};
 const before={code:'custom-coordinator',grants:[protectedGrant,{permission:'interview-panels.update.interview.panel',scope:'assigned'}]};
 const next=interviewRolePlan(before);
 assert.deepEqual(next.find(g=>g.permission===protectedGrant.permission),protectedGrant);
 assert.ok(next.some(g=>g.permission==='interview-panels.add.interview.schedules'&&g.scope==='assigned'));
 assert.ok(!next.some(g=>g.permission==='panelists.add.panelist'));
 assert.deepEqual(interviewRolePlan({...before,grants:next}),next);
});
test('Principal and Vice Principal get manageable interview workflows, not automatic deletion or shared-password resets',()=>{
 for(const code of ['lca-staff-principle','lca-staff-vice-principle']){
  const grants=interviewRolePlan({code,grants:[]});
  for(const p of ['panelists.add.panelist','panelists.lookup.panelist.identity','interview-panels.add.interview.panel','interview-panels.add.interview.schedules','interview-panels.update.interview.schedules','interview-panels.cancel.interview.schedule'])assert.ok(grants.some(g=>g.permission===p),p);
  assert.ok(!grants.some(g=>/delete|password/.test(g.permission)&&!g.permission.startsWith('fields.')));
 }
 const self=interviewRolePlan({code:'lca-v1-panelist',grants:[{permission:'panelists.update.panelist',scope:'own'}]});
 assert.ok(!self.some(g=>g.permission==='panelists.toggle.panelist.status'));
});

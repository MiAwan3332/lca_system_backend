import mongoose from 'mongoose';
import {pathToFileURL} from 'node:url';
import Role from '../models/roles.js';
import User from '../models/users.js';
import Panelist from '../models/panelists.js';
import Panel from '../models/interviewPanel.js';
import {accessCatalog} from '../utils/accessCatalog.js';
import {completeWorkflowAccess,workflowGaps} from '../utils/accessWorkflowRules.js';
import {staffRoleProfiles} from '../utils/staffRoleProfiles.js';
import {provisionPanelist} from '../utils/panelistProvisioning.js';
import {migrateEvaluationSlotLinks,panelMode} from '../utils/interviewIntegrity.js';

// Explicit deployment migration. Run without --apply to review the additive role plan.
export function interviewRolePlan(role){
 let grants=(role.grants||[]).map(g=>g.toObject?g.toObject():{...g});
 const add=(permission,scope='all')=>{if(!grants.some(g=>g.permission===permission&&(g.scope==='all'||g.scope===scope)))grants.push({permission,scope});};
 if(['lca-staff-principle','lca-staff-vice-principle'].includes(role.code)){
  for(const g of staffRoleProfiles().find(p=>p.code===role.code).grants.filter(g=>/^(panelists|interview-panels)\./.test(g.permission)&&!/delete|password/.test(g.permission)))add(g.permission,g.scope);
 }
 for(const g of [...grants]){
  if(g.permission==='panelists.add.panelist')add('panelists.lookup.panelist.identity',g.scope);
  if(g.permission==='panelists.update.panelist'&&g.scope==='all')add('panelists.toggle.panelist.status',g.scope);
  if(g.permission==='interview-panels.update.interview.panel')for(const p of ['interview-panels.add.interview.schedules','interview-panels.update.interview.schedules','interview-panels.cancel.interview.schedule'])add(p,g.scope);
 }
 const interviewCatalog={...accessCatalog,workflows:accessCatalog.workflows.filter(rule=>rule.any.some(p=>/^(panelists|interview-panels)\./.test(p)))};
 // Include fields for supporting actions added by the first pass, without widening existing scopes/limits.
 for(let i=0;i<4&&workflowGaps(grants,interviewCatalog).length;i++)grants=completeWorkflowAccess(grants,interviewCatalog);
 return grants;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 await mongoose.connect(process.env.MONGO_URI,{autoIndex:false,autoCreate:false});
 try{
  const apply=process.argv.includes('--apply'),changes=[];
  for(const role of await Role.find({managed:true,active:true})){
   const before=role.grants.map(g=>g.toObject()),next=interviewRolePlan(role);
   if(JSON.stringify(before)!==JSON.stringify(next)){changes.push({code:role.code,added:next.filter(g=>!before.some(b=>b.permission===g.permission)).map(g=>g.permission)});if(apply){role.grants=next;await role.save();}}
  }
  let linked=0,initialPasswordRequired=0;
  if(apply){
   const owner=await User.findOne({platformOwner:true});if(!owner)throw Error('An owner account is required');
   for(const profile of await Panelist.find({is_active:true})){
    const result=await provisionPanelist({body:{},access:{userId:String(owner._id)}},{profileId:profile._id,allowGeneratedPassword:true});linked++;if(result.panelist.login_setup_required)initialPasswordRequired++;
   }
   for(const panel of await Panel.find({})){await migrateEvaluationSlotLinks(panel);if(!panel.panel_type){panel.panel_type=panelMode(panel);await panel.save();}}
  }
  console.log(JSON.stringify({applied:apply,roleChanges:changes,linkedPanelists:linked,initialPasswordRequired}));
 }finally{await mongoose.disconnect();}
}

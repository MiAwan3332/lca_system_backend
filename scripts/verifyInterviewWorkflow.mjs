import assert from 'node:assert/strict';
import {DEFAULT_STAFF_PASSWORD} from '../utils/creationDefaults.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lca-access-verify-'));
await fs.mkdir(path.join(directory, 'data'));
process.chdir(directory);
const port = async () => { const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value; };
const mongoPort = await port(), apiPort = await port();
const uri = `mongodb://127.0.0.1:${mongoPort}/access_verify`;
const environment = { ...process.env, MONGO_URI: uri, PORT: String(apiPort), JWT_SECRET: 'isolated-access-only', AUTHORIZATION_MODE: 'enforce',
  PRIVATE_MEDIA_ACCESS: 'false', OPENWA_BASE_URL: '', OPENWA_API_KEY: '', S3_ENDPOINT: '', S3_BUCKET: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '',
  EMAIL_USER: '', EMAIL_PASS: '', ALERT_EMAIL_TO: '', CREATION_STAGING_DIR: path.join(directory, 'staging'), CREATION_LOG_DIR: path.join(directory, 'logs') };
Object.assign(process.env, environment);
const mongo = spawn(process.env.MONGOD_BINARY || 'mongod', ['--dbpath', path.join(directory, 'data'), '--port', String(mongoPort), '--bind_ip', '127.0.0.1', '--logpath', path.join(directory, 'mongo.log'), '--quiet'], { windowsHide: true, stdio: 'ignore' });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let api, output = '', checks = 0;
try {
  for (let attempt = 0; ; attempt++) { try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 300 }); break; } catch (error) { if (attempt > 40) throw error; await pause(200); } }
  const { default: User } = await import('../models/users.js');
  const { default: Role } = await import('../models/roles.js');
  const { default: Assignment } = await import('../models/accessAssignment.js');
  const { default: Batch } = await import('../models/batches.js');
  const { default: Student } = await import('../models/students.js');
  const { default: Expense } = await import('../models/expenses.js');
  const owner = await User.create({ _id:'6a4d7603f9f83920a371e5c2', name: 'Owner', role: 'superadmin', platformOwner: true, email: 'owner@example.invalid' });
  const staff = await User.create({ name: 'Auditor', role: 'Custom Auditor', accountType: 'staff', accessManaged: true, email: 'auditor@example.invalid' });
  const other = await User.create({ name: 'Other staff', role: 'Staff', accountType: 'staff', accessManaged: true });
  const a = await Batch.create({ name: 'A', description: 'Original batch', batch_type: 'Online', roll_nickname: 'A', batch_fee: '100',
    is_special_batch: true, special_fee_options: [{ key: 'one', label: 'One', fee: 100 }] }), b = await Batch.create({ name: 'B' });
  const sa = await Student.create({ name: 'Allowed student', phone: '0000000001', email: 'allowed@example.invalid', batch: a._id, pending_fee: 100, cnic: 'private' });
  const sb = await Student.create({ name: 'Other batch student', phone: '0000000002', email: 'other@example.invalid', batch: b._id, pending_fee: 200 });
  const role = await Role.create({ name: 'Auditor', code: 'test-auditor', managed: true, grants: [
    { permission: 'fields.general.read', scope: 'all' },
    { permission: 'students.get.students', scope: 'selected' }, { permission: 'students.get.student', scope: 'selected' },
    { permission: 'students.basic.student.update', scope: 'selected' }, { permission: 'fields.contact.write', scope: 'all', fields: ['phone'] },
    { permission: 'expenses.approve.expense', scope: 'all', maxAmount: 100, noSelfApproval: true },
  ] });
  const assigned = await Assignment.create({ user: staff._id, role: role._id, batchIds: [a._id], assignedBy: owner._id });
  api = spawn(process.execPath, [path.join(source, 'index.js')], { cwd: directory, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout.on('data', (chunk) => { output = (output + chunk).slice(-10000); }); api.stderr.on('data', (chunk) => { output = (output + chunk).slice(-10000); });
  const base = `http://127.0.0.1:${apiPort}`;
  for (let attempt = 0; ; attempt++) { try { assert.equal((await fetch(`${base}/health/ready`)).status, 200); break; } catch { if (attempt > 300 || api.exitCode !== null) throw new Error(`API startup failed (exit=${api.exitCode}, signal=${api.signalCode}): ${output}`); await pause(200); } }
  const token = (user) => jwt.sign({ user: { id: String(user._id), role: 'superadmin', permissions: ['everything'] } }, environment.JWT_SECRET);
  const request = async (user, method, route, body) => {
    const response = await fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${token(user)}`, 'Content-Type': 'application/json', 'X-Creation-Protocol':'2' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json().catch(() => null) };
  };

  const {staffRoleProfiles}=await import('../utils/staffRoleProfiles.js');const {approvedBlueprints}=await import('../utils/accessBlueprints.js');
  const {completeWorkflowAccess}=await import('../utils/accessWorkflowRules.js');const {accessCatalog}=await import('../utils/accessCatalog.js');
  const {default:Panelist}=await import('../models/panelists.js');const {default:Panel}=await import('../models/interviewPanel.js');const {default:Evaluation}=await import('../models/interviewEvaluation.js');
  const {default:Teacher}=await import('../models/teachers.js');const {default:Qualifier}=await import('../models/qualifiers.js');const {default:Defaults}=await import('../models/accessDefaults.js');
  const {default:bcrypt}=await import('bcryptjs');
  const panelRole=await Role.create({...approvedBlueprints().find(r=>r.code==='lca-v1-panelist'),managed:true,active:true});await Defaults.create({_id:'onboarding',roles:{panelist:panelRole._id}});
  const check=async(u,m,p,b,status=200)=>{const r=await request(u,m,p,b);assert.equal(r.status,status,`${u.name} ${m} ${p}: ${JSON.stringify(r)}`);checks++;return r.data;};
  const people={};for(const code of ['lca-staff-principle','lca-staff-vice-principle']){const p=staffRoleProfiles().find(r=>r.code===code);const u=await User.create({name:p.name,role:p.name,accountType:'staff',accessManaged:true});const r=await Role.create({...p,managed:true});await Assignment.create({user:u._id,role:r._id,assignedBy:owner._id});people[code]=u;}
  const principal=people['lca-staff-principle'],vice=people['lca-staff-vice-principle'];
  const hash=await bcrypt.hash('fixture-unchanged-password',12);const teacher=await User.create({name:'Existing teacher',email:'teacher@example.invalid',phone:'',role:'teacher',accountType:'teacher',accessManaged:true,password:hash});
  const teacherRole=await Role.create({...approvedBlueprints().find(r=>r.code==='lca-v1-teacher'),managed:true});await Assignment.create({user:teacher._id,role:teacherRole._id,assignedBy:owner._id});await Teacher.create({name:teacher.name,email:teacher.email,phone:'+92 321 0000011',user:teacher._id});
  const lookup=await check(principal,'POST','/panelists/identity/lookup',{phone:'03210000011'});assert.equal(lookup.found,true);assert.ok(lookup.existing_user.accessRoleNames.includes('Teacher'));checks++;
  const beforeUsers=await User.countDocuments();const reused=await check(principal,'POST','/panelists/add',{name:teacher.name,phone:'03210000011',description:'Teacher panelist'});
  const p1=await Panelist.findOne({user:teacher._id});assert.ok(p1);assert.equal(await User.countDocuments(),beforeUsers);assert.equal((await User.findById(teacher._id)).password,hash);assert.equal((await User.findById(teacher._id)).accountType,'teacher');assert.equal(await Assignment.countDocuments({user:teacher._id,revokedAt:null}),2);checks+=5;
  await check(principal,'POST','/panelists/add',{name:teacher.name,phone:'+92 321 0000011',description:'Retry'});assert.equal(await Panelist.countDocuments({user:teacher._id}),1);assert.equal(await Assignment.countDocuments({user:teacher._id,role:panelRole._id,revokedAt:null}),1);checks+=2;
  const login=await check(teacher,'POST','/users/login',{phone:'03210000011',password:'fixture-unchanged-password'});assert.ok(login.authToken);checks++;
  const fresh=await check(vice,'POST','/panelists/add',{name:'New panelist',phone:'03210000012',description:'Fixture panelist',password:'fixture-new-password'});const p2=await Panelist.findById(fresh.panelist._id);const user2=await User.findById(p2.user);assert.equal(user2.accountType,'panelist');assert.ok(await bcrypt.compare(DEFAULT_STAFF_PASSWORD,user2.password));checks+=2;
  await check(user2,'POST','/users/login',{phone:'03210000012',password:DEFAULT_STAFF_PASSWORD});
  await User.updateOne({_id:user2._id},{$set:{password:await bcrypt.hash('unusable-rollout-secret',12)}});await Panelist.updateOne({_id:p2._id},{$set:{login_setup_required:true}});
  await check(vice,'POST','/panelists/add',{name:p2.name,phone:p2.phone,description:p2.description});assert.equal((await Panelist.findById(p2._id)).login_setup_required,false);checks++;await check(user2,'POST','/users/login',{phone:p2.phone,password:DEFAULT_STAFF_PASSWORD});
  const missing=await Panelist.countDocuments();await check(vice,'POST','/panelists/add',{name:'No password',phone:'03210000013',description:'Uses staff default'});assert.equal(await Panelist.countDocuments(),missing+1);checks++;
  const conflict=await User.create({name:'Other identity',email:'conflict@example.invalid',phone:'03210000014',role:'Staff',accessManaged:true});await check(principal,'POST','/panelists/add',{name:'Identity mismatch',phone:'03210000011',email:conflict.email,description:'Mismatch'},409);
  const concurrent=await Promise.all([1,2].map(()=>request(principal,'POST','/panelists/add',{name:'Concurrent panelist',phone:'03210000015',description:'Fixture',password:'fixture-concurrent-password'})));assert.ok(concurrent.every(r=>r.status===200),JSON.stringify(concurrent));assert.equal(await Panelist.countDocuments({normalized_phone:'3210000015'}),1);checks+=2;
  const member=p=>({panelist_id:String(p._id),name:p.name,description:p.description,role:'Panelist'});
  await check(principal,'POST','/interview-panels/add',{title:'Invalid Solo',panel_type:'solo',members:[member(p1),member(p2)]},400);
  await check(principal,'POST','/interview-panels/add',{title:'Invalid Team',panel_type:'team',members:[member(p1)]},400);
  await check(principal,'POST','/interview-panels/add',{title:'Duplicate member',panel_type:'team',members:[member(p1),member(p1)]},400);
  const team=await check(vice,'POST','/interview-panels/add',{title:'Team interview',panel_type:'team',members:[member(p1),member(p2)]});
  const solo=await check(principal,'POST','/interview-panels/add',{title:'Solo interview',panel_type:'solo',members:[member(p1)]});
  const slot={date:'2035-02-01',start_time:'09:00',end_time:'09:30',venue:'Room A'};
  const scheduled=await check(vice,'POST',`/interview-panels/schedules/${team._id}/add`,{schedules:[slot,{...slot,start_time:'10:00',end_time:'10:30'}],expected_revision:team.__v});const sid=String(scheduled.schedules[0]._id);
  await check(principal,'POST',`/interview-panels/schedules/${solo._id}/add`,{schedules:[{...slot,start_time:'09:15',end_time:'09:45'}]},409);
  await check(vice,'POST',`/interview-panels/schedules/${team._id}/add`,{schedules:[{...slot,date:'2035-02-02'}],expected_revision:team.__v},409);
  const race=await Promise.all([team,solo].map(p=>request(principal,'POST',`/interview-panels/schedules/${p._id}/add`,{schedules:[{...slot,start_time:'11:00',end_time:'11:30'}]})));assert.equal(race.filter(r=>r.status===200).length,1,JSON.stringify(race));assert.equal(race.filter(r=>r.status===409).length,1);checks+=2;
  const candidateBatch=await Batch.create({name:'Candidate interview batch',is_interview_batch:true});const candidate=await Qualifier.create({batch:candidateBatch._id,name:'Candidate fixture',phone:'03210000021',email:'candidate@example.invalid',is_active:true});
  await check(principal,'POST',`/interview-panels/book/${team._id}`,{schedule_id:sid,booked_for:candidate.name,booked_phone:candidate.phone});
  await check(vice,'POST',`/interview-panels/book/${team._id}`,{schedule_id:sid,booked_for:candidate.name,booked_phone:candidate.phone},400);
  const who=await check(teacher,'GET','/access/me');assert.equal(who.accountType,'teacher');assert.equal(who.panelistId,String(p1._id));checks+=2;
  await check(teacher,'POST',`/interview-panels/start-interview/${team._id}`,{schedule_id:sid});
  const scores={schedule_id:sid,knowledge:1,analytical_ability:1,communication:1,confidence:1,personality:1,body_language:1,current_affairs:1,ethics_decision:1,verdict:'needs_more_mock',final_remarks:'Isolated evaluation'};
  await check(teacher,'POST',`/interview-panels/submit-evaluation/${team._id}`,scores);assert.equal((await Panel.findById(team._id)).schedules[0].interview_status,'in_progress');checks++;
  await check(teacher,'POST',`/interview-panels/submit-evaluation/${team._id}`,scores,409);
  await check(user2,'POST',`/interview-panels/start-interview/${team._id}`,{schedule_id:sid});await check(user2,'POST',`/interview-panels/submit-evaluation/${team._id}`,scores);
  const complete=await Panel.findById(team._id);assert.equal(complete.schedules[0].interview_status,'completed');assert.equal(await Evaluation.countDocuments({panel_id:team._id,schedule_id:sid,status:'completed'}),2);checks+=2;
  const details=await check(teacher,'GET',`/interview-panels/evaluation-details/${team._id}/${sid}`);assert.equal(details.evaluations.length,2);checks++;
  const append=await check(principal,'POST',`/interview-panels/schedules/${team._id}/add`,{schedules:[{...slot,date:'2035-02-03'}]});assert.equal(append.schedules[0].interview_status,'completed');assert.equal(String(append.schedules[0]._id),sid);checks+=2;
  const proposed=append.schedules.map(s=>({_id:s._id,date:s.date,start_time:s.start_time,end_time:s.end_time,venue:s.venue,notes:s.notes}));
  await check(principal,'POST',`/interview-panels/schedules/${team._id}/update`,{schedules:proposed.filter(s=>String(s._id)!==sid)},409);
  await check(principal,'POST',`/interview-panels/schedules/${team._id}/update`,{schedules:proposed.map(s=>String(s._id)===sid?{...s,date:'2035-04-01'}:s)},409);
  await check(owner,'DELETE',`/interview-panels/delete/${team._id}`,null,409);
  const cancelId=String(append.schedules[1]._id);await check(vice,'POST',`/interview-panels/schedules/${team._id}/${cancelId}/cancel`,{cancellation_reason:'Cancelled fixture'});assert.equal((await Panel.findById(team._id)).schedules[1].interview_status,'cancelled');checks++;
  await check(principal,'POST',`/interview-panels/book/${team._id}`,{schedule_id:cancelId,booked_for:candidate.name,booked_phone:candidate.phone},409);
  const outsider=await User.findOne({phone:'03210000015'});await check(outsider,'GET',`/interview-panels/conduct/${team._id}/${sid}`,null,404);
  await check(teacher,'POST','/interview-panels/add',{title:'Escalation',panel_type:'solo',members:[member(p1)]},403);
  await check(owner,'POST',`/panelists/change-password/${p1._id}`,{password:'fixture-cannot-reset-teacher'},409);assert.equal((await User.findById(teacher._id)).password,hash);checks++;
  const customRole=await Role.create({name:'Interview coordinator fixture',code:'fixture-interview-coordinator',managed:true,active:true,grants:completeWorkflowAccess([{permission:'panelists.add.panelist',scope:'all'},{permission:'panelists.get.panelists',scope:'all'},{permission:'fields.general.read',scope:'all'},{permission:'fields.contact.read',scope:'all'}],accessCatalog)});
  const coordinator=await User.create({name:'Custom coordinator',role:'Custom coordinator',accountType:'staff',accessManaged:true});await Assignment.create({user:coordinator._id,role:customRole._id,assignedBy:owner._id});
  await check(coordinator,'POST','/panelists/identity/lookup',{phone:'03210000011'});
  await check(coordinator,'POST','/panelists/add',{name:'Custom role panelist',phone:'03210000016',description:'Custom permissions'});
  await check(coordinator,'POST','/interview-panels/add',{title:'Not allowed',panel_type:'solo',members:[member(p1)]},403);
  const soloSchedule=await check(principal,'POST','/interview-panels/schedules/'+solo._id+'/add',{schedules:[{...slot,date:'2035-02-10'}]});const soloSid=String(soloSchedule.schedules[0]._id);
  await check(principal,'POST','/interview-panels/book/'+solo._id,{schedule_id:soloSid,booked_for:candidate.name,booked_phone:candidate.phone});
  await check(teacher,'POST','/interview-panels/start-interview/'+solo._id,{schedule_id:soloSid});await check(teacher,'POST','/interview-panels/submit-evaluation/'+solo._id,{...scores,schedule_id:soloSid});assert.equal((await Panel.findById(solo._id)).schedules[0].interview_status,'completed');checks++;
  const disposable=await Panelist.findOne({normalized_phone:'3210000016'});await check(owner,'DELETE','/panelists/delete/'+disposable._id);assert.equal((await Panelist.findById(disposable._id)).is_active,false);await check(await User.findById(disposable.user),'GET','/access/me',null,403);checks++;
  await check(principal,'POST',`/panelists/toggle-status/${p1._id}`,{is_active:false});await check(teacher,'GET',`/interview-panels/conduct/${team._id}/${sid}`,null,403);
  await check(teacher,'GET',`/users/${teacher._id}`);assert.ok(await Assignment.exists({user:teacher._id,role:teacherRole._id,revokedAt:null}));checks++;
  console.log(JSON.stringify({interviewWorkflowChecks:checks,existingLoginAndRolesPreserved:true,soloAndTeam:true,stableSchedules:true,concurrencyChecked:true,productionRecordsTouched:false,isolatedDatabase:true}));
} finally {
  if (api) { api.kill('SIGTERM'); await new Promise((resolve) => api.exitCode !== null ? resolve() : api.once('exit', resolve)); }
  await mongoose.disconnect(); mongo.kill('SIGTERM'); await new Promise((resolve) => mongo.exitCode !== null ? resolve() : mongo.once('exit', resolve));
  process.chdir(os.tmpdir()); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}






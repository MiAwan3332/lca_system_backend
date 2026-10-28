import assert from 'node:assert/strict';
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

  const { staffRoleProfiles } = await import('../utils/staffRoleProfiles.js');
  const profiles = {};
  for (const profile of staffRoleProfiles()) {
    const person = await User.create({name:profile.name,role:profile.name,accountType:'staff',accessManaged:true,email:profile.code+'@example.invalid'});
    const policy = await Role.create({...profile,managed:true});
    await Assignment.create({user:person._id,role:policy._id,assignedBy:owner._id});
    profiles[profile.code.split('-').slice(2).join('-')] = person;
  }
  const principal=profiles.principle, vice=profiles['vice-principle'], accounts=profiles['account-officer'], desk=profiles['information-desk'];
  const check = async(user,method,route,body,status=200)=>{const r=await request(user,method,route,body);assert.equal(r.status,status,`${user.name} ${method} ${route}: ${JSON.stringify(r)}`);checks++;return r.data;};
  const {default:Fee}=await import('../models/fees.js');
  const {default:Slip}=await import('../models/admissionSlipVerification.js');
  const {default:Receipt}=await import('../models/feeReceipts.js');
  await Student.updateOne({_id:sa._id},{$set:{total_fee:100,paid_fee:0}});
  const fee=await Fee.create({student:sa._id,batch:a._id,amount:100,due_date:'2035-01-01'});
  for(const person of Object.values(profiles)){
    const students=await check(person,'GET','/students?limit=50');
    assert.equal(students.totalDocs,2);assert.ok(students.docs.every(s=>s.name&&s.phone));checks++;
    const access=await check(person,'GET','/access/me');assert.ok(access.communication);checks++;
    await check(person,'GET',`/users/${person._id}`);
    await check(person,'POST',`/users/update/${person._id}`,{name:person.name+' edited'});
    await check(person,'POST','/access/roles',{name:'Escalation'},403);
    await check(person,'POST',`/expenses/approve/${ownExpenseId()}`,{},403);
    await check(person,'POST',`/refund-requests/approve/${ownExpenseId()}`,{},403);
    await check(person,'POST',`/fees/discount/${fee._id}`,{amount:1},403);
    await check(person,'DELETE',`/students/delete/${sa._id}`,null,403);
    await check(person,'POST',`/students/basic-update/${sa._id}`,{pending_fee:0},403);
    await check(person,'GET','/batches');await check(person,'GET','/courses');
  }
  function ownExpenseId(){return String(fee._id)}
  for(const person of [principal,vice,desk])await check(person,'POST',`/fees/pay/${fee._id}`,{amount:10},403);
  await check(accounts,'POST',`/fees/collect-pending/${sa._id}`,{discount_amount:1},403);
  await check(accounts,'POST',`/students/basic-update/${sa._id}`,{phone:'0000000008'});
  for(const person of [desk,accounts])await check(person,'POST',`/students/basic-update/${sa._id}`,{batch:String(b._id)},403);
  for(const person of [principal,vice]){
    await check(person,'POST',`/batches/update/${a._id}`,{description:'Academic edit'});
    await check(person,'POST',`/students/basic-update/${sa._id}`,{name:'Allowed student'});
    await check(person,'GET','/fees/report');await check(person,'GET','/statistics/batch-finance');
  }
  await check(accounts,'GET','/fees/report');
  await check(accounts,'POST',`/fees/pay/${fee._id}`,{student_id:String(sa._id),amount:25,description:'Isolated cash collection',payment_method:'Cash',next_installment_date:'2035-01-01'});
  const paid=await Student.findById(sa._id);assert.equal(paid.paid_fee,25);assert.equal(paid.pending_fee,75);checks++;
  await check(accounts,'POST','/expenses/add',{title:'Test expense',amount:10,category:'Other',expense_date:'2026-10-28',payment_method:'Cash'},201);
  for(const person of [principal,vice])await check(person,'POST','/expenses/add',{title:'Own request',amount:10,expense_date:'2026-10-28',payment_method:'Cash'},201);
  const own=await check(vice,'GET','/expenses');assert.equal(own.totalDocs,1);checks++;
  const all=await check(principal,'GET','/expenses');assert.equal(all.totalDocs,3);checks++;
  await check(desk,'GET','/expenses',null,403);
  for(const person of Object.values(profiles)){
    const slip=await check(person,'POST','/admission-slips/issue',{student_id:String(sa._id),slip_type:'admission'});
    const saved=await Slip.findOne({token:slip.verify_url.split('/').pop()});assert.equal(saved.student_name,'Allowed student');assert.equal(saved.amount_received,25);assert.equal(saved.remaining_fee,75);checks++;
  }
  const refund=await check(accounts,'POST','/refund-requests/add',{studentId:String(sa._id),amount:10,reason:'Isolated refund request'},201);
  await check(accounts,'GET','/refund-requests');
  await check(accounts,'POST',`/refund-requests/process/${refund._id}`,{payment_method:'Cash'},400);
  await check(owner,'POST',`/refund-requests/approve/${refund._id}`,{comment:'Owner approved in isolated test'});
  await check(accounts,'POST',`/refund-requests/process/${refund._id}`,{payment_method:'Cash'});
  const receipt=await Receipt.create({student:sa._id,created_by:accounts._id,payload:{payingNow:25,remainingAfter:75,totalFee:100,paymentMethod:'Cash'}});
  const print=await check(accounts,'POST','/admission-slips/issue',{student_id:String(sa._id),receipt_id:String(receipt._id),slip_type:'fee'});
  assert.equal((await Slip.findOne({token:print.verify_url.split('/').pop()})).amount_received,25);checks++;
  const {default:Defaults}=await import('../models/accessDefaults.js');
  const studentPolicy=await Role.create({name:'Fixture student default',code:'fixture-student',managed:true,active:true,grants:[]});
  await Defaults.create({_id:'onboarding',roles:{student:studentPolicy._id}});
  await check(desk,'POST','/students/add',{name:'New desk student',phone:'0000011199',batch:String(b._id),cnic:'1234512345671'},201);
  const {default:Template}=await import('../models/whatsappTemplate.js');
  for(const process of ['student_admission','fee_payment','custom','user_welcome'])await Template.create({key:'test_'+process,name:process,process,body:'Hello {{name}}'});
  for(const person of Object.values(profiles)){
    const list=await check(person,'GET','/whatsapp/templates');
    const serialized=JSON.stringify(list.templates);assert.ok(!serialized.includes('user_welcome'));checks++;
    await check(person,'GET','/whatsapp/queue');
    await check(person,'POST','/whatsapp/queue/cancel-all',{},403);
  }
  for(const person of [desk,accounts])await check(person,'POST','/whatsapp/queue/bulk',{body:'Unapproved body',audience:'students'},403);
  await check(accounts,'POST','/whatsapp/queue/bulk',{template_key:'test_fee_payment',audience:'students',batch_id:String(b._id)});
  await check(desk,'POST','/whatsapp/queue/bulk',{template_key:'test_student_admission',audience:'students',batch_id:String(b._id)});
  const targets=[];
  for(const email of ['atifhussainhussain1100@gmail.com','miawanofficial@gmail.com']){
    const u=await User.create({name:'Isolated migration target',email,role:'Legacy staff',accountType:'staff',accessManaged:true,password:'fixture-hash-unchanged'});targets.push(u);
    await Assignment.create({user:u._id,role:role._id,assignedBy:owner._id});
  }
  const applyScript=(apply)=>spawnSync(process.execPath,[path.join(source,'scripts/applyStaffRoles.mjs'),...(apply?['--apply','--backup='+path.join(directory,'staff-before.json')]:[])],{cwd:directory,env:environment,encoding:'utf8',timeout:30000});
  const beforeAssignments=await Assignment.countDocuments();const dry=applyScript(false);assert.equal(dry.status,0,dry.stderr);assert.equal(await Assignment.countDocuments(),beforeAssignments);checks++;
  const applied=applyScript(true);assert.equal(applied.status,0,applied.stderr);assert.equal(JSON.parse(applied.stdout).assignedUsers,2);checks++;
  for(const u of targets){const saved=await User.findById(u._id).select('+password');assert.equal(saved.password,'fixture-hash-unchanged');assert.equal(saved.role,'Legacy staff');assert.equal(await Assignment.countDocuments({user:u._id,revokedAt:null}),1);checks++;}
  console.log(JSON.stringify({staffRoleHttpChecks:checks,rolesTested:4,externalServicesCalled:false,isolatedDatabase:true}));
} finally {
  if (api) { api.kill('SIGTERM'); await new Promise((resolve) => api.exitCode !== null ? resolve() : api.once('exit', resolve)); }
  await mongoose.disconnect(); mongo.kill('SIGTERM'); await new Promise((resolve) => mongo.exitCode !== null ? resolve() : mongo.once('exit', resolve));
  process.chdir(os.tmpdir()); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}



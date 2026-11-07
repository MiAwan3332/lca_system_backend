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

  const {staffRoleProfiles, STAFF_ROLE_CODES}=await import('../utils/staffRoleProfiles.js');
  const {completeWorkflowAccess}=await import('../utils/accessWorkflowRules.js');
  const {accessCatalog}=await import('../utils/accessCatalog.js');
  const {default:Fee}=await import('../models/fees.js');const {default:FeeLog}=await import('../models/feeLogs.js');
  const {default:Refund}=await import('../models/refundRequests.js');const {default:Defaults}=await import('../models/accessDefaults.js');
  const studentRole=await Role.create({name:'Fixture student',code:'fixture-student',managed:true,active:true,grants:[]});
  await Defaults.create({_id:'onboarding',roles:{student:studentRole._id}});
  const check=async(user,method,route,body,status=200)=>{const r=await request(user,method,route,body);assert.equal(r.status,status,`${user.name} ${method} ${route}: ${JSON.stringify(r)}`);checks++;return r.data;};
  const permissions=[{permission:'fees.discount.fee',scope:'all',maxAmount:50},...['expenses.approve.expense','expenses.reject.expense','refund-requests.approve.refund.request','refund-requests.reject.refund.request'].map(permission=>({permission,scope:'all',maxAmount:100,noSelfApproval:true}))];
  const profiles=staffRoleProfiles();profiles.push({...profiles.find(p=>p.code===STAFF_ROLE_CODES.accounts),code:'custom-account-copy',profile:STAFF_ROLE_CODES.accounts,name:'Custom account copy'});
  let account,accountPolicy,accountBase;
  for(const [index,profile] of profiles.entries()){
    const person=await User.create({name:profile.name,role:profile.name,accountType:'staff',accessManaged:true});
    const policy=await Role.create({...profile,managed:true});await Assignment.create({user:person._id,role:policy._id,assignedBy:owner._id});
    const student=await Student.create({name:'Discount fixture '+index,phone:'0310000010'+index,batch:a._id,total_fee:1000,pending_fee:1000,paid_fee:0});
    const fee=await Fee.create({student:student._id,batch:a._id,amount:1000,due_date:'2035-01-01'});
    await FeeLog.create({student:student._id,fee:fee._id,amount:1000,action_amount:1000,action_type:'Created',action_by:owner._id,action_date:new Date()});
    const expense=await Expense.create({title:'Other expense',amount:80,created_by:other._id,expense_date:'2026-10-28',payment_method:'Cash'});
    const own=await Expense.create({title:'Own expense',amount:50,created_by:person._id,expense_date:'2026-10-28',payment_method:'Cash'});
    const large=await Expense.create({title:'Large expense',amount:150,created_by:other._id,expense_date:'2026-10-28',payment_method:'Cash'});
    const refund=await Refund.create({student:student._id,amount:80,requested_by:other._id,reason:'Isolated refund'});
    const ownRefund=await Refund.create({student:student._id,amount:50,requested_by:person._id,reason:'Own refund'});
    await check(person,'POST',`/fees/discount/${fee._id}`,{amount:25,description:'No permission'},403);
    await check(person,'POST',`/expenses/approve/${expense._id}`,{},403);
    await check(person,'POST',`/refund-requests/approve/${refund._id}`,{comment:'No permission'},403);
    let base=[...profile.grants];
    if(profile.code===STAFF_ROLE_CODES.accounts){
      for(const p of accessCatalog.permissions.filter(p=>['students','batches'].includes(p.group)))if(!base.some(g=>g.permission===p.key))base.push({permission:p.key,scope:'all'});
      base.push({permission:'fields.identity.write',scope:'all'});
    }
    const next=completeWorkflowAccess([...base,...permissions],accessCatalog);
    let updated=await check(owner,'PUT',`/access/roles/${policy._id}`,{name:profile.name,description:profile.description,profile:profile.profile,active:true,revision:policy.revision,grants:next,reason:'Isolated configurable decision test'});
    await check(person,'POST',`/fees/discount/${fee._id}`,{amount:40,description:'Granted discount'});
    assert.equal((await Fee.findById(fee._id)).amount,960);checks++;
    await check(person,'POST',`/fees/discount/${fee._id}`,{amount:51,description:'Exceeds discount limit'},403);
    await check(person,'POST',`/expenses/approve/${own._id}`,{},403);
    await check(person,'POST',`/expenses/approve/${large._id}`,{},403);
    await check(person,'POST',`/expenses/approve/${expense._id}`,{});
    assert.equal((await Expense.findById(expense._id)).status,'Approved');checks++;
    await check(person,'POST',`/refund-requests/approve/${ownRefund._id}`,{comment:'Self approval denied'},403);
    await check(person,'POST',`/refund-requests/approve/${refund._id}`,{comment:'Granted approval',amount:80});
    assert.equal((await Refund.findById(refund._id)).status,'Approved');checks++;
    const rejectExpense=await Expense.create({title:'Reject fixture',amount:60,created_by:other._id,expense_date:'2026-10-28',payment_method:'Cash'});
    await check(person,'POST',`/expenses/reject/${rejectExpense._id}`,{rejection_reason:'Granted rejection'});
    const rejectRefund=await Refund.create({student:student._id,amount:60,requested_by:other._id,reason:'Reject fixture'});
    await check(person,'POST',`/refund-requests/reject/${rejectRefund._id}`,{comment:'Granted rejection'});
    if(profile.code!==STAFF_ROLE_CODES.accounts){
      const relaxed=next.map(g=>permissions.some(p=>p.permission===g.permission)?{...g,maxAmount:g.permission==='fees.discount.fee'?100:200,noSelfApproval:false}:g);
      updated=await check(owner,'PUT',`/access/roles/${policy._id}`,{name:profile.name,description:profile.description,profile:profile.profile,active:true,revision:updated.revision,grants:relaxed,reason:'Isolated configurable limits and self approval'});
      await check(person,'POST',`/expenses/approve/${own._id}`,{});
      await check(person,'POST',`/expenses/approve/${large._id}`,{});
      await check(person,'POST',`/refund-requests/approve/${ownRefund._id}`,{comment:'Self approval explicitly allowed'});
      await check(person,'POST',`/fees/discount/${fee._id}`,{amount:60,description:'Increased discount permission limit'});
    }
    if(profile.code===STAFF_ROLE_CODES.accounts){account=person;accountPolicy=updated;accountBase=base;}
    else{
      await check(owner,'PUT',`/access/roles/${policy._id}`,{name:profile.name,description:profile.description,profile:profile.profile,active:true,revision:updated.revision,grants:profile.grants,reason:'Isolated permission revocation'});
      await check(person,'POST',`/fees/discount/${fee._id}`,{amount:10,description:'Revoked'},403);
      await check(person,'POST',`/expenses/approve/${own._id}`,{},403);
    }
  }
  const normal=await Batch.create({name:'Normal admission',roll_nickname:'NORMAL',batch_type:'Online',batch_fee:'1000',is_paid_batch:true});
  await check(account,'POST','/students/add',{name:'Granted admission discount',phone:'03000001199',batch:String(normal._id),discount_amount:25,discount_description:'Granted inline discount',paying_now:0,cnic:'1234512345671'},201);
  const admitted=await Student.findOne({phone:'03000001199'});assert.equal(admitted.total_fee,975);checks++;
  await check(account,'POST','/students/add',{name:'Over limit',phone:'03000001198',batch:String(normal._id),discount_amount:51,discount_description:'Too much',paying_now:0},403);
  assert.equal(await Student.countDocuments({phone:'03000001198'}),0);checks++;
  await check(account,'POST',`/fees/collect-pending/${admitted._id}`,{amount:10,payment_option:'partial',payment_method:'Cash',remarks:'Granted collection discount',discount_amount:20,discount_description:'Approved by grant',next_installment_date:'2035-01-01'});
  assert.equal((await Student.findById(admitted._id)).pending_fee,945);checks++;
  await check(account,'POST',`/fees/collect-pending/${admitted._id}`,{amount:10,payment_option:'partial',payment_method:'Cash',remarks:'Over limit',discount_amount:51,next_installment_date:'2035-01-01'},403);
  await check(owner,'PUT',`/access/roles/${accountPolicy._id}`,{name:accountPolicy.name,description:accountPolicy.description,active:true,revision:accountPolicy.revision,grants:completeWorkflowAccess(accountBase,accessCatalog),reason:'Isolated discount and approval revocation'});
  await check(account,'POST',`/fees/collect-pending/${admitted._id}`,{amount:10,payment_option:'partial',payment_method:'Cash',remarks:'Revoked',discount_amount:1},403);
  console.log(JSON.stringify({configurableFinanceChecks:checks,profilesTested:5,roleChangesThroughApi:true,isolatedDatabase:true,externalServicesCalled:false}));
} finally {
  if (api) { api.kill('SIGTERM'); await new Promise((resolve) => api.exitCode !== null ? resolve() : api.once('exit', resolve)); }
  await mongoose.disconnect(); mongo.kill('SIGTERM'); await new Promise((resolve) => mongo.exitCode !== null ? resolve() : mongo.once('exit', resolve));
  process.chdir(os.tmpdir()); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}





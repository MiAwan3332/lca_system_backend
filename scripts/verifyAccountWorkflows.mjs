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

  const { staffRoleProfiles, STAFF_ROLE_CODES } = await import('../utils/staffRoleProfiles.js');
  const { completeWorkflowAccess } = await import('../utils/accessWorkflowRules.js');
  const catalog = JSON.parse(await fs.readFile(path.join(source, 'config/accessCatalog.generated.json'), 'utf8'));
  const { default: Teacher } = await import('../models/teachers.js');
  const { default: Course } = await import('../models/courses.js');
  const { default: Fee } = await import('../models/fees.js');
  const { default: Defaults } = await import('../models/accessDefaults.js');
  const studentPolicy = await Role.create({name:'Fixture student',code:'fixture-student',managed:true,active:true,grants:[]});
  await Defaults.create({_id:'onboarding',roles:{student:studentPolicy._id}});
  const profile = staffRoleProfiles().find(p => p.code === STAFF_ROLE_CODES.accounts);
  const original = [...profile.grants, {permission:'fields.identity.write',scope:'all'}];
  for (const p of catalog.permissions.filter(p => ['students','batches'].includes(p.group) && p.key !== 'batches.get.batch.assignment.options')) {
    if (!original.some(g => g.permission === p.key)) original.push({permission:p.key,scope:'all'});
  }
  const account = await User.create({name:'Workflow Account Officer',role:'Accounts',accountType:'staff',accessManaged:true});
  const policy = await Role.create({...profile,grants:original,managed:true});
  await Assignment.create({user:account._id,role:policy._id,assignedBy:owner._id});
  const check = async(user,method,route,body,status=200)=>{const r=await request(user,method,route,body);assert.equal(r.status,status,`${method} ${route}: ${JSON.stringify(r)}`);checks++;return r.data;};
  await check(account,'POST',`/students/transfer-batch/${sa._id}`,{batch:String(b._id),assign_new_fee:true},403);
  await check(account,'GET',`/batches/assignment-options/${a._id}`,null,403);
  await Role.updateOne({_id:policy._id},{$set:{grants:completeWorkflowAccess(original,catalog)},$inc:{revision:1}});
  const teacher = await Teacher.create({name:'Fixture teacher',email:'private@example.invalid',phone:'private',resume:'private.pdf'});
  const course = await Course.create({name:'Fixture course',description:'Private details',fee:100});
  const options = await check(account,'GET',`/batches/assignment-options/${a._id}`);
  assert.deepEqual(Object.keys(options.teachers[0]).sort(),['_id','name']);
  assert.deepEqual(Object.keys(options.courses[0]).sort(),['_id','name']);checks+=2;
  await check(account,'GET','/teachers',null,403);
  await check(account,'POST','/batches/assignCourses',{batchId:String(a._id),courseIds:[String(course._id)]});
  await check(account,'POST','/batches/assignTeacherCourses',{batchId:String(a._id),assignments:[{teacher:String(teacher._id),course:String(course._id)}]});
  assert.equal((await Batch.findById(a._id)).teacher_course_assignments.length,1);checks++;
  const added = await check(account,'POST','/batches/add',{name:'Workflow batch',roll_nickname:'WORK',batch_type:'Online',batch_fee:'250',is_paid_batch:true,startdate:'2026-10-28',class_start_time:'09:00',class_end_time:'10:00'});
  const createdBatch = await Batch.findOne({name:'Workflow batch'});assert.equal(createdBatch.roll_nickname,'WORK');checks++;
  await check(account,'POST',`/batches/update/${createdBatch._id}`,{description:'Updated batch details',batch_fee:'250'});
  await check(account,'POST',`/batches/toggle-status/${createdBatch._id}`,{is_active:false});
  assert.equal((await Batch.findById(createdBatch._id)).is_active,false);checks++;
  await check(account,'POST',`/batches/toggle-status/${createdBatch._id}`,{is_active:true});
  await check(account,'POST',`/students/toggle-status/${sa._id}`,{is_active:false});
  assert.equal((await Student.findById(sa._id)).is_active,false);checks++;
  await check(account,'POST',`/students/toggle-status/${sa._id}`,{is_active:true});
  await Student.updateOne({_id:sa._id},{$set:{total_fee:100,paid_fee:0}});
  const fee = await Fee.create({student:sa._id,batch:a._id,amount:100,due_date:'2035-01-01'});
  await check(account,'POST',`/fees/pay/${fee._id}`,{student_id:String(sa._id),amount:100,payment_method:'Cash',description:'Isolated settlement'});
  await check(account,'POST',`/students/transfer-batch/${sa._id}`,{batch:String(createdBatch._id),assign_new_fee:true});
  const shifted=await Student.findById(sa._id);assert.equal(String(shifted.batch),String(createdBatch._id));assert.equal(shifted.pending_fee,250);checks+=2;
  await check(account,'POST','/students/add',{name:'Workflow admission',phone:'03000000999',batch:String(createdBatch._id),paying_now:'100',payment_method:'Cash',next_installment_date:'2035-01-01',cnic:'1234512345671'},201);
  const admitted=await Student.findOne({phone:'03000000999'});assert.equal(admitted.paid_fee,100);assert.equal(admitted.pending_fee,150);checks+=2;
  const imported=await check(account,'POST','/students/bulk-import',{batch_id:String(createdBatch._id),students:[{name:'Workflow import',phone:'03000000998',cnic:'1234512345672',total_fee:250,paid_fee:0,pending_fee:250,online_amount:0,cash_amount:0}]});
  assert.equal(imported.imported,1,JSON.stringify(imported));checks++;
  await check(account,'POST',`/students/basic-update/${admitted._id}`,{paid_fee:0},403);
  await check(account,'POST',`/students/basic-update/${admitted._id}`,{batch:String(b._id),assign_new_fee:true},403);
  await check(account,'POST',`/fees/discount/${fee._id}`,{amount:1},403);
  await check(account,'POST',`/expenses/approve/${fee._id}`,{},403);
  await check(account,'POST',`/refund-requests/approve/${fee._id}`,{},403);
  // Lookup needs both its own permission and an assignment action scoped to the destination.
  await Role.updateOne({_id:role._id},{$set:{grants:[{permission:'batches.get.batch.assignment.options',scope:'all'},{permission:'batches.assign.courses.to.batch',scope:'selected'},{permission:'fields.general.read',scope:'all'}]},$inc:{revision:1}});
  await check(staff,'GET',`/batches/assignment-options/${a._id}`);
  await check(staff,'GET',`/batches/assignment-options/${b._id}`,null,403);
  await Role.updateOne({_id:role._id},{$set:{grants:[{permission:'batches.get.batch.assignment.options',scope:'all'}]},$inc:{revision:1}});
  await check(staff,'GET',`/batches/assignment-options/${a._id}`,null,403);
  console.log(JSON.stringify({accountWorkflowChecks:checks,isolatedDatabase:true,externalServicesCalled:false}));
} finally {
  if (api) { api.kill('SIGTERM'); await new Promise((resolve) => api.exitCode !== null ? resolve() : api.once('exit', resolve)); }
  await mongoose.disconnect(); mongo.kill('SIGTERM'); await new Promise((resolve) => mongo.exitCode !== null ? resolve() : mongo.once('exit', resolve));
  process.chdir(os.tmpdir()); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}











// Isolated real-HTTP acceptance test. No production database or provider credentials are loaded.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lca-http-verify-'));
await fs.mkdir(path.join(directory, 'data'));
process.chdir(directory);
const freePort = async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};
const mongoPort = await freePort();
const port = await freePort();
const uri = `mongodb://127.0.0.1:${mongoPort}/lca_verify_http`;
const environment = { ...process.env, MONGO_URI: uri, PORT: String(port), JWT_SECRET: 'isolated-http-verification-only',
  OPENWA_BASE_URL: '', OPENWA_API_KEY: '', S3_ENDPOINT: '', S3_BUCKET: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '',
  EMAIL_USER: '', EMAIL_PASS: '', ALERT_EMAIL_TO: '', CORS_ORIGINS: 'https://lca-portal.com',
  CREATION_STAGING_DIR: path.join(directory, 'staging'), CREATION_LOG_DIR: path.join(directory, 'logs'),
  FILES_STORAGE_PATH: path.join(directory, 'files'), FILES_STORAGE_URL: '/public' };
Object.assign(process.env, environment);
const mongo = spawn(process.env.MONGOD_BINARY || 'mongod', ['--dbpath', path.join(directory, 'data'), '--port', String(mongoPort),
  '--bind_ip', '127.0.0.1', '--logpath', path.join(directory, 'mongo.log'), '--quiet'], { stdio: 'ignore' });
let api;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  for (let attempt = 0; ; attempt++) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 }); break; }
    catch (error) { if (attempt === 40) throw error; await pause(200); }
  }
  const { default: User } = await import('../models/users.js');
  const { default: Batch } = await import('../models/batches.js');
  const { default: Student } = await import('../models/students.js');
  const { default: Fee } = await import('../models/fees.js');
  const { default: FeeLog } = await import('../models/feeLogs.js');
  const actor = await User.create({ name: 'Isolated acceptance admin', email: 'http-admin@example.invalid', role: 'superadmin' });
  const batch = await Batch.create({ name: 'Isolated acceptance batch', batch_type: 'On Campus', roll_nickname: 'HTTP', batch_fee: '1000' });
  let output = '';
  api = spawn(process.execPath, [path.join(source, 'index.js')], { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout.on('data', (chunk) => { output = (output + chunk).slice(-10000); });
  api.stderr.on('data', (chunk) => { output = (output + chunk).slice(-10000); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    try { assert.equal((await fetch(`${base}/health/ready`)).status, 200); break; }
    catch (error) { if (attempt === 100 || api.exitCode !== null) throw new Error(`API failed startup: ${output}`); await pause(200); }
  }
  const token = jwt.sign({ user: { id: String(actor._id), role: actor.role } }, environment.JWT_SECRET, { expiresIn: '5m' });
  const key = crypto.randomUUID();
  const headers = { authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Creation-Protocol': '2' };
  const body = { name: 'Isolated HTTP Student', phone: '0000000000', batch: String(batch._id), paying_now: '200',
    discount_amount: '100', payment_method: 'Cash', next_installment_date: '2030-01-01' };
  const oldClient = await fetch(`${base}/students/add`, { method: 'POST', headers: { ...headers, 'X-Creation-Protocol': '1' }, body: JSON.stringify(body) });
  assert.equal(oldClient.status, 426);
  assert.equal(await Student.countDocuments(), 0);
  console.log('PASS real HTTP old client is rejected without creating records');
  const started = Date.now();
  const created = await fetch(`${base}/students/add`, { method: 'POST', headers, body: JSON.stringify(body) });
  const result = await created.json();
  assert.equal(created.status, 201, JSON.stringify(result));
  assert.equal(result.roll_number, 'OC-HTTP-1');
  assert.equal(result.total_fee, 900);
  assert.equal(result.pending_fee, 700);
  assert.equal(await Fee.countDocuments({ student: result.record_id }), 1);
  assert.equal(await FeeLog.countDocuments({ student: result.record_id }), 3);
  console.log(`PASS real HTTP student creation, roll, account and fee records (${Date.now() - started} ms)`);
  const replay = await fetch(`${base}/students/add`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).record_id, result.record_id);
  assert.equal(await Student.countDocuments(), 1);
  const lookup = await fetch(`${base}/students/by-key/${key}`, { headers });
  assert.equal((await lookup.json()).record_id, result.record_id);
  console.log('PASS real HTTP replay and by-key recovery preserve one student');
  const staff = await fetch(`${base}/users/add`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ name: 'Isolated HTTP staff', email: 'http-staff@example.invalid', phone: 'test-only-no-phone', role: 'admin' }) });
  assert.equal(staff.status, 201, await staff.text());
  console.log('PASS real HTTP staff creation');
  const unauthenticated = await fetch(`${base}/operations/creation-metrics`);
  assert.equal(unauthenticated.status, 401);
  const capabilities = await fetch(`${base}/operations/creation-capabilities`, { headers });
  assert.equal((await capabilities.json()).protocol, 2);
  console.log('PASS real HTTP authorization and creation capabilities');
  console.log('HTTP_ACCEPTANCE_PASSED (isolated database; providers disabled)');
} finally {
  if (api) { api.kill('SIGTERM'); await new Promise((resolve) => api.exitCode !== null ? resolve() : api.once('exit', resolve)); }
  await mongoose.disconnect();
  mongo.kill('SIGTERM');
  await new Promise((resolve) => mongo.exitCode !== null ? resolve() : mongo.once('exit', resolve));
  await fs.rm(directory, { recursive: true, force: true });
}

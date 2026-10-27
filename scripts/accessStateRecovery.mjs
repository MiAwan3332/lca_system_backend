import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { approvedBlueprints } from '../utils/accessBlueprints.js';

const value = (key) => process.argv.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
const mode = value('mode'), path = value('file');
assert.ok(['capture', 'restore'].includes(mode) && path && process.env.MONGO_URI, 'Supply --mode=capture|restore --file=PATH and MONGO_URI');
if (mode === 'restore') assert.ok(process.argv.includes('--application-stopped'), 'Restore requires a stopped application');
const fields = ['accountType', 'accessManaged', 'platformOwner', 'disabledAt', 'accessOnboardingRole'];
const codes = approvedBlueprints().map(({ code }) => code);
const EJSON = mongoose.mongo.BSON.EJSON;
await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
try {
  const db = mongoose.connection.db;
  if (mode === 'capture') {
    const users = await db.collection('users').find({}, { projection: Object.fromEntries(fields.map((key) => [key, 1])) }).toArray();
    const assignments = await db.collection('accessassignments').find({}).toArray();
    const defaults = await db.collection('accessdefaults').find({}).toArray();
    const existing = await db.collection('roles').countDocuments({ code: { $in: codes } });
    assert.equal(existing, 0, 'Baseline role codes already exist; reconcile explicitly');
    assert.equal(assignments.length, 0, 'Existing assignments require a separate reviewed rollback');
    assert.equal(defaults.length, 0, 'Existing onboarding defaults require a separate reviewed rollback');
    await fs.writeFile(path, EJSON.stringify({ database: db.databaseName, codes, fields, users, assignments, defaults }), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ mode, users: users.length, databaseWrites: 0 }));
  } else {
    const state = EJSON.parse(await fs.readFile(path, 'utf8'));
    assert.equal(state.database, db.databaseName);
    assert.deepEqual(state.codes, codes);
    assert.deepEqual(state.fields, fields);
    assert.equal(state.assignments.length, 0);
    assert.equal(state.defaults.length, 0);
    const current = await db.collection('users').find({}, { projection: { _id: 1 } }).toArray();
    assert.deepEqual(current.map(({ _id }) => String(_id)).sort(), state.users.map(({ _id }) => String(_id)).sort(), 'User population changed; refuse automatic rollback');
    const roles = await db.collection('roles').find({ code: { $in: codes }, managed: true }).toArray();
    const roleIds = roles.map(({ _id }) => _id);
    const assignments = await db.collection('accessassignments').find({}).toArray();
    assert.ok(assignments.every((item) => roleIds.some((id) => id.equals(item.role)) && item.migrationKey === `${item.user}:${roles.find((role) => role._id.equals(item.role))?.code}`), 'Non-migration assignment found; refuse rollback');
    const defaults = await db.collection('accessdefaults').find({}).toArray();
    assert.ok(defaults.every((item) => item._id === 'onboarding' && Object.values(item.roles || {}).every((id) => roleIds.some((roleId) => roleId.equals(id)))), 'Defaults changed; refuse rollback');
    await db.collection('users').bulkWrite(state.users.map((user) => {
      const set = {}, unset = {};
      for (const key of fields) {
        if (Object.hasOwn(user, key)) set[key] = user[key];
        else unset[key] = '';
      }
      return { updateOne: { filter: { _id: user._id }, update: { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) } } };
    }));
    await db.collection('accessassignments').deleteMany({ _id: { $in: assignments.map(({ _id }) => _id) } });
    await db.collection('accessdefaults').deleteMany({ _id: 'onboarding' });
    await db.collection('roles').deleteMany({ _id: { $in: roleIds }, code: { $in: codes }, managed: true });
    console.log(JSON.stringify({ mode, users: state.users.length, financeChanged: false, auditPreserved: true }));
  }
} finally { await mongoose.disconnect(); }

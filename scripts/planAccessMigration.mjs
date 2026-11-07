// Snapshot/preflight never import application models or load .env.
import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import { isDeepStrictEqual } from 'node:util';
import { buildMigrationPlan, validateMigrationPlan } from '../utils/accessMigrationPlan.js';

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const planPath = arg('plan'), snapshotPath = arg('snapshot');
const apply = process.argv.includes('--apply'), preflight = process.argv.includes('--preflight');
const catalog = JSON.parse(await fs.readFile(new URL('../config/accessCatalog.generated.json', import.meta.url), 'utf8'));
if (apply && snapshotPath) throw new Error('Offline snapshots cannot be used to apply a migration');
if ((apply || preflight) && !planPath) throw new Error('Supply --plan=PATH');
if (apply && !arg('backup-reference')) throw new Error('Supply --backup-reference=REFERENCE for a separately verified fresh backup');
mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
try {
  let snapshot;
  if (snapshotPath) snapshot = JSON.parse((await fs.readFile(snapshotPath, 'utf8')).replace(/^\uFEFF/, ''));
  else {
    if (!process.env.MONGO_URI) throw new Error('Supply MONGO_URI explicitly; no .env is loaded');
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    const db = mongoose.connection.db;
    snapshot = {
      roles: await db.collection('roles').find({}, { projection: { name: 1, description: 1, permissions: 1, managed: 1 } }).toArray(),
      permissions: await db.collection('permissions').find({}, { projection: { name: 1 } }).toArray(),
      users: await db.collection('users').find({}, { projection: { role: 1, accountType: 1, disabledAt: 1, creation_pending: 1 } }).toArray(),
    };
  }
  if (!apply && !preflight) {
    const plan = buildMigrationPlan(snapshot, catalog);
    if (planPath) await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ mode: 'dry-run', roles: plan.roles.length, users: snapshot.users.length,
      unmapped: plan.roles.flatMap((role) => role.unmapped), output: planPath || 'Use --plan=PATH to save a reviewable plan', databaseWrites: 0 }));
  } else {
    const plan = JSON.parse((await fs.readFile(planPath, 'utf8')).replace(/^\uFEFF/, ''));
    const report = validateMigrationPlan(plan, snapshot.users, catalog, { applying: apply });
    if (!apply) {
      console.log(JSON.stringify({ mode: 'preflight', ...report, databaseWrites: 0 }));
      if (report.errors.length) process.exitCode = 1;
    } else {
      if (report.errors.length) throw new Error(report.errors.join('\n'));
      const [{ default: Role }, { default: User }, { default: Assignment }, { default: Audit }, { default: Defaults }] = await Promise.all([
        import('../models/roles.js'), import('../models/users.js'), import('../models/accessAssignment.js'),
        import('../models/accessAudit.js'), import('../models/accessDefaults.js'),
      ]);
      // Refuse changed policies before the first migration write.
      const roles = new Map();
      for (const item of plan.roles) {
        const existing = await Role.findOne({ code: item.code }).lean();
        if (existing) {
          const canonical = (grants) => grants.map(({ permission, scope, maxAmount, noSelfApproval, fields }) => ({
            permission, scope, maxAmount: maxAmount ?? null, noSelfApproval: Boolean(noSelfApproval), fields: fields || [],
          }));
          if (!existing.managed || existing.active === false || !isDeepStrictEqual(canonical(existing.grants), canonical(item.grants)))
            throw new Error(`Existing role differs from plan: ${item.code}. Review instead of overwriting.`);
          roles.set(item.code, existing);
        }
      }
      const defaults = await Defaults.findById('onboarding').lean();
      if (Object.keys(plan.defaults || {}).length && defaults)
        for (const [type, code] of Object.entries(plan.defaults)) if (String(defaults.roles?.[type]) !== String(roles.get(code)?._id))
          throw new Error('Existing onboarding defaults differ. Use revision-controlled administration.');
      await Role.createIndexes(); await Assignment.createIndexes();
      await Audit.create({ actor: plan.ownerUserIds[0], action: 'migration.intent', target: 'access-v2', reason: 'Explicit reviewed migration plan',
        after: { backupReference: arg('backup-reference'), roles: plan.roles.map(({ code, grants }) => ({ code, grants })), activateUsers: plan.activateUsers } });
      for (const id of plan.ownerUserIds) await User.updateOne({ _id: id }, { $set: { platformOwner: true, accountType: 'staff' } });
      let migrated = 0;
      for (const item of plan.roles) {
        let role = roles.get(item.code);
        if (!role) role = await Role.create({ code: item.code, name: item.name, description: item.description, grants: item.grants, managed: true, active: true });
        roles.set(item.code, role);
        for (const target of item.targets || []) {
          if (plan.ownerUserIds.includes(target.userId)) continue;
          const migrationKey = `${target.userId}:${item.code}`;
          await Assignment.updateOne({ migrationKey }, { $setOnInsert: { migrationKey, user: target.userId, role: role._id,
            assignedBy: plan.ownerUserIds[0], batchIds: [], courseIds: [] } }, { upsert: true });
          await User.updateOne({ _id: target.userId }, { $set: { accountType: target.accountType } });
          migrated++;
        }
      }
      if (Object.keys(plan.defaults || {}).length && !defaults) await Defaults.create({ _id: 'onboarding',
        roles: Object.fromEntries(Object.entries(plan.defaults).map(([type, code]) => [type, roles.get(code)._id])) });
      // Activation is last so an earlier failure leaves users in compatibility mode.
      if (plan.activateUsers) {
        const ids = [...new Set(plan.roles.flatMap((role) => (role.targets || []).map((target) => target.userId)))];
        await User.updateMany({ _id: { $in: ids } }, { $set: { accessManaged: true } });
      }
      await Audit.create({ actor: plan.ownerUserIds[0], action: 'migration.complete', target: 'access-v2', reason: 'Reviewed migration finished',
        after: { migrated, activated: Boolean(plan.activateUsers) } });
      console.log(JSON.stringify({ mode: 'apply', migrated, activated: Boolean(plan.activateUsers), financeChanged: false, passwordsChanged: false }));
    }
  }
} finally { await mongoose.disconnect(); }

import mongoose from 'mongoose';
import Defaults from '../models/accessDefaults.js';
import Role from '../models/roles.js';
import Assignment from '../models/accessAssignment.js';
import { legacyAccountType } from './accessPolicy.js';
import { accessContext } from './accessContext.js';

export async function defaultAccessPlan(user) {
  if ((process.env.AUTHORIZATION_MODE !== 'enforce' && !accessContext.getStore()?.enforced) || user.platformOwner || user.accessManaged) return null;
  const accountType = user.accountType || legacyAccountType(user.role);
  const defaults = await Defaults.findById('onboarding').lean();
  const roleId = defaults?.roles?.[accountType];
  const role = roleId ? await Role.findOne({ _id: roleId, active: true, managed: true }).select('_id').lean() : null;
  if (!role) throw Object.assign(new Error(`Configure an active default access role for ${accountType} accounts before creating them`), { status: 503 });
  return { accountType, role: role._id };
}
export async function applyDefaultAccess(user, plan) {
  if (!plan) return;
  await Assignment.updateOne({ migrationKey: `onboarding:${user._id}` }, { $setOnInsert: {
    user: user._id, role: plan.role, assignedBy: user._id, migrationKey: `onboarding:${user._id}`, batchIds: [], courseIds: [],
  } }, { upsert: true, writeConcern: { w: 1, j: true } });
  await mongoose.model('User').updateOne({ _id: user._id }, { $set: { accessManaged: true, accountType: plan.accountType }, $unset: { accessOnboardingRole: 1 } });
}
export async function repairDefaultAccess(user) {
  const pending = await mongoose.model('User').findById(user._id).select('+accessOnboardingRole').lean();
  if (!pending?.accessOnboardingRole) return;
  const role = await Role.findOne({ _id: pending.accessOnboardingRole, managed: true, active: true }).select('_id').lean();
  if (!role) throw Object.assign(new Error('Pending onboarding role is unavailable. Contact an access administrator.'), { status: 403 });
  const accountType = pending.accountType || legacyAccountType(pending.role);
  await applyDefaultAccess(pending, { role: role._id, accountType });
  user.accessManaged = true; user.accountType = accountType;
}

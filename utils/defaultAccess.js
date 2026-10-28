import mongoose from 'mongoose';
import Defaults from '../models/accessDefaults.js';
import Role from '../models/roles.js';
import Assignment from '../models/accessAssignment.js';
import { legacyAccountType, assertDelegable, canAssignAccess } from './accessPolicy.js';
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
// An administrator may pick the access role while creating the account instead of the category default.
export async function chosenAccessPlan(context, user, { roleId, batchIds = [], courseIds = [] }) {
  if (!canAssignAccess(context)) throw Object.assign(new Error('Choosing an access role requires permission to assign roles'), { status: 403 });
  if (!mongoose.isValidObjectId(roleId)) throw Object.assign(new Error('Choose a valid access role'), { status: 400 });
  const role = await Role.findOne({ _id: roleId, managed: true, active: true }).lean();
  if (!role) throw Object.assign(new Error('Choose an active access role'), { status: 400 });
  assertDelegable(context, role.grants);
  if (![batchIds, courseIds].every((list) => Array.isArray(list) && list.length <= 200 && list.every((id) => mongoose.isValidObjectId(id)))) throw Object.assign(new Error('Invalid assignment scope IDs'), { status: 400 });
  for (const [model, ids] of [['Batch', batchIds], ['Course', courseIds]]) {
    if (ids.length && await mongoose.models[model].countDocuments({ _id: { $in: ids } }) !== new Set(ids).size) throw Object.assign(new Error(`Unknown ${model} in scope`), { status: 400 });
  }
  if (role.grants.some((grant) => grant.scope === 'selected') && !batchIds.length && !courseIds.length) throw Object.assign(new Error('Choose the batches or courses this role applies to'), { status: 400 });
  return { accountType: user.accountType || legacyAccountType(user.role), role: role._id, assignedBy: context.userId, batchIds: batchIds.map(String), courseIds: courseIds.map(String) };
}
export async function applyDefaultAccess(user, plan) {
  if (!plan) return;
  await Assignment.updateOne({ migrationKey: `onboarding:${user._id}` }, { $setOnInsert: {
    user: user._id, role: plan.role, assignedBy: plan.assignedBy || user._id, migrationKey: `onboarding:${user._id}`, batchIds: plan.batchIds || [], courseIds: plan.courseIds || [],
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

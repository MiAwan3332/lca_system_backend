import express from 'express';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import auth from '../middlewares/auth.js';
import Role from '../models/roles.js';
import User from '../models/users.js';
import Assignment from '../models/accessAssignment.js';
import Audit from '../models/accessAudit.js';
import Defaults from '../models/accessDefaults.js';
import { accessCatalog, permissionKeys, lostSelfService } from '../utils/accessCatalog.js';
import { evaluateAccess, validateGrants, permissionGrants, legacyStaffManager, assertDelegable } from '../utils/accessPolicy.js';
import { loadAccessContext } from '../utils/accessRuntime.js';
import { verifyMediaTicket, policyFingerprint } from '../utils/accessMedia.js';
import { serveAuthorizedObject } from '../utils/fileStorage.js';
import { staffCommunication, staffProfileRules, STAFF_ROLE_CODES } from '../utils/staffRoleProfiles.js';

const router = express.Router();
const fail = (status, message) => Object.assign(new Error(message), { status });
const run = (handler) => async (req, res, next) => { try { await handler(req, res); } catch (error) { next(error); } };
const requireAccess = (permission) => (req, res, next) => {
  if (req.access.accountType !== 'staff' || !permissionGrants(req.access, permission).some((grant) => grant.scope === 'all')) {
    return res.status(403).json({ message: `Missing administration permission: ${permission}` });
  }
  next();
};
const pagination = (req) => ({ page: Math.max(1, Number(req.query.page) || 1), limit: Math.min(100, Math.max(1, Number(req.query.limit) || 25)) });
const page = async (model, filter, req, projection, populate) => {
  const { page: current, limit } = pagination(req);
  let query = model.find(filter).select(projection).sort({ _id: -1 }).skip((current - 1) * limit).limit(limit).lean();
  if (populate) query = query.populate(populate);
  const docs = await query;
  const totalDocs = await model.countDocuments(filter);
  return { docs, page: current, limit, totalDocs, totalPages: Math.ceil(totalDocs / limit), hasNextPage: current * limit < totalDocs };
};
const mayDelegate = assertDelegable;
const changeReason = (req) => {
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5 || reason.length > 1000) throw fail(400, 'A change reason of 5-1000 characters is required');
  return reason;
};
async function audit(req, action, target, before, after) {
  return new Audit({ actor: req.access.userId, action, target: String(target), requestId: req.requestId, before, after, reason: changeReason(req) })
    .save({ writeConcern: { w: 1, j: true } });
}
const PENDING_STAFF = 'lca-v1-pending-staff';
const activeAssignment = () => ({ revokedAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] });
const profileValue = (value) => {
  const profile = value ? String(value) : null;
  if (profile && !Object.values(STAFF_ROLE_CODES).includes(profile)) throw fail(400, 'Unknown built-in rules');
  return profile;
};
async function assignmentOptions(req, role) {
  const batchIds = req.body.batchIds || [], courseIds = req.body.courseIds || [];
  if (![batchIds, courseIds].every((list) => Array.isArray(list) && list.length <= 200 && list.every((id) => mongoose.isValidObjectId(id)))) throw fail(400, 'Invalid assignment scope IDs');
  for (const [model, ids] of [['Batch', batchIds], ['Course', courseIds]]) if (ids.length && await mongoose.models[model].countDocuments({ _id: { $in: ids } }) !== new Set(ids).size) throw fail(400, `Unknown ${model} in scope`);
  if (role.grants.some((grant) => grant.scope === 'selected') && !batchIds.length && !courseIds.length) throw fail(400, 'Choose the batches or courses this role applies to');
  const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) throw fail(400, 'Expiry must be in the future');
  const replaceRoleIds = (req.body.replaceRoleIds || []).map(String);
  if (!Array.isArray(req.body.replaceRoleIds || []) || replaceRoleIds.length > 20 || !replaceRoleIds.every((id) => mongoose.isValidObjectId(id))) throw fail(400, 'Invalid roles to replace');
  return { batchIds, courseIds, expiresAt, replaceRoleIds: replaceRoleIds.filter((id) => id !== String(role._id)), replacePending: Boolean(req.body.replacePending) };
}
const sameIds = (left = [], right = []) => left.length === right.length && left.map(String).every((id) => right.map(String).includes(id));
const grantsOf = (items) => items.filter((item) => item.role && item.role.active !== false).flatMap((item) => item.role.grants || []);
// Decides one person's change without writing anything. Every refusal is a reason for that person only.
async function planAssignment(req, user, role, options) {
  if (user.platformOwner) return { skipped: 'Protected platform owner', status: 403 };
  const current = await Assignment.find({ user: user._id, ...activeAssignment() }).populate('role', 'name code grants active').lean();
  const holds = current.some((item) => String(item.role?._id) === String(role._id) && sameIds(item.batchIds, options.batchIds) && sameIds(item.courseIds, options.courseIds) && !item.expiresAt && !options.expiresAt);
  const replaced = current.filter((item) => item.role && options.replaceRoleIds.includes(String(item.role._id)));
  let pending = options.replacePending ? current.filter((item) => item.role?.code === PENDING_STAFF && String(item.role._id) !== String(role._id) && !replaced.includes(item)) : [];
  const after = (removed) => [...grantsOf(current.filter((item) => !removed.includes(item))), ...role.grants];
  const refusal = (items) => { for (const item of items) { try { mayDelegate(req.access, item.role.grants); } catch { return `You cannot remove ${item.role.name}; it includes access you do not hold`; } } return null; };
  if (refusal(replaced)) return { skipped: refusal(replaced), status: 403 };
  // A move must not take away their own profile, photo, password or notifications; the admin picks a role that includes them.
  const lost = lostSelfService(grantsOf(current), after(replaced));
  if (replaced.length && lost.length) return { skipped: `${role.name} would stop them being able to ${lost.join(', ')}`, status: 409 };
  // The pending role is left in place rather than removing those abilities, or when this administrator may not remove it.
  const keptPending = pending.length > 0 && (lostSelfService(grantsOf(current), after([...replaced, ...pending])).length > 0 || Boolean(refusal(pending)));
  if (keptPending) pending = [];
  const revoke = [...replaced, ...pending];
  if (holds && !revoke.length) return { skipped: 'Already has this role', status: 409 };
  return { create: !holds, revoke, keptPending };
}
async function revokeOne(req, item) {
  const { role: storedRole, ...stored } = item, before = { ...stored, role: storedRole?._id || storedRole };
  await audit(req, 'assignment.revoke.intent', item._id, before, { ...before, revokedAt: new Date() });
  await Assignment.updateOne({ _id: item._id, revokedAt: null }, { $set: { revokedAt: new Date() } }, { writeConcern: { w: 1, j: true } });
}
async function applyAssignment(req, user, role, options, plan) {
  let assignment = null;
  if (plan.create) {
    assignment = new Assignment({ user: user._id, role: role._id, batchIds: options.batchIds, courseIds: options.courseIds, expiresAt: options.expiresAt, assignedBy: req.access.userId });
    await audit(req, 'assignment.create.intent', assignment._id, null, assignment.toObject());
    // Failing between these writes denies access; it cannot retain a legacy privilege bypass.
    await User.updateOne({ _id: user._id }, { $set: { accessManaged: true } }, { writeConcern: { w: 1, j: true } });
    await assignment.save({ writeConcern: { w: 1, j: true } });
  }
  // The new role is saved first, so an interruption leaves both roles rather than none.
  for (const item of plan.revoke) await revokeOne(req, item);
  return assignment;
}
const safeUser = '_id name email role accountType accessManaged platformOwner disabledAt';
router.get('/media', run(async (req, res) => {
  let ticket;
  try { ticket = verifyMediaTicket(req.query.ticket); } catch { throw fail(403, 'Media access expired or invalid'); }
  const user = await User.findById(ticket.userId).select('-password').lean();
  if (!user) throw fail(403, 'Media access revoked');
  const context = await loadAccessContext(user);
  if (context.disabled || policyFingerprint(context) !== ticket.policy || !permissionGrants(context, ticket.permission).length ||
    !permissionGrants(context, 'files.download').length) throw fail(403, 'Media access revoked');
  return serveAuthorizedObject(ticket.key, res, (error) => { if (error) res.status(error.status || 502).send('Unable to read protected file'); });
}));
router.use(auth);
router.get('/account-categories', run(async (req, res) => {
  const allowed = req.access.owner || (req.access.accountType === 'staff' && (req.access.enforced
    ? ['users.add.user', 'users.update.user'].some((permission) => permissionGrants(req.access, permission).some((grant) => grant.scope === 'all'))
    : legacyStaffManager(req.accessUser?.role)));
  if (!allowed) throw fail(403, 'Staff-account management permission is required');
  res.json(await page(Role, { managed: { $ne: true }, name: { $not: /secrate|super.?admin/i } }, req, '_id name'));
}));
router.get('/me', run(async (req, res) => {
  res.set('Cache-Control', 'no-store').json({ userId: req.access.userId, managed: req.access.enforced, owner: req.access.owner,
    accountType: req.access.accountType, panelistId:req.access.panelistId, panelistActive:req.access.panelistActive, roles: req.access.roles, grants: req.access.grants, communication: staffCommunication(req.access),
    routes: accessCatalog.routes.filter((route) => !route.public && !route.blocked && permissionGrants(req.access, route.permission).length)
      .map(({ method, path, resource, permission }) => ({ method, path, resource, permission })) });
}));
router.get('/catalog', requireAccess('access.read'), run(async (req, res) => res.json(accessCatalog)));
router.get('/defaults', requireAccess('access.manage'), run(async (req, res) => res.json(await Defaults.findById('onboarding').lean() || { roles: {}, revision: 0 })));
router.put('/defaults', requireAccess('access.manage'), run(async (req, res) => {
  if (!req.access.owner) throw fail(403, 'Only the protected owner can change automatic onboarding access');
  const roles = req.body.roles || {};
  for (const [type, id] of Object.entries(roles)) {
    if (!['staff', 'student', 'teacher', 'qualifier', 'panelist'].includes(type) || !mongoose.isValidObjectId(id) ||
      !await Role.exists({ _id: id, managed: true, active: true })) throw fail(400, 'Invalid default account role');
  }
  const previous = await Defaults.findById('onboarding').lean();
  if ((previous?.revision || 0) !== Number(req.body.revision)) throw fail(409, 'Defaults changed. Reload.');
  await audit(req, 'defaults.update.intent', 'onboarding', previous, { roles });
  const result = await Defaults.findOneAndUpdate({ _id: 'onboarding', ...(previous ? { revision: previous.revision } : {}) },
    { $set: { roles }, $inc: { revision: 1 } }, { upsert: !previous, new: true });
  if (!result) throw fail(409, 'Defaults changed. Reload.'); res.json(result);
}));
router.get('/roles', requireAccess('access.read'), run(async (req, res) => {
  const query = String(req.query.query || '').trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const result = await page(Role, { managed: true, ...(query ? { name: new RegExp(query, 'i') } : {}) }, req);
  const counts = await Assignment.aggregate([
    { $match: { role: { $in: result.docs.map((role) => role._id) }, revokedAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] } },
    { $group: { _id: { role: '$role', user: '$user' } } }, { $group: { _id: '$_id.role', count: { $sum: 1 } } },
  ]);
  res.json({ ...result, docs: result.docs.map((role) => ({ ...role, memberCount: counts.find((item) => String(item._id) === String(role._id))?.count || 0 })) });
}));
router.get('/roles/:id', requireAccess('access.read'), run(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw fail(400, 'Invalid role');
  const role = await Role.findOne({ _id: req.params.id, managed: true }).lean();
  if (!role) throw fail(404, 'Role not found'); res.json(role);
}));
router.get('/rule-profiles', requireAccess('access.read'), run(async (req, res) => res.json(staffProfileRules())));
router.get('/roles/:id/members', requireAccess('access.assign'), run(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw fail(400, 'Invalid role');
  if (!await Role.exists({ _id: req.params.id, managed: true })) throw fail(404, 'Role not found');
  const query = String(req.query.query || '').trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const filter = { role: req.params.id, ...activeAssignment() };
  if (query) filter.user = { $in: (await User.find({ $or: [{ name: new RegExp(query, 'i') }, { email: new RegExp(query, 'i') }] }).select('_id').limit(1000).lean()).map((user) => user._id) };
  const result = await page(Assignment, filter, req, undefined, { path: 'user', select: safeUser });
  const batchIds = result.docs.flatMap((item) => item.batchIds), courseIds = result.docs.flatMap((item) => item.courseIds);
  const [batches, courses] = await Promise.all([
    mongoose.models.Batch.find({ _id: { $in: batchIds } }).select('_id name').lean(),
    mongoose.models.Course.find({ _id: { $in: courseIds } }).select('_id name').lean(),
  ]);
  const named = (ids, items, missing) => ids.map((id) => ({ _id: id, name: items.find((item) => String(item._id) === String(id))?.name || missing }));
  res.json({ ...result, docs: result.docs.map((item) => ({ ...item, batches: named(item.batchIds, batches, 'Unavailable batch'), courses: named(item.courseIds, courses, 'Unavailable course') })) });
}));
router.get('/scopes/:type', requireAccess('access.assign'), run(async (req, res) => {
  const model = { batches: mongoose.models.Batch, courses: mongoose.models.Course }[req.params.type];
  if (!model) throw fail(404, 'Unknown scope type');
  const query = String(req.query.query || '').slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  res.json(await page(model, query ? { name: new RegExp(query, 'i') } : {}, req, '_id name'));
}));
router.get('/users', requireAccess('access.assign'), run(async (req, res) => {
  const query = String(req.query.query || '').trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const filters = query ? [{ $or: [{ name: new RegExp(query, 'i') }, { email: new RegExp(query, 'i') }] }] : [];
  const category = String(req.query.category || '');
  const status = String(req.query.status || '');
  if (category && !['staff', 'student', 'teacher', 'qualifier', 'panelist'].includes(category)) throw fail(400, 'Invalid account category');
  if (status && !['active', 'inactive'].includes(status)) throw fail(400, 'Invalid account status');
  if (category) filters.push({ $or: [{ accountType: category }, { accountType: { $in: [null, ''] },
    role: category === 'staff' ? { $not: /^(student|teacher|qualifier|panelist)$/i } : new RegExp(`^${category}$`, 'i') }] });
  if (status) filters.push({ disabledAt: status === 'active' ? null : { $ne: null } });
  const filter = filters.length ? { $and: filters } : {};
  const result = await page(User, filter, req, safeUser);
  const assignments = await Assignment.find({ user: { $in: result.docs.map((user) => user._id) }, revokedAt: null,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }).populate('role', 'name active code').lean();
  res.json({ ...result, docs: result.docs.map((user) => ({ ...user, accessRoles: assignments.filter((item) => String(item.user) === String(user._id) && item.role?.active).map((item) => ({ _id: item.role._id, name: item.role.name, code: item.role.code })) })) });
}));
router.get('/users/:id/effective', requireAccess('access.assign'), run(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw fail(400, 'Invalid user');
  const user = await User.findById(req.params.id).select(safeUser).lean();
  if (!user) throw fail(404, 'User not found');
  const context = await loadAccessContext(user, { repair: false });
  res.json({ user, managed: context.enforced, owner: context.owner, disabled: context.disabled, grants: context.grants, roles: context.roles });
}));
router.get('/assignments/:userId', requireAccess('access.assign'), run(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.userId)) throw fail(400, 'Invalid user');
  const result = await page(Assignment, { user: req.params.userId, revokedAt: null }, req, undefined, { path: 'role', select: 'name code active revision' });
  const batchIds = result.docs.flatMap((item) => item.batchIds), courseIds = result.docs.flatMap((item) => item.courseIds);
  const [batches, courses] = await Promise.all([
    mongoose.models.Batch.find({ _id: { $in: batchIds } }).select('_id name').lean(),
    mongoose.models.Course.find({ _id: { $in: courseIds } }).select('_id name').lean(),
  ]);
  res.json({ ...result, docs: result.docs.map((item) => ({ ...item,
    batches: item.batchIds.map((id) => ({ _id: id, name: batches.find((batch) => String(batch._id) === String(id))?.name || 'Unavailable batch' })),
    courses: item.courseIds.map((id) => ({ _id: id, name: courses.find((course) => String(course._id) === String(id))?.name || 'Unavailable course' })),
  })) });
}));
router.get('/audit', requireAccess('access.audit'), run(async (req, res) => {
  const result = await page(Audit, {}, req, undefined, { path: 'actor', select: 'name email' });
  const sides = result.docs.flatMap((item) => [item.before, item.after]).filter(Boolean);
  const validIds = (values) => [...new Set(values.filter((value) => mongoose.isValidObjectId(value)).map(String))];
  const roleIds = validIds(sides.flatMap((side) => [side.role, ...(!Array.isArray(side.roles) ? Object.values(side.roles || {}) : [])]));
  const userIds = validIds(sides.map((side) => side.user));
  const [roles, users] = await Promise.all([Role.find({ _id: { $in: roleIds } }).select('_id name').lean(), User.find({ _id: { $in: userIds } }).select('_id name').lean()]);
  const named = (side) => side ? { ...side,
    ...(side.role ? { roleName: roles.find((role) => String(role._id) === String(side.role))?.name || 'Unavailable role' } : {}),
    ...(side.user ? { userName: users.find((user) => String(user._id) === String(side.user))?.name || 'Unavailable person' } : {}),
    ...(!Array.isArray(side.roles) && side.roles ? { defaultNames: Object.fromEntries(Object.entries(side.roles).map(([type, id]) => [type, roles.find((role) => String(role._id) === String(id))?.name || 'Unavailable role'])) } : {}),
  } : side;
  res.json({ ...result, docs: result.docs.map((item) => ({ ...item, before: named(item.before), after: named(item.after) })) });
}));
router.post('/explain', requireAccess('access.explain'), run(async (req, res) => {
  if (!permissionKeys.has(req.body.permission)) throw fail(400, 'Unknown permission');
  const user = await User.findById(req.body.userId).select('-password').lean();
  if (!user) throw fail(404, 'User not found');
  const context = await loadAccessContext(user, { repair: false });
  res.json({ ...evaluateAccess(context, req.body.permission, req.body.resource || {}), enforced: context.enforced,
    roles: context.roles, note: 'This explains the supplied record context; actual operations also enforce ownership and business invariants.' });
}));
router.post('/roles', requireAccess('access.manage'), run(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name || name.length > 100) throw fail(400, 'Role name is required (maximum 100 characters)');
  const grants = validateGrants(req.body.grants, permissionKeys); mayDelegate(req.access, grants);
  // Built-in rules only add restrictions, so a copy may keep the rules of the role it was copied from.
  const role = new Role({ name, description: String(req.body.description || '').slice(0, 2000), managed: true,
    code: crypto.randomUUID(), grants, active: req.body.active !== false, revision: 1, profile: profileValue(req.body.profile) });
  await audit(req, 'role.create.intent', role._id, null, role.toObject());
  await role.save({ writeConcern: { w: 1, j: true } });
  res.status(201).json(role);
}));
router.put('/roles/:id', requireAccess('access.manage'), run(async (req, res) => {
  const before = await Role.findOne({ _id: req.params.id, managed: true }).lean();
  if (!before) throw fail(404, 'Managed role not found');
  const grants = validateGrants(req.body.grants, permissionKeys); mayDelegate(req.access, before.grants); mayDelegate(req.access, grants);
  const name = String(req.body.name || '').trim();
  if (!name || name.length > 100) throw fail(400, 'Invalid role name');
  const profile = Object.values(STAFF_ROLE_CODES).includes(before.code) ? null : req.body.profile === undefined ? before.profile ?? null : profileValue(req.body.profile);
  if (profile !== (before.profile ?? null) && !req.access.owner) throw fail(403, 'Only the protected owner can change built-in rules');
  const after = { name, description: String(req.body.description || '').slice(0, 2000), grants, active: req.body.active !== false, profile };
  if (Number(req.body.revision) !== before.revision) throw fail(409, 'Role changed. Reload before editing.');
  await audit(req, 'role.update.intent', before._id, before, { ...before, ...after, revision: before.revision + 1 });
  const result = await Role.findOneAndUpdate({ _id: before._id, revision: before.revision }, { $set: after, $inc: { revision: 1 } },
    { new: true, writeConcern: { w: 1, j: true } });
  if (!result) throw fail(409, 'Role changed. Reload before editing.');
  res.json(result);
}));
router.post('/roles/:id/preview', requireAccess('access.manage'), run(async (req, res) => {
  const role = await Role.findById(req.params.id).lean(); if (!role) throw fail(404, 'Role not found');
  const grants = validateGrants(req.body.grants, permissionKeys); mayDelegate(req.access, grants);
  const oldKeys = new Set(role.grants.map((grant) => JSON.stringify(grant)));
  const newKeys = new Set(grants.map((grant) => JSON.stringify(grant)));
  const defaults = await Defaults.findById('onboarding').lean();
  res.json({ activeAssignments: await Assignment.countDocuments({ role: role._id, revokedAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }),
    onboardingDefaults: Object.entries(defaults?.roles || {}).filter(([, id]) => String(id) === String(role._id)).map(([type]) => type),
    added: grants.filter((grant) => !oldKeys.has(JSON.stringify(grant))), removed: role.grants.filter((grant) => !newKeys.has(JSON.stringify(grant))) });
}));
router.post('/assignments', requireAccess('access.assign'), run(async (req, res) => {
  const user = await User.findById(req.body.userId).select(safeUser).lean();
  const role = await Role.findOne({ _id: req.body.roleId, managed: true, active: true }).lean();
  if (!user || !role) throw fail(404, 'User or active managed role not found');
  if (user.platformOwner) throw fail(403, 'Platform-owner assignments are protected; use the offline recovery procedure');
  mayDelegate(req.access, role.grants); changeReason(req);
  const options = await assignmentOptions(req, role);
  const plan = await planAssignment(req, user, role, options);
  if (plan.skipped) throw fail(plan.status, plan.skipped === 'Already has this role' ? `${user.name || 'This person'} already has this role` : plan.skipped);
  const assignment = await applyAssignment(req, user, role, options, plan);
  res.status(201).json({ ...(assignment ? assignment.toObject() : {}), alreadyHad: !plan.create, revoked: plan.revoke.length, keptPending: plan.keptPending });
}));
// Assign one role to many people, optionally moving them out of other roles or the pending staff role.
router.post('/assignments/bulk', requireAccess('access.assign'), run(async (req, res) => {
  const userIds = [...new Set((req.body.userIds || []).map(String))];
  if (!Array.isArray(req.body.userIds) || !userIds.length || userIds.length > 100 || !userIds.every((id) => mongoose.isValidObjectId(id))) throw fail(400, 'Choose between 1 and 100 people');
  const role = await Role.findOne({ _id: req.body.roleId, managed: true, active: true }).lean();
  if (!role) throw fail(404, 'Active managed role not found');
  mayDelegate(req.access, role.grants); changeReason(req);
  const options = await assignmentOptions(req, role);
  const users = await User.find({ _id: { $in: userIds } }).select(safeUser).lean();
  const result = { assigned: [], skipped: [], failed: [], revoked: 0, keptPending: [] };
  // Check everyone first; nobody is changed while a later person could still turn the request into an error.
  const plans = [];
  for (const id of userIds) {
    const user = users.find((item) => String(item._id) === id);
    if (!user) { result.skipped.push({ userId: id, name: 'Unavailable person', reason: 'Not found' }); continue; }
    const plan = await planAssignment(req, user, role, options);
    if (plan.skipped) result.skipped.push({ userId: id, name: user.name, reason: plan.skipped }); else plans.push({ id, user, plan });
  }
  for (const { id, user, plan } of plans) {
    try { await applyAssignment(req, user, role, options, plan); }
    catch { result.failed.push({ userId: id, name: user.name, reason: 'The change could not be saved. Open this person to check their roles, then try again.' }); continue; }
    result.assigned.push({ userId: id, name: user.name, ...(plan.create ? {} : { alreadyHad: true }) }); result.revoked += plan.revoke.length;
    if (plan.keptPending) result.keptPending.push({ userId: id, name: user.name });
  }
  res.status(result.assigned.length ? 201 : 200).json(result);
}));
async function revocationRefusal(req, assignment) {
  const user = await User.findById(assignment.user).select('platformOwner').lean();
  if (user?.platformOwner) return 'Protected platform owner';
  const role = await Role.findById(assignment.role).lean();
  try { mayDelegate(req.access, role?.grants || []); } catch { return `You cannot remove ${role?.name || 'this role'}; it includes access you do not hold`; }
  return null;
}
router.post('/assignments/revoke', requireAccess('access.assign'), run(async (req, res) => {
  const ids = [...new Set((req.body.assignmentIds || []).map(String))];
  if (!Array.isArray(req.body.assignmentIds) || !ids.length || ids.length > 100 || !ids.every((id) => mongoose.isValidObjectId(id))) throw fail(400, 'Choose between 1 and 100 assignments');
  changeReason(req);
  const assignments = await Assignment.find({ _id: { $in: ids }, revokedAt: null }).lean();
  const result = { revoked: 0, failed: [], skipped: ids.filter((id) => !assignments.some((item) => String(item._id) === id)).map((id) => ({ assignmentId: id, reason: 'Already removed' })) };
  const allowed = [];
  for (const assignment of assignments) {
    const refusal = await revocationRefusal(req, assignment);
    if (refusal) result.skipped.push({ assignmentId: String(assignment._id), reason: refusal }); else allowed.push(assignment);
  }
  for (const assignment of allowed) {
    try { await revokeOne(req, assignment); result.revoked++; }
    catch { result.failed.push({ assignmentId: String(assignment._id), reason: 'Could not be removed. Try again.' }); }
  }
  res.json(result);
}));
router.delete('/assignments/:id', requireAccess('access.assign'), run(async (req, res) => {
  const assignment = await Assignment.findById(req.params.id).lean(); if (!assignment) throw fail(404, 'Assignment not found');
  const refusal = await revocationRefusal(req, assignment); if (refusal) throw fail(403, refusal);
  await revokeOne(req, assignment);
  res.json({ revoked: true });
}));
export default router;

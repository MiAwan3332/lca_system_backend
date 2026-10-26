import express from 'express';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import auth from '../middlewares/auth.js';
import Role from '../models/roles.js';
import User from '../models/users.js';
import Assignment from '../models/accessAssignment.js';
import Audit from '../models/accessAudit.js';
import Defaults from '../models/accessDefaults.js';
import { accessCatalog, permissionKeys } from '../utils/accessCatalog.js';
import { evaluateAccess, validateGrants, permissionGrants, legacyStaffManager } from '../utils/accessPolicy.js';
import { loadAccessContext } from '../utils/accessRuntime.js';
import { verifyMediaTicket, policyFingerprint } from '../utils/accessMedia.js';
import { serveAuthorizedObject } from '../utils/fileStorage.js';

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
function mayDelegate(context, grants) {
  if (context.owner) return;
  for (const grant of grants) {
    if (!context.grants.some((held) => held.permission === grant.permission && held.scope === 'all' &&
      (held.maxAmount == null || (grant.maxAmount != null && grant.maxAmount <= held.maxAmount)) && (!held.noSelfApproval || grant.noSelfApproval) &&
      (!held.fields?.length || (grant.fields?.length && grant.fields.every((field) => held.fields.includes(field)))))) {
      throw fail(403, `You cannot delegate broader access than you hold: ${grant.permission}`);
    }
  }
}
async function audit(req, action, target, before, after) {
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5 || reason.length > 1000) throw fail(400, 'A change reason of 5-1000 characters is required');
  return new Audit({ actor: req.access.userId, action, target: String(target), requestId: req.requestId, before, after, reason })
    .save({ writeConcern: { w: 1, j: true } });
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
    accountType: req.access.accountType, roles: req.access.roles, grants: req.access.grants,
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
router.get('/roles', requireAccess('access.read'), run(async (req, res) => res.json(await page(Role, { managed: true }, req))));
router.get('/roles/:id', requireAccess('access.read'), run(async (req, res) => {
  const role = await Role.findOne({ _id: req.params.id, managed: true }).lean();
  if (!role) throw fail(404, 'Role not found'); res.json(role);
}));
router.get('/scopes/:type', requireAccess('access.assign'), run(async (req, res) => {
  const model = { batches: mongoose.models.Batch, courses: mongoose.models.Course }[req.params.type];
  if (!model) throw fail(404, 'Unknown scope type');
  const query = String(req.query.query || '').slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  res.json(await page(model, query ? { name: new RegExp(query, 'i') } : {}, req, '_id name'));
}));
router.get('/users', requireAccess('access.assign'), run(async (req, res) => {
  const query = String(req.query.query || '').trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const filter = query ? { $or: [{ name: new RegExp(query, 'i') }, { email: new RegExp(query, 'i') }] } : {};
  res.json(await page(User, filter, req, safeUser));
}));
router.get('/assignments/:userId', requireAccess('access.assign'), run(async (req, res) => {
  res.json(await page(Assignment, { user: req.params.userId, revokedAt: null }, req, undefined, { path: 'role', select: 'name code active revision' }));
}));
router.get('/audit', requireAccess('access.audit'), run(async (req, res) => res.json(await page(Audit, {}, req, undefined, { path: 'actor', select: 'name email' }))));
router.post('/explain', requireAccess('access.explain'), run(async (req, res) => {
  if (!permissionKeys.has(req.body.permission)) throw fail(400, 'Unknown permission');
  const user = await User.findById(req.body.userId).select('-password').lean();
  if (!user) throw fail(404, 'User not found');
  const context = await loadAccessContext(user);
  res.json({ ...evaluateAccess(context, req.body.permission, req.body.resource || {}), enforced: context.enforced,
    roles: context.roles, note: 'This explains the supplied record context; actual operations also enforce ownership and business invariants.' });
}));
router.post('/roles', requireAccess('access.manage'), run(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name || name.length > 100) throw fail(400, 'Role name is required (maximum 100 characters)');
  const grants = validateGrants(req.body.grants, permissionKeys); mayDelegate(req.access, grants);
  const role = new Role({ name, description: String(req.body.description || '').slice(0, 2000), managed: true,
    code: crypto.randomUUID(), grants, active: req.body.active !== false, revision: 1 });
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
  const after = { name, description: String(req.body.description || '').slice(0, 2000), grants, active: req.body.active !== false };
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
  mayDelegate(req.access, role.grants);
  const batchIds = req.body.batchIds || [], courseIds = req.body.courseIds || [];
  if (![batchIds, courseIds].every((list) => Array.isArray(list) && list.length <= 200 && list.every((id) => mongoose.isValidObjectId(id)))) throw fail(400, 'Invalid assignment scope IDs');
  for (const [model, ids] of [['Batch', batchIds], ['Course', courseIds]]) if (ids.length && await mongoose.models[model].countDocuments({ _id: { $in: ids } }) !== new Set(ids).size) throw fail(400, `Unknown ${model} in scope`);
  const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) throw fail(400, 'Expiry must be in the future');
  const assignment = new Assignment({ user: user._id, role: role._id, batchIds, courseIds, expiresAt, assignedBy: req.access.userId });
  await audit(req, 'assignment.create.intent', assignment._id, null, assignment.toObject());
  // Failing between these writes denies access; it cannot retain a legacy privilege bypass.
  await User.updateOne({ _id: user._id }, { $set: { accessManaged: true } }, { writeConcern: { w: 1, j: true } });
  await assignment.save({ writeConcern: { w: 1, j: true } });
  res.status(201).json(assignment);
}));
router.delete('/assignments/:id', requireAccess('access.assign'), run(async (req, res) => {
  const assignment = await Assignment.findById(req.params.id).lean(); if (!assignment) throw fail(404, 'Assignment not found');
  const user = await User.findById(assignment.user).select('platformOwner').lean();
  if (user?.platformOwner) throw fail(403, 'Protected platform owner');
  const role = await Role.findById(assignment.role).lean(); mayDelegate(req.access, role?.grants || []);
  await audit(req, 'assignment.revoke.intent', assignment._id, assignment, { ...assignment, revokedAt: new Date() });
  await Assignment.updateOne({ _id: assignment._id, revokedAt: null }, { $set: { revokedAt: new Date() } }, { writeConcern: { w: 1, j: true } });
  res.json({ revoked: true });
}));
export default router;

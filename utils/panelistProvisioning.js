import {DEFAULT_STAFF_PASSWORD} from './creationDefaults.js';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import Panelist from '../models/panelists.js';
import User from '../models/users.js';
import Role from '../models/roles.js';
import Assignment from '../models/accessAssignment.js';
import Defaults from '../models/accessDefaults.js';
import { repairDefaultAccess } from './defaultAccess.js';
import { accessContext } from './accessContext.js';
import { withInterviewLock, interviewError } from './interviewLock.js';

export const panelistPhone = value => String(value || '').replace(/\D/g, '').slice(-10);
export async function panelistIdentity({ phone, email }) {
  return accessContext.run(undefined, async () => {
    const normalized = panelistPhone(phone);
    if (normalized.length !== 10) throw interviewError(400, 'Enter a valid phone number with at least ten digits');
    const regex = new RegExp(`${normalized.split('').join('\\D*')}$`);
    const address = String(email || '').trim().toLowerCase();
    const profiles = await Panelist.find({ $or: [{ normalized_phone: normalized }, { phone: regex }, ...(address ? [{ email: address }] : [])] }).limit(3);
    if (profiles.length > 1) throw interviewError(409, 'Multiple panelist profiles match. Resolve the duplicate profiles first.');
    const profile = profiles[0];
    const userIds = [], emails = new Set(address ? [address] : []);
    if (profile?.user) userIds.push(profile.user);
    if (profile?.email) emails.add(profile.email);
    // Older teacher/student profiles can hold a phone which is missing from the login user.
    for (const name of ['teachers', 'students', 'qualifiers']) {
      const matches = await mongoose.connection.db.collection(name).find({ phone: regex }, { projection: { user: 1, email: 1 } }).limit(4).toArray();
      for (const p of matches) { if (p.user) userIds.push(p.user); if (p.email) emails.add(p.email); }
    }
    const addresses=[...emails].map(value=>new RegExp('^'+String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$','i'));
    const users = await User.find({ $or: [{ phone: regex }, { _id: { $in: userIds } }, { email: { $in: addresses } },
      { email: `panelist.${normalized}@lca.local` }] }).select('-password').limit(3);
    if (users.length > 1) throw interviewError(409, 'This phone/email matches different login users. Resolve the identity conflict first.');
    const user = users[0];
    if (user?.disabledAt) throw interviewError(409, 'The existing login is disabled. An access administrator must review it.');
    if (user && await Panelist.exists({ user: user._id, ...(profile ? { _id: { $ne: profile._id } } : {}) })) throw interviewError(409, 'This login already belongs to another panelist profile.');
    return { normalized, profile, user };
  });
}

export async function provisionPanelist(req, { profileId } = {}) {
  return withInterviewLock('panelist-provisioning', () => accessContext.run(undefined, async () => {
    const supplied = req.body || {};
    const stored = profileId ? await Panelist.findById(profileId) : null;
    if (profileId && !stored) throw interviewError(404, 'Panelist not found');
    const identity = await panelistIdentity({ phone: stored?.phone || supplied.phone, email: supplied.email || stored?.email });
    let panelist = stored || identity.profile, user = identity.user;
    const defaults = await Defaults.findById('onboarding').lean();
    const roleId=panelist?.access_role || defaults?.roles?.panelist;
    const role = roleId ? await Role.findOne({ _id: roleId, active: true, managed: true }) : null;
    if (!role) throw interviewError(503, 'Configure an active default Interview Panelist role in Access Management first.');
    if (user && !user.accessManaged && !user.platformOwner) {
      await repairDefaultAccess(user);
      const current = await Assignment.exists({ user: user._id, revokedAt: null });
      if (!current) throw interviewError(409, 'Migrate this existing login to Access Management before adding panelist access. Its current access has been preserved.');
      await User.updateOne({ _id: user._id }, { $set: { accessManaged: true } });
    }
    const createdUser = !user;
    if (!user) {
      const initial = DEFAULT_STAFF_PASSWORD;
      user = await User.create({ name: stored?.name || supplied.name, phone: stored?.phone || supplied.phone,
        email: String(supplied.email || stored?.email || `panelist.${identity.normalized}@lca.local`).trim().toLowerCase(),
        role: 'panelist', accountType: 'panelist', password: await bcrypt.hash(initial, 12) });
    }
    if (!panelist) panelist = await Panelist.create({ name: supplied.name, phone: supplied.phone, description: supplied.description,
      normalized_phone: identity.normalized, user: user._id, email: user.email,
      is_active: !['false', '0', false].includes(supplied.is_active) });
    else {
      panelist.user = user._id; panelist.email = user.email; panelist.normalized_phone = identity.normalized;
      await panelist.save();
    }
    // Finish only the unusable generated login from the previous rollout. Shared logins stay unchanged.
    if(!createdUser && panelist.login_setup_required && user.accountType==='panelist'){
      user.password=await bcrypt.hash(DEFAULT_STAFF_PASSWORD,12);await user.save();
    }
    if(panelist.login_setup_required){panelist.login_setup_required=false;await panelist.save();}
    let assigned = await Assignment.findOne({ user: user._id, role: role._id, revokedAt: null,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] });
    if (!assigned) assigned = await Assignment.findOneAndUpdate({ migrationKey: `panelist-membership:${panelist._id}` },
      { $set: { user: user._id, role: role._id, assignedBy: req.access?.userId || user._id, revokedAt: null, expiresAt: null } }, { upsert: true, new: true });
    if (assigned.migrationKey === `panelist-membership:${panelist._id}`) {
      panelist.access_assignment = assigned._id; await panelist.save();
    }
    panelist.access_role=role._id;await panelist.save();
    return { panelist, user, createdUser, existingPanelist: Boolean(stored || identity.profile), roleName: role.name };
  }));
}

export async function lookupPanelistIdentity(req, res) {
  try {
    const { user, profile } = await panelistIdentity(req.body || {});
    const assignments = user ? await accessContext.run(undefined, async () => await Assignment.find({ user: user._id, revokedAt: null }).populate('role', 'name').lean()) : [];
    res.set('Cache-Control', 'no-store').json({ found: Boolean(user), existing_panelist: Boolean(profile), needs_login: !user || Boolean(profile?.login_setup_required),
      existing_user: user ? { name: user.name, email: user.email, accessRoleNames: assignments.map(a => a.role?.name).filter(Boolean) } : null });
  } catch (error) { res.status(error.status || 500).json({ message: error.message }); }
}

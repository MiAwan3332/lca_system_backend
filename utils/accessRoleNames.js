import AccessAssignment from '../models/accessAssignment.js';
import Role from '../models/roles.js';
import { accessContext } from './accessContext.js';

// Adds accessRoleNames: the active Access Management roles each user holds, shown in place of the legacy role text.
// Runs outside the caller's record scope: the users were already authorized, and their role names come with them.
// The protected owner holds no assignments and is labelled Owner.
export function withAccessRoleNames(users) {
  return accessContext.run(undefined, async () => {
    const list = users.map((user) => (user?.toObject ? user.toObject() : user));
    const ids = list.map((user) => user?._id).filter(Boolean);
    if (!ids.length) return list;
    const assignments = await AccessAssignment.find({ user: { $in: ids }, revokedAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] })
      .select('user role').lean();
    const roles = await Role.find({ _id: { $in: [...new Set(assignments.map((item) => String(item.role)))] }, managed: true, active: true }).select('name').lean();
    const names = new Map(roles.map((role) => [String(role._id), role.name]));
    return list.map((user) => user && {
      ...user,
      accessRoleNames: user.platformOwner ? ['Owner'] : [...new Set(assignments.filter((item) => String(item.user) === String(user._id))
        .map((item) => names.get(String(item.role))).filter(Boolean))].sort(),
    });
  });
}

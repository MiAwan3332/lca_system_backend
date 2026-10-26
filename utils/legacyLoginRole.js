import Role from '../models/roles.js';
import { legacyAccountType } from './accessPolicy.js';

export function loginRoleIdentity(user, role) {
  if (!role) return null;
  const category = user.accountType || legacyAccountType(user.role);
  return { ...(role.toObject ? role.toObject() : role), name: category === 'staff' ? user.role : category };
}

export async function resolveLegacyLoginRole(name) {
  const exact = await Role.findOne({ name, managed: { $ne: true } });
  if (exact || String(name).toLowerCase() !== 'teacher') return exact;
  // Only repair the known category casing mismatch, never approximate staff roles.
  return Role.findOne({ name: 'Teacher', managed: { $ne: true } });
}

export const ACCESS_SCOPES = ['all', 'own', 'assigned', 'selected'];
export const ACCOUNT_TYPES = ['staff', 'student', 'teacher', 'qualifier', 'panelist'];
export const normalizeLegacyRole = (value) => String(value || '').toLowerCase().replace(/[\s_-]/g, '');
export const legacyAccountType = (value) => ACCOUNT_TYPES.slice(1).includes(normalizeLegacyRole(value)) ? normalizeLegacyRole(value) : 'staff';
export const legacyOwner = (value) => ['secrateadmin', 'secratesuperadmin', 'superadmin', 'superadmindevelopment'].includes(normalizeLegacyRole(value));
export const legacyStaffManager = (value) => ['ceo', 'principal', 'principle', 'viceprincipal', 'viceprinciple'].includes(normalizeLegacyRole(value));

// Grants are deliberately finite data, never administrator-supplied JavaScript or MongoDB queries.
export function validateGrants(grants, catalog) {
  if (!Array.isArray(grants) || grants.length > 2000) throw new Error('Provide at most 2000 permission grants');
  return grants.map((grant) => {
    if (!catalog.has(grant.permission)) throw new Error(`Unknown permission: ${grant.permission}`);
    if (!ACCESS_SCOPES.includes(grant.scope)) throw new Error('Invalid access scope');
    if ((grant.permission.startsWith('fields.') || grant.permission === 'files.download') && grant.scope !== 'all') throw new Error('Field/file visibility inherits the authorized record scope; use all for these grants');
    const maxAmount = grant.maxAmount == null ? null : Number(grant.maxAmount);
    if (maxAmount !== null && (!Number.isFinite(maxAmount) || maxAmount < 0)) throw new Error('Invalid approval amount');
    if (grant.fields && (!Array.isArray(grant.fields) || grant.fields.length > 500 || grant.fields.some((field) => typeof field !== 'string' || !/^[a-zA-Z_][\w.]*$/.test(field)))) throw new Error('Invalid field selection');
    return { permission: grant.permission, scope: grant.scope, maxAmount, fields: [...new Set(grant.fields || [])],
      noSelfApproval: Boolean(grant.noSelfApproval) };
  });
}

export function effectiveGrants(assignments, roles, now = new Date()) {
  const byId = new Map(roles.filter((role) => role.active !== false).map((role) => [String(role._id), role]));
  return assignments.filter((assignment) => !assignment.revokedAt && (!assignment.expiresAt || new Date(assignment.expiresAt) > now))
    .flatMap((assignment) => {
      const role = byId.get(String(assignment.role));
      return (role?.grants || []).map((grant) => ({ ...grant, roleId: String(role._id), assignmentId: String(assignment._id),
        batchIds: (assignment.batchIds || []).map(String), courseIds: (assignment.courseIds || []).map(String) }));
    });
}

export function evaluateAccess(context, permission, resource = {}) {
  if (!context || context.disabled) return { allowed: false, reason: 'Account is disabled or unavailable', matches: [] };
  if (context.owner) return { allowed: true, reason: 'Protected platform owner', matches: [{ scope: 'all' }] };
  const matches = context.grants.filter((grant) => {
    if (grant.permission !== permission) return false;
    if (grant.maxAmount !== null && grant.maxAmount !== undefined && resource.amount != null && Math.abs(Number(resource.amount)) > grant.maxAmount) return false;
    if (grant.noSelfApproval && resource.createdBy && String(resource.createdBy) === String(context.userId)) return false;
    if (grant.scope === 'all') return true;
    if (grant.scope === 'own') return resource.ownerId != null && String(resource.ownerId) === String(context.userId);
    const batches = grant.scope === 'assigned' ? context.assignedBatchIds || [] : grant.batchIds;
    const courses = grant.scope === 'assigned' ? context.assignedCourseIds || [] : grant.courseIds;
    if (resource.batchId && !batches.includes(String(resource.batchId))) return false;
    if (resource.courseId && !courses.includes(String(resource.courseId))) return false;
    if (grant.scope === 'assigned' && resource.batchId && resource.courseId && context.assignedPairs &&
      !context.assignedPairs.some((pair) => pair.batchId === String(resource.batchId) && pair.courseId === String(resource.courseId))) return false;
    return Boolean(resource.batchId || resource.courseId);
  });
  return { allowed: matches.length > 0, reason: matches.length ? 'Matching permission and scope' : 'No matching permission within this scope', matches };
}

// Administrators can only hand out access they hold institution-wide themselves.
export function assertDelegable(context, grants) {
  if (context.owner) return;
  for (const grant of grants) {
    if (!context.grants.some((held) => held.permission === grant.permission && held.scope === 'all' &&
      (held.maxAmount == null || (grant.maxAmount != null && grant.maxAmount <= held.maxAmount)) && (!held.noSelfApproval || grant.noSelfApproval) &&
      (!held.fields?.length || (grant.fields?.length && grant.fields.every((field) => held.fields.includes(field)))))) {
      throw Object.assign(new Error(`You cannot delegate broader access than you hold: ${grant.permission}`), { status: 403 });
    }
  }
}
export const canAssignAccess = (context) => Boolean(context?.owner || (context?.accountType === 'staff' &&
  permissionGrants(context, 'access.assign').some((grant) => grant.scope === 'all')));

export function permissionGrants(context, permission) {
  return context?.owner ? [{ permission, scope: 'all' }] : (context?.grants || []).filter((grant) => grant.permission === permission);
}

import { createHash } from 'node:crypto';
import { legacyAccountType, validateGrants } from './accessPolicy.js';

export const catalogDigest = (catalog) => createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
const normalize = (value) => String(value).replace(/[_\s.-]/g, '').toLowerCase().replace(/^view/, 'get');

export function buildMigrationPlan({ roles, permissions, users }, catalog) {
  const names = new Map(permissions.map((item) => [String(item._id), item.name]));
  const plan = { schemaVersion: 2, reviewed: false, activationReviewed: false, activateUsers: false,
    catalogDigest: catalogDigest(catalog), ownerUserIds: [], defaults: {}, roles: [] };
  for (const role of roles.filter((item) => !item.managed)) {
    const grants = [], unmapped = [];
    for (const id of role.permissions || []) {
      const name = typeof id === 'object' && id.name ? id.name : names.get(String(id));
      const matches = catalog.routes.filter((route) => !route.public && !route.blocked && normalize(route.handler) === normalize(name));
      if (!matches.length) unmapped.push(name || String(id));
      for (const route of matches) if (!grants.some((item) => item.permission === route.permission))
        grants.push({ permission: route.permission, scope: ['student', 'teacher'].includes(legacyAccountType(role.name)) ? 'own' : 'all' });
    }
    const aliases = role.name === 'Teacher' ? ['Teacher', 'teacher'] : [role.name];
    plan.roles.push({ legacyRoleId: String(role._id), legacyName: role.name, legacyNames: aliases,
      code: `legacy-${role._id}`, name: role.name, description: role.description || '', grants, unmapped, policyReviewed: false,
      targets: users.filter((user) => aliases.includes(user.role)).map((user) => ({ userId: String(user._id),
        expectedRole: user.role, accountType: user.accountType || legacyAccountType(user.role) })) });
  }
  return plan;
}

export function validateMigrationPlan(plan, users, catalog, { applying = false } = {}) {
  const errors = [], warnings = [];
  const byId = new Map(users.map((user) => [String(user._id), user]));
  const keys = new Set(catalog.permissions.map((item) => item.key));
  const owners = new Set(plan.ownerUserIds || []), covered = new Set(owners), codes = new Set();
  if (plan.schemaVersion !== 2) errors.push('Regenerate the plan using schema version 2');
  if (plan.catalogDigest !== catalogDigest(catalog)) errors.push('Permission catalog changed: regenerate and review the plan');
  if (applying && plan.reviewed !== true) errors.push('Plan has not been explicitly reviewed');
  if (!owners.size) errors.push('Choose at least one protected owner by user ID');
  for (const id of owners) {
    const user = byId.get(id);
    if (!user || user.disabledAt || user.creation_pending || legacyAccountType(user.role) !== 'staff') errors.push(`Unavailable or non-staff owner: ${id}`);
  }
  for (const role of plan.roles || []) {
    if (!role.code || codes.has(role.code)) errors.push(`Missing or duplicate role code: ${role.code}`);
    codes.add(role.code);
    try { validateGrants(role.grants, keys); } catch (error) { errors.push(`${role.name}: ${error.message}`); }
    if (!role.policyReviewed) warnings.push(`${role.name}: review hard-coded legacy access and field visibility`);
    if (role.unmapped?.length) warnings.push(`${role.name}: unmapped legacy permissions: ${role.unmapped.join(', ')}`);
    if (!role.grants?.length) warnings.push(`${role.name}: no grants`);
    for (const target of role.targets || []) {
      const user = byId.get(target.userId);
      if (!user || user.role !== target.expectedRole) errors.push(`Account missing or role changed: ${target.userId}`);
      if (!['staff', 'student', 'teacher', 'qualifier', 'panelist'].includes(target.accountType)) errors.push(`Invalid account category: ${target.userId}`);
      covered.add(target.userId);
    }
  }
  const uncovered = users.filter((user) => !covered.has(String(user._id))).map((user) => String(user._id));
  if (uncovered.length) warnings.push(`${uncovered.length} accounts have no planned assignment`);
  for (const [type, code] of Object.entries(plan.defaults || {}))
    if (!['staff', 'student', 'teacher', 'qualifier', 'panelist'].includes(type) || !codes.has(code)) errors.push(`Invalid onboarding default: ${type}`);
    else {
      const role = plan.roles.find((item) => item.code === code);
      if (!role.policyReviewed || !role.grants?.length) errors.push(`Onboarding default must have a reviewed, nonempty policy: ${type}`);
    }
  if (plan.activateUsers) {
    if (plan.activationReviewed !== true) errors.push('Activation needs separate approval');
    if (warnings.length) errors.push('Resolve every policy/coverage warning before activation');
    for (const type of new Set(users.map((user) => user.accountType || legacyAccountType(user.role))))
      if (!plan.defaults?.[type]) errors.push(`Missing onboarding default: ${type}`);
    for (const role of plan.roles || []) if ((role.targets || []).some((target) => !owners.has(target.userId)))
      for (const permission of ['fields.general.read', 'users.get.user', 'users.change.password'])
        if (!role.grants.some((grant) => grant.permission === permission)) errors.push(`${role.name}: missing baseline ${permission}`);
  }
  return { errors, warnings, uncoveredUserIds: uncovered, accounts: users.length,
    readyToApply: !errors.length && plan.reviewed === true,
    readyToActivate: !errors.length && plan.reviewed === true && plan.activateUsers === true && plan.activationReviewed === true };
}

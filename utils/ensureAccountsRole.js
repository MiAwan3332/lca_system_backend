import Role from "../models/roles.js";

/**
 * Ensure the Accounts role exists.
 * Copies permission IDs from Information Office when available.
 */
export const ensureAccountsRole = async () => {
  let accountsRole = await Role.findOne({
    name: { $regex: /^accounts$/i },
  });

  const informationOfficeRole = await Role.findOne({
    name: { $regex: /^information[\s_-]*office$/i },
  }).select("permissions");

  const officePermissions = Array.isArray(informationOfficeRole?.permissions)
    ? informationOfficeRole.permissions
    : [];

  if (!accountsRole) {
    accountsRole = await Role.create({
      name: "Accounts",
      description:
        "Same access as Information Office, plus delete student, refund requests, and shift student batch",
      permissions: officePermissions,
    });
    return accountsRole;
  }

  // Keep Accounts at least as permissioned as Information Office.
  if (officePermissions.length) {
    const existing = new Set(
      (accountsRole.permissions || []).map((id) => String(id))
    );
    let changed = false;
    for (const permissionId of officePermissions) {
      const key = String(permissionId);
      if (!existing.has(key)) {
        accountsRole.permissions.push(permissionId);
        existing.add(key);
        changed = true;
      }
    }
    if (changed) {
      await accountsRole.save();
    }
  }

  return accountsRole;
};

export default ensureAccountsRole;

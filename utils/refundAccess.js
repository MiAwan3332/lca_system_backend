/**
 * Role helpers for refund request create / approve / reject.
 */
const normalizeRole = (role) =>
  String(role || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

const compactRole = (role) => normalizeRole(role).replace(/\s+/g, "");

const resolveRoleName = (role) => {
  if (!role) return "";
  if (typeof role === "object") {
    return role.name || role.role || role.title || "";
  }
  return role;
};

export const isCeoRoleName = (role) => compactRole(role) === "ceo";

export const isSuperAdminRoleName = (role) => {
  const compact = compactRole(role);
  return (
    compact === "secrateadmin" ||
    compact === "superadmin" ||
    compact === "superadmindevelopment"
  );
};

export const isPrincipalFamilyRoleName = (role) => {
  const compact = compactRole(role);
  return compact === "principal" || compact === "viceprincipal";
};

/** CEO / Principal / VP / Super Admin — create + decide. */
export const canCreateRefundRequest = (role) =>
  isCeoRoleName(role) ||
  isPrincipalFamilyRoleName(role) ||
  isSuperAdminRoleName(role);

export const canDecideRefundRequest = (role) =>
  canCreateRefundRequest(role);

export const getRequestRoleName = (req) =>
  resolveRoleName(req.user?.user?.role);

import User from "../models/users.js";
import Panelist from "../models/panelists.js";

export const isPanelistRole = (req) => {
  const role = req.user?.user?.role;
  return String(role || "").toLowerCase() === "panelist";
};

export const getPanelistIdFromToken = (req) =>
  req.user?.user?.panelistId || null;

export const getUserId = (req) => req.user?.user?.id || null;

const digitsOnly = (value) => String(value || "").replace(/\D/g, "");

const phonesMatch = (a, b) => {
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (!da || !db || da.length < 10 || db.length < 10) return false;
  return da === db || da.slice(-10) === db.slice(-10);
};

export const resolvePanelistId = async (req) => {
  const tokenPanelistId = getPanelistIdFromToken(req);
  if (tokenPanelistId) {
    return String(tokenPanelistId);
  }

  const userId = getUserId(req);
  if (!userId) return null;

  const user = await User.findById(userId);
  if (!user) return null;

  if (user.email) {
    const byEmail = await Panelist.findOne({ email: user.email }).select("_id");
    if (byEmail?._id) return String(byEmail._id);
  }

  if (user.phone) {
    const digits = digitsOnly(user.phone);
    if (digits.length >= 10) {
      const last10 = digits.slice(-10);
      const flexiblePattern = last10.split("").join("\\D*");
      const candidates = await Panelist.find({
        phone: { $regex: flexiblePattern },
      })
        .select("_id phone")
        .limit(20);
      const match = candidates.find((item) => phonesMatch(item.phone, user.phone));
      if (match?._id) return String(match._id);
    }
  }

  return null;
};

export const resolvePanelistRecord = async (req) => {
  const panelistId = await resolvePanelistId(req);
  if (!panelistId) return null;
  return Panelist.findById(panelistId);
};

/** True if this panel includes the panelist as a member. */
export const panelIncludesPanelist = (panel, panelist) => {
  if (!panel || !panelist) return false;
  const members = Array.isArray(panel.members) ? panel.members : [];
  const panelistId = String(panelist._id || "");
  const panelistName = String(panelist.name || "")
    .trim()
    .toLowerCase();

  return members.some((member) => {
    if (!member) return false;
    if (
      member.panelist_id &&
      String(member.panelist_id) === panelistId
    ) {
      return true;
    }
    const memberName = String(member.name || "")
      .trim()
      .toLowerCase();
    if (panelistName && memberName && memberName === panelistName) {
      return true;
    }
    // Legacy members without panelist_id — match by name only
    return false;
  });
};

export { phonesMatch };

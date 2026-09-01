import User from "../models/users.js";
import Qualifier from "../models/qualifiers.js";

export const isQualifierRole = (req) => {
  const role = req.user?.user?.role;
  return String(role || "").toLowerCase() === "qualifier";
};

export const getQualifierIdFromToken = (req) =>
  req.user?.user?.qualifierId || null;

export const getUserId = (req) => req.user?.user?.id || null;

const digitsOnly = (value) => String(value || "").replace(/\D/g, "");

export const resolveQualifierId = async (req) => {
  const tokenQualifierId = getQualifierIdFromToken(req);
  if (tokenQualifierId) {
    return String(tokenQualifierId);
  }

  const userId = getUserId(req);
  if (!userId) return null;

  const user = await User.findById(userId);
  if (!user) return null;

  if (user.email) {
    const byEmail = await Qualifier.findOne({ email: user.email }).select("_id");
    if (byEmail?._id) return String(byEmail._id);
  }

  if (user.phone) {
    const digits = digitsOnly(user.phone);
    if (digits.length >= 10) {
      const last10 = digits.slice(-10);
      const flexiblePattern = last10.split("").join("\\D*");
      const candidates = await Qualifier.find({
        phone: { $regex: flexiblePattern },
      })
        .select("_id phone")
        .limit(20);
      const match = candidates.find((item) => {
        const itemDigits = digitsOnly(item.phone);
        return (
          itemDigits === digits || itemDigits.slice(-10) === last10
        );
      });
      if (match?._id) return String(match._id);
    }
  }

  return null;
};

export const resolveQualifierRecord = async (req) => {
  const qualifierId = await resolveQualifierId(req);
  if (!qualifierId) return null;
  return Qualifier.findById(qualifierId).populate(
    "batch",
    "name is_interview_batch is_active batch_fee"
  );
};

/** True when phone digits match (last 10). */
export const phonesMatch = (a, b) => {
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (!da || !db || da.length < 10 || db.length < 10) return false;
  return da === db || da.slice(-10) === db.slice(-10);
};

const populateQualifier = (query) =>
  query.populate("batch", "name is_interview_batch is_active batch_fee");

/** Resolve qualifier from a booked schedule slot. */
export const resolveQualifierByBooking = async ({
  booked_qualifier_id,
  booked_phone,
  booked_for,
  booked_user_id,
} = {}) => {
  if (booked_qualifier_id) {
    return populateQualifier(Qualifier.findById(booked_qualifier_id));
  }

  if (booked_phone) {
    const digits = digitsOnly(booked_phone);
    if (digits.length >= 10) {
      const last10 = digits.slice(-10);
      const flexiblePattern = last10.split("").join("\\D*");
      const candidates = await Qualifier.find({
        phone: { $regex: flexiblePattern },
      }).limit(20);
      const match = candidates.find((item) =>
        phonesMatch(item.phone, booked_phone)
      );
      if (match?._id) {
        return populateQualifier(Qualifier.findById(match._id));
      }
    }
  }

  if (booked_for) {
    const escaped = String(booked_for).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const byName = await Qualifier.findOne({
      name: { $regex: `^${escaped}$`, $options: "i" },
    });
    if (byName?._id) {
      return populateQualifier(Qualifier.findById(byName._id));
    }
  }

  if (booked_user_id) {
    const user = await User.findById(booked_user_id);
    if (user?.email) {
      const byEmail = await Qualifier.findOne({ email: user.email });
      if (byEmail?._id) {
        return populateQualifier(Qualifier.findById(byEmail._id));
      }
    }
    if (user?.phone) {
      const digits = digitsOnly(user.phone);
      if (digits.length >= 10) {
        const last10 = digits.slice(-10);
        const flexiblePattern = last10.split("").join("\\D*");
        const candidates = await Qualifier.find({
          phone: { $regex: flexiblePattern },
        }).limit(20);
        const match = candidates.find((item) =>
          phonesMatch(item.phone, user.phone)
        );
        if (match?._id) {
          return populateQualifier(Qualifier.findById(match._id));
        }
      }
    }
  }

  return null;
};

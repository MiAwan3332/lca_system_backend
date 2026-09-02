import path from "path";
import bcrypt from "bcryptjs";
import Qualifier from "../models/qualifiers.js";
import Batch from "../models/batches.js";
import User from "../models/users.js";
import {
  compressImage,
  deleteFile,
  uploadFile,
} from "../utils/fileStorage.js";
import { denyUnlessInstitutionAdmin } from "../utils/lmsAccess.js";
import { sendQualifierWelcomeWhatsApp } from "../utils/whatsappMessaging.js";
import {
  isQualifierRole,
  resolveQualifierId,
} from "../utils/qualifierScope.js";
import {
  parseEducationBackgroundPayload,
  getEducationBackgroundValidationError,
  isEducationBackgroundComplete,
} from "../utils/qualifierEducation.js";
import { isPakistanProvince } from "../utils/pakistanProvinces.js";

const DEFAULT_QUALIFIER_PASSWORD = "lca@123456";
const QUALIFIER_ROLE = "qualifier";

const digitsOnly = (value) => String(value || "").replace(/\D/g, "");

/** Internal login email for qualifiers (phone-based). */
const buildQualifierAccountEmail = (phone) => {
  const digits = digitsOnly(phone);
  if (!digits) {
    throw new Error("Phone number is required to create a qualifier login");
  }
  return `qualifier.${digits}@lca.local`;
};

const resolveQualifierLoginEmail = (qualifier) => {
  const existing = String(qualifier?.email || "").trim().toLowerCase();
  if (existing && existing.includes("@") && !existing.endsWith("@lca.local")) {
    return existing;
  }
  return buildQualifierAccountEmail(qualifier?.phone);
};

const ensureQualifierUser = async ({
  qualifier,
  passwordPlain = DEFAULT_QUALIFIER_PASSWORD,
}) => {
  const email = resolveQualifierLoginEmail(qualifier);
  let user = await User.findOne({
    email,
    role: { $regex: new RegExp(`^${QUALIFIER_ROLE}$`, "i") },
  });

  if (!user) {
    // Prefer exact role match; fall back to email-only conflict check
    const emailTaken = await User.findOne({ email });
    if (emailTaken) {
      throw new Error("A login account already exists for this email/phone");
    }
    const hashedPassword = await bcrypt.hash(passwordPlain, 12);
    user = new User({
      name: qualifier.name,
      email,
      phone: qualifier.phone || "",
      password: hashedPassword,
      role: QUALIFIER_ROLE,
    });
    await user.save();
  }

  if (!qualifier.email) {
    qualifier.email = email;
    await qualifier.save();
  }

  return user;
};

const resolveStorageConfig = () => {
  const filesStoragePath =
    process.env.FILES_STORAGE_PATH ||
    path.resolve(process.cwd(), "public", "files");
  const filesStorageUrl =
    process.env.FILES_STORAGE_URL ||
    process.env.BACKEND_URL ||
    "http://localhost:5001/public";
  return { filesStoragePath, filesStorageUrl };
};

const parseIsActive = (value, fallback = true) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "active", "yes"].includes(normalized)) return true;
  if (["false", "0", "inactive", "no"].includes(normalized)) return false;
  return fallback;
};

const asSingleFile = (fileField) => {
  if (!fileField) return null;
  return Array.isArray(fileField) ? fileField[0] || null : fileField;
};

const trimOrEmpty = (value) => String(value || "").trim();

const parseOptionalSubjects = (value) => {
  if (value === undefined || value === null) return null;
  let list = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      list = parsed;
    } catch {
      list = trimmed.split(",");
    }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const name = String(item || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
};

/** Returns integer >= 0, or null if field was not provided. */
const parseNoOfAttempts = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
};

const parseMoney = (value) => {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const resolveInterviewBatch = async (batchId) => {
  const id = trimOrEmpty(batchId);
  if (!id) {
    return { error: "Interview batch is required" };
  }

  const batch = await Batch.findById(id).select(
    "name is_active is_interview_batch batch_fee"
  );
  if (!batch) {
    return { error: "Selected batch not found" };
  }
  if (batch.is_interview_batch !== true) {
    return { error: "Only interview batches can be assigned to qualifiers" };
  }
  if (batch.is_active === false) {
    return { error: "Selected interview batch is inactive" };
  }
  return { batch };
};

const saveQualifierPhoto = async (file, qualifierId) => {
  if (!file) return "";
  const { filesStoragePath, filesStorageUrl } = resolveStorageConfig();
  const dir = `${filesStoragePath}/qualifiers/photos`;
  const originalExt = path.extname(file.name) || ".jpg";
  const tempName = `photo_${qualifierId || "temp"}_${Date.now()}${originalExt}`;
  const finalName = `photo_${qualifierId}.jpeg`;

  await uploadFile(file, tempName, dir);
  await compressImage(`${dir}/${tempName}`, `${dir}/${finalName}`, 50);
  try {
    await deleteFile(`${dir}/${tempName}`);
  } catch {
    // ignore cleanup failure
  }

  return `${filesStorageUrl}/files/qualifiers/photos/${finalName}`;
};

export const addQualifier = async (req, res) => {
  if (denyUnlessInstitutionAdmin(req, res)) return;

  const {
    name,
    phone,
    email,
    cnic,
    city,
    province,
    father_name,
    father_phone,
    description,
    is_active,
    batch,
    paying_now,
    payment_method,
    total_fee: totalFeeBody,
    discount_amount,
    discount_description,
  } = req.body || {};
  const photoFile = asSingleFile(req.files?.photo || req.files?.image);

  try {
    const trimmedName = trimOrEmpty(name);
    const trimmedPhone = trimOrEmpty(phone);

    if (!trimmedName) {
      return res.status(400).json({ message: "Name is required" });
    }
    if (!trimmedPhone) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    const batchResult = await resolveInterviewBatch(batch);
    if (batchResult.error) {
      return res.status(400).json({ message: batchResult.error });
    }

    const batchFee = parseMoney(batchResult.batch.batch_fee);
    const unpaidBatch = batchResult.batch.is_paid_batch === false;
    const grossFee = unpaidBatch
      ? 0
      : parseMoney(totalFeeBody) > 0
        ? parseMoney(totalFeeBody)
        : batchFee;
    const discountAmount = unpaidBatch ? 0 : parseMoney(discount_amount);
    if (discountAmount > grossFee) {
      return res
        .status(400)
        .json({ message: "Discount cannot be greater than batch fee" });
    }
    const totalFee = unpaidBatch ? 0 : Math.max(grossFee - discountAmount, 0);
    const paidFee = unpaidBatch ? 0 : Math.min(parseMoney(paying_now), totalFee);
    const pendingFee = unpaidBatch ? 0 : Math.max(totalFee - paidFee, 0);
    const paymentMethod = unpaidBatch
      ? ""
      : paidFee > 0
        ? trimOrEmpty(payment_method) || "Cash"
        : discountAmount > 0 && totalFee === 0
          ? "Discount"
          : trimOrEmpty(payment_method) || "Pay Later";

    const loginEmail =
      trimOrEmpty(email).toLowerCase() ||
      buildQualifierAccountEmail(trimmedPhone);

    const existingUser = await User.findOne({ email: loginEmail });
    if (existingUser) {
      return res.status(400).json({
        message: "A login account already exists for this phone/email",
      });
    }

    const hashedPassword = await bcrypt.hash(DEFAULT_QUALIFIER_PASSWORD, 12);

    const qualifier = new Qualifier({
      name: trimmedName,
      phone: trimmedPhone,
      email: loginEmail,
      cnic: trimOrEmpty(cnic),
      city: trimOrEmpty(city),
      province: trimOrEmpty(province),
      father_name: trimOrEmpty(father_name),
      father_phone: trimOrEmpty(father_phone),
      description: trimOrEmpty(description),
      batch: batchResult.batch._id,
      total_fee: totalFee,
      discount_amount: discountAmount,
      discount_description:
        discountAmount > 0
          ? trimOrEmpty(discount_description) ||
            "Discount applied on qualifier registration"
          : "",
      paid_fee: paidFee,
      pending_fee: pendingFee,
      payment_method: paymentMethod,
      is_active: parseIsActive(is_active, true),
      photo: "",
    });
    await qualifier.save();

    const newUser = new User({
      name: trimmedName,
      email: loginEmail,
      phone: trimmedPhone,
      password: hashedPassword,
      role: QUALIFIER_ROLE,
    });
    await newUser.save();

    if (photoFile) {
      qualifier.photo = await saveQualifierPhoto(photoFile, qualifier._id);
      await qualifier.save();
    }

    const populated = await Qualifier.findById(qualifier._id).populate(
      "batch",
      "name is_interview_batch is_active batch_fee is_paid_batch"
    );

    let whatsappWelcome = { sent: false, skipped: true };
    try {
      whatsappWelcome = await sendQualifierWelcomeWhatsApp({
        qualifier: populated,
        batch: populated?.batch || batchResult.batch,
        paymentMethod,
        amountReceived: paidFee,
      });
    } catch (whatsappError) {
      console.error(
        "WhatsApp welcome failed after qualifier add:",
        whatsappError
      );
      whatsappWelcome = {
        sent: false,
        error: whatsappError?.message || "WhatsApp send failed",
      };
    }

    res.status(200).json({
      message: "Qualifier added successfully",
      qualifier: populated,
      whatsapp_welcome: whatsappWelcome,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getQualifiers = async (req, res) => {
  const { query, search_field, is_active, city, batch } = req.query;
  try {
    const searchQuery = query ? String(query).trim() : "";
    const field = search_field || "all";
    const filter = {};

    if (isQualifierRole(req)) {
      const ownId = await resolveQualifierId(req);
      if (!ownId) {
        return res.status(404).json({ message: "Qualifier profile not found" });
      }
      filter._id = ownId;
    } else {
      if (searchQuery) {
        if (field === "name") {
          filter.name = { $regex: searchQuery, $options: "i" };
        } else if (field === "phone") {
          filter.phone = { $regex: searchQuery, $options: "i" };
        } else if (field === "email") {
          filter.email = { $regex: searchQuery, $options: "i" };
        } else if (field === "cnic") {
          filter.cnic = { $regex: searchQuery, $options: "i" };
        } else if (field === "city") {
          filter.city = { $regex: searchQuery, $options: "i" };
        } else {
          filter.$or = [
            { name: { $regex: searchQuery, $options: "i" } },
            { phone: { $regex: searchQuery, $options: "i" } },
            { email: { $regex: searchQuery, $options: "i" } },
            { cnic: { $regex: searchQuery, $options: "i" } },
            { city: { $regex: searchQuery, $options: "i" } },
            { father_name: { $regex: searchQuery, $options: "i" } },
            { description: { $regex: searchQuery, $options: "i" } },
          ];
        }
      }

      if (city && String(city).trim()) {
        filter.city = { $regex: String(city).trim(), $options: "i" };
      }

      if (batch && String(batch).trim()) {
        filter.batch = String(batch).trim();
      }

      if (is_active === "true" || is_active === true) {
        filter.is_active = true;
      } else if (is_active === "false" || is_active === false) {
        filter.is_active = false;
      }
    }

    const qualifiers = await Qualifier.paginate(filter, {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 10,
      sort: { createdAt: -1 },
      populate: { path: "batch", select: "name is_interview_batch is_active" },
    });
    res.status(200).json(qualifiers);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getQualifier = async (req, res) => {
  const { id } = req.params;
  try {
    if (isQualifierRole(req)) {
      const ownId = await resolveQualifierId(req);
      if (!ownId || String(ownId) !== String(id)) {
        return res.status(403).json({ message: "Not allowed" });
      }
    }

    const qualifier = await Qualifier.findById(id).populate(
      "batch",
      "name is_interview_batch is_active"
    );
    if (!qualifier) {
      return res.status(404).json({ message: "Qualifier not found" });
    }
    res.status(200).json(qualifier);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateQualifier = async (req, res) => {
  const { id } = req.params;
  const {
    name,
    phone,
    email,
    cnic,
    city,
    province,
    father_name,
    father_phone,
    description,
    is_active,
    batch,
    optional_subjects,
    no_of_attempts,
    latest_degree,
    education_background,
  } = req.body || {};
  const photoFile = asSingleFile(req.files?.photo || req.files?.image);
  const isSelfQualifier = isQualifierRole(req);

  try {
    if (isSelfQualifier) {
      const ownId = await resolveQualifierId(req);
      if (!ownId || String(ownId) !== String(id)) {
        return res.status(403).json({ message: "Not allowed" });
      }
    } else if (denyUnlessInstitutionAdmin(req, res)) {
      return;
    }

    const qualifier = await Qualifier.findById(id);
    if (!qualifier) {
      return res.status(404).json({ message: "Qualifier not found" });
    }

    if (name !== undefined) {
      const trimmedName = trimOrEmpty(name);
      if (!trimmedName) {
        return res.status(400).json({ message: "Name is required" });
      }
      qualifier.name = trimmedName;
    }

    if (phone !== undefined) {
      const trimmedPhone = trimOrEmpty(phone);
      if (!trimmedPhone) {
        return res.status(400).json({ message: "Phone number is required" });
      }
      qualifier.phone = trimmedPhone;
    }

    if (email !== undefined) {
      // Qualifiers keep system login email; only staff can change real emails
      if (!isSelfQualifier) {
        qualifier.email = trimOrEmpty(email).toLowerCase();
      }
    }
    if (cnic !== undefined) {
      const trimmedCnic = trimOrEmpty(cnic);
      if (isSelfQualifier && !trimmedCnic) {
        return res.status(400).json({ message: "CNIC is required" });
      }
      qualifier.cnic = trimmedCnic;
    }
    if (city !== undefined) {
      const trimmedCity = trimOrEmpty(city);
      if (isSelfQualifier && !trimmedCity) {
        return res.status(400).json({ message: "City is required" });
      }
      qualifier.city = trimmedCity;
    }
    if (province !== undefined) {
      const trimmedProvince = trimOrEmpty(province);
      if (isSelfQualifier && !trimmedProvince) {
        return res.status(400).json({ message: "Province is required" });
      }
      if (trimmedProvince && !isPakistanProvince(trimmedProvince)) {
        return res.status(400).json({ message: "Select a valid Pakistan province" });
      }
      qualifier.province = trimmedProvince;
    }
    if (father_name !== undefined) {
      const trimmedFatherName = trimOrEmpty(father_name);
      if (isSelfQualifier && !trimmedFatherName) {
        return res.status(400).json({ message: "Father name is required" });
      }
      qualifier.father_name = trimmedFatherName;
    }
    if (father_phone !== undefined) {
      const trimmedFatherPhone = trimOrEmpty(father_phone);
      if (isSelfQualifier && !trimmedFatherPhone) {
        return res.status(400).json({ message: "Father phone is required" });
      }
      qualifier.father_phone = trimmedFatherPhone;
    }
    if (description !== undefined) {
      const trimmedDescription = trimOrEmpty(description);
      if (isSelfQualifier && !trimmedDescription) {
        return res.status(400).json({ message: "Remarks are required" });
      }
      qualifier.description = trimmedDescription;
    }
    if (latest_degree !== undefined) {
      const trimmedDegree = trimOrEmpty(latest_degree);
      if (isSelfQualifier && !trimmedDegree) {
        return res.status(400).json({ message: "Latest degree is required" });
      }
      qualifier.latest_degree = trimmedDegree;
    } else if (isSelfQualifier) {
      return res.status(400).json({ message: "Latest degree is required" });
    }
    if (education_background !== undefined) {
      const parsedEducation = parseEducationBackgroundPayload(
        education_background
      );
      if (isSelfQualifier) {
        const educationError =
          getEducationBackgroundValidationError(parsedEducation);
        if (educationError) {
          return res.status(400).json({ message: educationError });
        }
      }
      qualifier.education_background = parsedEducation || [];
    } else if (isSelfQualifier) {
      const educationError = getEducationBackgroundValidationError(
        qualifier.education_background
      );
      if (educationError) {
        return res.status(400).json({ message: educationError });
      }
    }

    const parsedSubjects = parseOptionalSubjects(optional_subjects);
    if (parsedSubjects !== null) {
      if (isSelfQualifier && parsedSubjects.length === 0) {
        return res.status(400).json({
          message: "Select at least one optional subject",
        });
      }
      qualifier.optional_subjects = parsedSubjects;
    }

    if (no_of_attempts !== undefined) {
      const parsedAttempts = parseNoOfAttempts(no_of_attempts);
      if (parsedAttempts === null) {
        return res.status(400).json({
          message: "No. of attempts must be a non-negative number",
        });
      }
      qualifier.no_of_attempts = parsedAttempts;
    } else if (isSelfQualifier) {
      return res.status(400).json({
        message: "No. of attempts is required",
      });
    }

    if (isSelfQualifier && !qualifier.photo && !photoFile) {
      return res.status(400).json({ message: "Photo is required" });
    }

    // Batch / active status: staff only
    if (!isSelfQualifier) {
      if (is_active !== undefined) {
        qualifier.is_active = parseIsActive(is_active, qualifier.is_active);
      }
      if (batch !== undefined) {
        const batchResult = await resolveInterviewBatch(batch);
        if (batchResult.error) {
          return res.status(400).json({ message: batchResult.error });
        }
        qualifier.batch = batchResult.batch._id;
      } else if (!qualifier.batch) {
        return res.status(400).json({
          message: "Interview batch is required",
        });
      }
    } else if (!qualifier.batch) {
      return res.status(400).json({
        message: "Interview batch is required",
      });
    }

    if (photoFile) {
      const { filesStoragePath } = resolveStorageConfig();
      try {
        await deleteFile(
          `${filesStoragePath}/qualifiers/photos/photo_${qualifier._id}.jpeg`
        );
      } catch {
        // ignore missing old file
      }
      qualifier.photo = await saveQualifierPhoto(photoFile, qualifier._id);
    }

    await qualifier.save();

    // Keep linked login user in sync
    try {
      const loginEmail = resolveQualifierLoginEmail(qualifier);
      const user = await User.findOne({
        email: loginEmail,
        role: { $regex: new RegExp(`^${QUALIFIER_ROLE}$`, "i") },
      });
      if (user) {
        user.name = qualifier.name || user.name;
        user.phone = qualifier.phone || user.phone;
        await user.save();
      }
    } catch {
      // non-blocking
    }

    const populated = await Qualifier.findById(qualifier._id).populate(
      "batch",
      "name is_interview_batch is_active"
    );
    res.status(200).json({
      message: "Qualifier updated successfully",
      qualifier: populated,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const changeQualifierPassword = async (req, res) => {
  if (denyUnlessInstitutionAdmin(req, res)) return;

  const { id } = req.params;
  const { password } = req.body || {};

  try {
    if (!password || String(password).length < 6) {
      return res.status(400).json({
        message: "Password must be at least 6 characters",
      });
    }

    const qualifier = await Qualifier.findById(id);
    if (!qualifier) {
      return res.status(404).json({ message: "Qualifier not found" });
    }

    const hashedPassword = await bcrypt.hash(String(password), 12);
    let user = null;

    try {
      user = await ensureQualifierUser({ qualifier });
    } catch (ensureError) {
      return res.status(400).json({
        message: ensureError?.message || "Could not create qualifier login",
      });
    }

    user.password = hashedPassword;
    user.name = qualifier.name || user.name;
    user.phone = qualifier.phone || user.phone;
    await user.save();

    res.status(200).json({
      message: "Qualifier password updated successfully",
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteQualifier = async (req, res) => {
  if (denyUnlessInstitutionAdmin(req, res)) return;

  const { id } = req.params;
  try {
    const qualifier = await Qualifier.findById(id);
    if (!qualifier) {
      return res.status(404).json({ message: "Qualifier not found" });
    }

    const loginEmail = resolveQualifierLoginEmail(qualifier);
    await User.deleteMany({
      email: loginEmail,
      role: { $regex: new RegExp(`^${QUALIFIER_ROLE}$`, "i") },
    });

    await Qualifier.findByIdAndDelete(id);

    const { filesStoragePath } = resolveStorageConfig();
    try {
      await deleteFile(
        `${filesStoragePath}/qualifiers/photos/photo_${id}.jpeg`
      );
    } catch {
      // ignore missing photo
    }

    res.status(200).json({ message: "Qualifier deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

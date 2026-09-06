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
import {
  sendQualifierWelcomeWhatsApp,
} from "../utils/whatsappMessaging.js";
import {
  createCampaignId,
} from "../utils/whatsappQueue.js";
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

const ALLOWED_CLASS_TYPES = new Set(["Online", "On Campus"]);

const normalizeClassType = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (lower === "online") return "Online";
  if (lower === "on campus" || lower === "oncampus" || lower === "campus") {
    return "On Campus";
  }
  if (ALLOWED_CLASS_TYPES.has(raw)) return raw;
  return null;
};

/** Excel often drops leading 0 (03088811771 → 3088811771). */
const normalizeLocalPhone = (value) => {
  let digits = digitsOnly(value);
  if (digits.length === 10 && digits.startsWith("3")) {
    digits = `0${digits}`;
  }
  return digits;
};

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
    "name is_active is_interview_batch batch_fee is_paid_batch"
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
    css_pms_roll_no,
    class_type,
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

    const normalizedClassType = normalizeClassType(class_type);
    if (normalizedClassType === null) {
      return res.status(400).json({
        message: "Class type must be Online or On Campus",
      });
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
      css_pms_roll_no: trimOrEmpty(css_pms_roll_no),
      class_type: normalizedClassType,
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

    let whatsappWelcome = { sent: false, queued: false, skipped: true };
    try {
      whatsappWelcome = await sendQualifierWelcomeWhatsApp({
        qualifier: populated,
        batch: populated?.batch || batchResult.batch,
        password: DEFAULT_QUALIFIER_PASSWORD,
        paymentMethod,
        amountReceived: paidFee,
        source: "qualifier_add",
      });
    } catch (whatsappError) {
      console.error(
        "WhatsApp welcome queue failed after qualifier add:",
        whatsappError
      );
      whatsappWelcome = {
        sent: false,
        queued: false,
        error: whatsappError?.message || "WhatsApp queue failed",
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

const phoneAlreadyUsed = async (phone) => {
  const digits = digitsOnly(phone);
  if (!digits) return "Phone number is required";

  const last10 = digits.slice(-10);
  const existingQualifier = await Qualifier.findOne({
    $or: [
      { phone: phone },
      { phone: { $regex: `${last10}$` } },
    ],
  }).select("_id phone");
  if (existingQualifier) {
    return "A qualifier with this phone number already exists";
  }

  const loginEmail = buildQualifierAccountEmail(phone);
  const existingUser = await User.findOne({ email: loginEmail });
  if (existingUser) {
    return "A login account already exists for this phone";
  }

  return null;
};

const importQualifierFromRow = async ({ row, batchRecord, campaignId }) => {
  const trimmedName = trimOrEmpty(row?.name);
  const trimmedPhone = normalizeLocalPhone(row?.phone);

  if (!trimmedName) {
    throw new Error("Name is required");
  }
  if (!trimmedPhone || digitsOnly(trimmedPhone).length < 10) {
    throw new Error("Valid phone number is required");
  }

  const phoneConflict = await phoneAlreadyUsed(trimmedPhone);
  if (phoneConflict) {
    throw new Error(phoneConflict);
  }

  const unpaidBatch = batchRecord.is_paid_batch === false;
  const batchFee = parseMoney(batchRecord.batch_fee);
  const totalFee = unpaidBatch ? 0 : batchFee;
  const paidFee = 0;
  const pendingFee = unpaidBatch ? 0 : totalFee;
  const paymentMethod = unpaidBatch
    ? ""
    : totalFee > 0
      ? "Pay Later"
      : "";

  const loginEmail =
    trimOrEmpty(row?.email).toLowerCase() ||
    buildQualifierAccountEmail(trimmedPhone);

  const emailTaken = await User.findOne({ email: loginEmail });
  if (emailTaken) {
    throw new Error("A login account already exists for this phone/email");
  }

  const hashedPassword = await bcrypt.hash(DEFAULT_QUALIFIER_PASSWORD, 12);

  const normalizedClassType = normalizeClassType(row?.class_type);
  if (normalizedClassType === null) {
    throw new Error("Class type must be Online or On Campus");
  }

  const qualifier = await new Qualifier({
    name: trimmedName,
    phone: trimmedPhone,
    email: loginEmail,
    cnic: trimOrEmpty(row?.cnic),
    css_pms_roll_no: trimOrEmpty(row?.css_pms_roll_no),
    class_type: normalizedClassType,
    city: trimOrEmpty(row?.city),
    province: trimOrEmpty(row?.province),
    father_name: trimOrEmpty(row?.father_name),
    father_phone: normalizeLocalPhone(row?.father_phone) || trimOrEmpty(row?.father_phone),
    description: trimOrEmpty(row?.description || row?.remarks),
    batch: batchRecord._id,
    total_fee: totalFee,
    discount_amount: 0,
    discount_description: "",
    paid_fee: paidFee,
    pending_fee: pendingFee,
    payment_method: paymentMethod,
    is_active: true,
    photo: "",
  }).save();

  await new User({
    name: trimmedName,
    email: loginEmail,
    phone: trimmedPhone,
    password: hashedPassword,
    role: QUALIFIER_ROLE,
  }).save();

  const populated = await Qualifier.findById(qualifier._id).populate(
    "batch",
    "name is_interview_batch is_active batch_fee is_paid_batch"
  );

  let whatsappWelcome = { queued: false, skipped: true };
  try {
    whatsappWelcome = await sendQualifierWelcomeWhatsApp({
      qualifier: populated,
      batch: populated?.batch || batchRecord,
      password: DEFAULT_QUALIFIER_PASSWORD,
      paymentMethod,
      amountReceived: paidFee,
      campaign_id: campaignId || "",
      source: "qualifier_import",
    });
  } catch (whatsappError) {
    console.error(
      "WhatsApp welcome queue failed after qualifier import:",
      whatsappError
    );
    whatsappWelcome = {
      queued: false,
      error: whatsappError?.message || "WhatsApp queue failed",
    };
  }

  return { qualifier: populated, whatsappWelcome };
};

export const bulkImportQualifiers = async (req, res) => {
  if (denyUnlessInstitutionAdmin(req, res)) return;

  const { batch_id: batchId, qualifiers } = req.body || {};

  if (!batchId) {
    return res.status(400).json({ message: "Interview batch is required" });
  }
  if (!Array.isArray(qualifiers) || qualifiers.length === 0) {
    return res
      .status(400)
      .json({ message: "No qualifiers provided for import" });
  }
  if (qualifiers.length > 500) {
    return res
      .status(400)
      .json({ message: "Maximum 500 qualifiers can be imported at once" });
  }

  try {
    const batchResult = await resolveInterviewBatch(batchId);
    if (batchResult.error) {
      return res.status(400).json({ message: batchResult.error });
    }

    const campaignId = createCampaignId();
    const results = {
      imported: 0,
      failed: [],
      imported_qualifiers: [],
      whatsapp_queued: 0,
      whatsapp_failed: 0,
      whatsapp_campaign_id: campaignId,
    };

    const seenPhones = new Set();

    for (let index = 0; index < qualifiers.length; index += 1) {
      const row = qualifiers[index];
      const rowNumber = row.excelRow || index + 2;

      try {
        const phoneKey = digitsOnly(row?.phone);
        if (!phoneKey) {
          throw new Error("Phone number is required");
        }
        if (seenPhones.has(phoneKey) || seenPhones.has(phoneKey.slice(-10))) {
          throw new Error("Duplicate phone number in import file");
        }
        seenPhones.add(phoneKey);
        seenPhones.add(phoneKey.slice(-10));

        const { qualifier, whatsappWelcome } = await importQualifierFromRow({
          row: { ...row, excelRow: rowNumber },
          batchRecord: batchResult.batch,
          campaignId,
        });

        results.imported += 1;
        if (whatsappWelcome?.queued) {
          results.whatsapp_queued += 1;
        } else if (!whatsappWelcome?.skipped) {
          results.whatsapp_failed += 1;
        }

        results.imported_qualifiers.push({
          row: rowNumber,
          name: qualifier?.name || "",
          phone: qualifier?.phone || "",
          whatsapp_queued: Boolean(whatsappWelcome?.queued),
        });
      } catch (error) {
        results.failed.push({
          row: rowNumber,
          phone: row?.phone || "",
          name: row?.name || "",
          message: error.message,
        });
      }
    }

    res.status(200).json({
      message: `Imported ${results.imported} of ${qualifiers.length} qualifiers`,
      batch_id: batchId,
      batch_name: batchResult.batch.name,
      ...results,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getQualifiers = async (req, res) => {
  const { query, search_field, is_active, city, batch, class_type } = req.query;
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
        } else if (field === "css_pms_roll_no") {
          filter.css_pms_roll_no = { $regex: searchQuery, $options: "i" };
        } else if (field === "city") {
          filter.city = { $regex: searchQuery, $options: "i" };
        } else {
          filter.$or = [
            { name: { $regex: searchQuery, $options: "i" } },
            { phone: { $regex: searchQuery, $options: "i" } },
            { email: { $regex: searchQuery, $options: "i" } },
            { cnic: { $regex: searchQuery, $options: "i" } },
            { css_pms_roll_no: { $regex: searchQuery, $options: "i" } },
            { class_type: { $regex: searchQuery, $options: "i" } },
            { city: { $regex: searchQuery, $options: "i" } },
            { father_name: { $regex: searchQuery, $options: "i" } },
            { description: { $regex: searchQuery, $options: "i" } },
          ];
        }
      }

      if (city && String(city).trim()) {
        filter.city = { $regex: String(city).trim(), $options: "i" };
      }

      const normalizedClassFilter = normalizeClassType(class_type);
      if (normalizedClassFilter) {
        filter.class_type = normalizedClassFilter;
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
    css_pms_roll_no,
    class_type,
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
    if (css_pms_roll_no !== undefined) {
      qualifier.css_pms_roll_no = trimOrEmpty(css_pms_roll_no);
    }
    if (class_type !== undefined) {
      const normalizedClassType = normalizeClassType(class_type);
      if (normalizedClassType === null) {
        return res.status(400).json({
          message: "Class type must be Online or On Campus",
        });
      }
      qualifier.class_type = normalizedClassType;
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

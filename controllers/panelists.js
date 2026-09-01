import path from "path";
import bcrypt from "bcryptjs";
import Panelist from "../models/panelists.js";
import User from "../models/users.js";
import Role from "../models/roles.js";
import {
  compressImage,
  deleteFile,
  uploadFile,
} from "../utils/fileStorage.js";
import { denyUnlessInstitutionAdmin } from "../utils/lmsAccess.js";
import { sendPanelistWelcomeWhatsApp } from "../utils/whatsappMessaging.js";

const DEFAULT_PANELIST_PASSWORD = "lca@123456";
const PANELIST_ROLE = "panelist";

const digitsOnly = (value) => String(value || "").replace(/\D/g, "");

const buildPanelistAccountEmail = (phone) => {
  const digits = digitsOnly(phone);
  if (!digits) {
    throw new Error("Phone number is required to create a panelist login");
  }
  return `panelist.${digits}@lca.local`;
};

const resolvePanelistLoginEmail = (panelist) => {
  const existing = String(panelist?.email || "").trim().toLowerCase();
  if (existing && existing.includes("@") && !existing.endsWith("@lca.local")) {
    return existing;
  }
  return buildPanelistAccountEmail(panelist?.phone);
};

const ensurePanelistRole = async () => {
  let role = await Role.findOne({
    name: { $regex: new RegExp(`^${PANELIST_ROLE}$`, "i") },
  });
  if (!role) {
    role = await Role.create({
      name: PANELIST_ROLE,
      description: "Interview panelist portal access",
      permissions: [],
    });
  }
  return role;
};

const ensurePanelistUser = async ({
  panelist,
  passwordPlain = DEFAULT_PANELIST_PASSWORD,
}) => {
  await ensurePanelistRole();
  const email = resolvePanelistLoginEmail(panelist);
  let user = await User.findOne({
    email,
    role: { $regex: new RegExp(`^${PANELIST_ROLE}$`, "i") },
  });

  if (!user) {
    const emailTaken = await User.findOne({ email });
    if (emailTaken) {
      throw new Error("A login account already exists for this email/phone");
    }
    const hashedPassword = await bcrypt.hash(passwordPlain, 12);
    user = new User({
      name: panelist.name,
      email,
      phone: panelist.phone || "",
      password: hashedPassword,
      role: PANELIST_ROLE,
    });
    await user.save();
  }

  if (!panelist.email) {
    panelist.email = email;
    await panelist.save();
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

const savePanelistPhoto = async (file, panelistId) => {
  if (!file) return "";
  const { filesStoragePath, filesStorageUrl } = resolveStorageConfig();
  const dir = `${filesStoragePath}/panelists/photos`;
  const originalExt = path.extname(file.name) || ".jpg";
  const tempName = `photo_${panelistId || "temp"}_${Date.now()}${originalExt}`;
  const finalName = `photo_${panelistId}.jpeg`;

  await uploadFile(file, tempName, dir);
  await compressImage(`${dir}/${tempName}`, `${dir}/${finalName}`, 50);
  try {
    await deleteFile(`${dir}/${tempName}`);
  } catch {
    // ignore cleanup failure
  }

  return `${filesStorageUrl}/files/panelists/photos/${finalName}`;
};

export const addPanelist = async (req, res) => {
  if (denyUnlessInstitutionAdmin(req, res)) return;

  const { name, phone, description, is_active } = req.body || {};
  const photoFile = asSingleFile(req.files?.photo || req.files?.image);

  try {
    const trimmedName = String(name || "").trim();
    const trimmedPhone = String(phone || "").trim();
    const trimmedDescription = String(description || "").trim();

    if (!trimmedName) {
      return res.status(400).json({ message: "Name is required" });
    }
    if (!trimmedPhone) {
      return res.status(400).json({ message: "Phone number is required" });
    }
    if (!trimmedDescription) {
      return res.status(400).json({ message: "Description is required" });
    }

    const panelist = new Panelist({
      name: trimmedName,
      phone: trimmedPhone,
      description: trimmedDescription,
      is_active: parseIsActive(is_active, true),
      photo: "",
    });
    await panelist.save();

    if (photoFile) {
      const photoUrl = await savePanelistPhoto(photoFile, panelist._id);
      panelist.photo = photoUrl;
      await panelist.save();
    }

    let whatsappWelcome = { sent: false, skipped: true };
    try {
      whatsappWelcome = await sendPanelistWelcomeWhatsApp({ panelist });
    } catch (whatsappError) {
      console.error(
        "WhatsApp welcome failed after panelist add:",
        whatsappError
      );
      whatsappWelcome = {
        sent: false,
        error: whatsappError?.message || "WhatsApp welcome failed",
      };
    }

    res.status(200).json({
      message: "Panelist added successfully",
      panelist,
      whatsapp_welcome: whatsappWelcome,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getPanelists = async (req, res) => {
  const { query, search_field, is_active } = req.query;
  try {
    const searchQuery = query ? String(query).trim() : "";
    const field = search_field || "all";
    const filter = {};

    if (searchQuery) {
      if (field === "name") {
        filter.name = { $regex: searchQuery, $options: "i" };
      } else if (field === "phone") {
        filter.phone = { $regex: searchQuery, $options: "i" };
      } else if (field === "description") {
        filter.description = { $regex: searchQuery, $options: "i" };
      } else {
        filter.$or = [
          { name: { $regex: searchQuery, $options: "i" } },
          { phone: { $regex: searchQuery, $options: "i" } },
          { description: { $regex: searchQuery, $options: "i" } },
        ];
      }
    }

    if (is_active === "true" || is_active === true) {
      filter.is_active = true;
    } else if (is_active === "false" || is_active === false) {
      filter.is_active = false;
    }

    const panelists = await Panelist.paginate(filter, {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 10,
      sort: { createdAt: -1 },
    });
    res.status(200).json(panelists);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getPanelist = async (req, res) => {
  const { id } = req.params;
  try {
    const panelist = await Panelist.findById(id);
    if (!panelist) {
      return res.status(404).json({ message: "Panelist not found" });
    }
    res.status(200).json(panelist);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updatePanelist = async (req, res) => {
  if (denyUnlessInstitutionAdmin(req, res)) return;

  const { id } = req.params;
  const { name, phone, description, is_active } = req.body || {};
  const photoFile = asSingleFile(req.files?.photo || req.files?.image);

  try {
    const panelist = await Panelist.findById(id);
    if (!panelist) {
      return res.status(404).json({ message: "Panelist not found" });
    }

    if (name !== undefined) {
      const trimmedName = String(name || "").trim();
      if (!trimmedName) {
        return res.status(400).json({ message: "Name is required" });
      }
      panelist.name = trimmedName;
    }

    if (phone !== undefined) {
      const trimmedPhone = String(phone || "").trim();
      if (!trimmedPhone) {
        return res.status(400).json({ message: "Phone number is required" });
      }
      panelist.phone = trimmedPhone;
    }

    if (description !== undefined) {
      const trimmedDescription = String(description || "").trim();
      if (!trimmedDescription) {
        return res.status(400).json({ message: "Description is required" });
      }
      panelist.description = trimmedDescription;
    }

    if (is_active !== undefined) {
      panelist.is_active = parseIsActive(is_active, panelist.is_active);
    }

    if (photoFile) {
      const { filesStoragePath } = resolveStorageConfig();
      const oldPhoto = `photo_${panelist._id}.jpeg`;
      try {
        await deleteFile(
          `${filesStoragePath}/panelists/photos/${oldPhoto}`
        );
      } catch {
        // ignore missing old file
      }
      panelist.photo = await savePanelistPhoto(photoFile, panelist._id);
    }

    await panelist.save();
    res.status(200).json({
      message: "Panelist updated successfully",
      panelist,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const changePanelistPassword = async (req, res) => {
  if (denyUnlessInstitutionAdmin(req, res)) return;

  const { id } = req.params;
  const { password } = req.body || {};

  try {
    if (!password || String(password).length < 6) {
      return res.status(400).json({
        message: "Password must be at least 6 characters",
      });
    }

    const panelist = await Panelist.findById(id);
    if (!panelist) {
      return res.status(404).json({ message: "Panelist not found" });
    }

    const hashedPassword = await bcrypt.hash(String(password), 12);
    let user = null;

    try {
      user = await ensurePanelistUser({ panelist });
    } catch (ensureError) {
      return res.status(400).json({
        message: ensureError?.message || "Could not create panelist login",
      });
    }

    user.password = hashedPassword;
    user.name = panelist.name || user.name;
    user.phone = panelist.phone || user.phone;
    await user.save();

    res.status(200).json({
      message: "Panelist password updated successfully",
      login_email: resolvePanelistLoginEmail(panelist),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deletePanelist = async (req, res) => {
  if (denyUnlessInstitutionAdmin(req, res)) return;

  const { id } = req.params;
  try {
    const panelist = await Panelist.findById(id);
    if (!panelist) {
      return res.status(404).json({ message: "Panelist not found" });
    }

    const loginEmail = resolvePanelistLoginEmail(panelist);
    await User.deleteMany({
      email: loginEmail,
      role: { $regex: new RegExp(`^${PANELIST_ROLE}$`, "i") },
    });

    await Panelist.findByIdAndDelete(id);

    const { filesStoragePath } = resolveStorageConfig();
    try {
      await deleteFile(
        `${filesStoragePath}/panelists/photos/photo_${id}.jpeg`
      );
    } catch {
      // ignore missing photo
    }

    res.status(200).json({ message: "Panelist deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

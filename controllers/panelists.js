import path from "path";
import { provisionPanelist, panelistIdentity, panelistPhone } from '../utils/panelistProvisioning.js';
import { accessContext } from '../utils/accessContext.js';
import Assignment from '../models/accessAssignment.js';
import { evaluateAccess } from '../utils/accessPolicy.js';
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
import { sendPanelistWelcomeWhatsApp, resolveWhatsAppSenderFromReq } from "../utils/whatsappMessaging.js";

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
  try {
    for (const key of ['name','phone','description']) if (!String(req.body?.[key] || '').trim()) return res.status(400).json({message: key + ' is required'});
    const result = await provisionPanelist(req);
    const {panelist, user, createdUser, existingPanelist, roleName} = result;
    const file = asSingleFile(req.files?.photo || req.files?.image);
    let photo_warning;
    if (file && !existingPanelist) try { panelist.photo = await savePanelistPhoto(file, panelist._id); await panelist.save(); }
    catch { photo_warning='Login and access are ready. Please upload the photo again using Edit.'; }
    let welcome = {skipped:true};
    if (!existingPanelist) try { welcome = await sendPanelistWelcomeWhatsApp({panelist,...(await resolveWhatsAppSenderFromReq(req))}); }
    catch { welcome = {skipped:true,message:'Panelist access is ready; the welcome message could not be queued.'}; }
    res.set('Cache-Control','no-store').json({message:existingPanelist?'Existing panelist login and access are ready':'Panelist and login access are ready',panelist,
      login:{created:createdUser,reused:!createdUser,email:user.email,role_name:roleName},photo_warning,whatsapp_welcome:welcome});
  } catch(error) { res.status(error.status || (error.code===11000?409:500)).json({message:error.code===11000?'This person already has a panelist profile. Refresh and try again.':error.message}); }
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
    res.status(error.status || 500).json({ message: error.message });
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
    res.status(error.status || 500).json({ message: error.message });
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
      if(parseIsActive(is_active,panelist.is_active)!==panelist.is_active && req.access?.enforced && !evaluateAccess(req.access,'panelists.toggle.panelist.status',{ownerId:panelist.user}).allowed)return res.status(403).json({message:'Panelist status permission is required'});
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

    const identity=await panelistIdentity({phone:panelist.phone});
    if(identity.user && panelist.user && String(identity.user._id)!==String(panelist.user)) return res.status(409).json({message:'This phone belongs to a different login user.'});
    panelist.normalized_phone=panelistPhone(panelist.phone);
    await panelist.save();
    if(panelist.is_active && panelist.user)await provisionPanelist(req,{profileId:panelist._id});
    if(!panelist.is_active && panelist.access_assignment)await accessContext.run(undefined,async()=>await Assignment.updateOne({_id:panelist.access_assignment,migrationKey:'panelist-membership:'+panelist._id},{$set:{revokedAt:new Date()}}));
    res.status(200).json({
      message: "Panelist updated successfully",
      panelist,
    });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

export const togglePanelistStatus = async(req,res)=>{req.body={is_active:req.body?.is_active};return updatePanelist(req,res);};

export const changePanelistPassword = async (req,res) => {
  try {
    if (String(req.body?.password || '').length < 8) return res.status(400).json({message:'Password must be at least eight characters'});
    const {panelist,user,createdUser} = await provisionPanelist(req,{profileId:req.params.id});
    // A panelist password action must never reset a shared teacher/staff/student login.
    if (user.accountType !== 'panelist' && !createdUser) return res.status(409).json({message:'This panelist uses an existing shared login. Reset it through Users with the appropriate account permission.'});
    await accessContext.run(undefined,async()=>{user.password=await bcrypt.hash(String(req.body.password),12);await user.save();panelist.login_setup_required=false;await panelist.save();});
    res.json({message:'Panelist login password updated',login_email:user.email});
  }catch(error){res.status(error.status || 500).json({message:error.message});}
};

export const deletePanelist = async (req,res) => {
  try {
    const panelist=await Panelist.findById(req.params.id);if(!panelist)return res.status(404).json({message:'Panelist not found'});
    panelist.is_active=false;await panelist.save();
    if(panelist.access_assignment)await accessContext.run(undefined,async()=>await Assignment.updateOne({_id:panelist.access_assignment,migrationKey:'panelist-membership:'+panelist._id},{$set:{revokedAt:new Date()}}));
    res.json({message:'Panelist access deactivated. Login, other roles and interview history are preserved.'});
  }catch(error){res.status(error.status || 500).json({message:error.message});}
};

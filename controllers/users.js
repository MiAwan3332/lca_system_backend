import User from "../models/users.js";
import Student from "../models/students.js";
import Teacher from "../models/teachers.js";
import Qualifier from "../models/qualifiers.js";
import Panelist from "../models/panelists.js";
import {
  isStudentRole,
  denyUnlessOwnStudent,
  INACTIVE_STUDENT_MESSAGE,
} from "../utils/studentScope.js";
import { isTeacherRole } from "../utils/lmsAccess.js";
import { addEmailToQueue } from "../utils/emailQueue.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import path from "path";

dotenv.config();
const JWT_SECRET = process.env.JWT_SECRET;
const DEFAULT_AVATAR =
  "https://images.unsplash.com/photo-1619946794135-5bc917a27793?ixlib=rb-0.3.5&q=80&fm=jpg&crop=faces&fit=crop&h=200&w=200&s=b616b2c5b373a80ffc9636ba24f7a4a9";
import Role from "../models/roles.js";
import Permission from "../models/permissions.js";
import { compressImage, uploadFile } from "../utils/fileStorage.js";
import { JWT_EXPIRES_IN, JWT_COOKIE_MAX_AGE_MS } from "../utils/jwtConfig.js";
import { logLoginActivity } from "../utils/activityLogger.js";
import { sendUserWelcomeWhatsApp } from "../utils/whatsappMessaging.js";

const digitsOnly = (value) => String(value || "").replace(/\D/g, "");

const looksLikePhone = (value) => {
  const digits = digitsOnly(value);
  // Local / international mobile numbers (not an email)
  return !String(value || "").includes("@") && digits.length >= 10 && digits.length <= 15;
};

const looksLikeEmail = (value) =>
  String(value || "").includes("@") && String(value || "").includes(".");

const phoneDigitsMatch = (storedPhone, rawPhone) => {
  const digits = digitsOnly(rawPhone);
  const itemDigits = digitsOnly(storedPhone);
  if (!digits || digits.length < 10 || !itemDigits) return false;
  const last10 = digits.slice(-10);
  return (
    itemDigits === digits ||
    itemDigits.slice(-10) === last10 ||
    digits.slice(-10) === itemDigits.slice(-10)
  );
};

/** Find student by phone, tolerant of spaces/dashes/+92/0 prefixes. */
const findStudentByPhone = async (rawPhone) => {
  const digits = digitsOnly(rawPhone);
  if (!digits || digits.length < 10) return null;

  const last10 = digits.slice(-10);
  const flexiblePattern = last10.split("").join("\\D*");

  const student = await Student.findOne({
    phone: { $regex: flexiblePattern },
  }).populate("batch");

  if (student && phoneDigitsMatch(student.phone, rawPhone)) {
    return student;
  }

  const candidates = await Student.find({
    phone: { $regex: flexiblePattern },
  })
    .limit(20)
    .populate("batch");

  return (
    candidates.find((item) => phoneDigitsMatch(item.phone, rawPhone)) || null
  );
};

/** Find qualifier by phone, tolerant of formatting differences. */
const findQualifierByPhone = async (rawPhone) => {
  const digits = digitsOnly(rawPhone);
  if (!digits || digits.length < 10) return null;

  const last10 = digits.slice(-10);
  const flexiblePattern = last10.split("").join("\\D*");

  const qualifier = await Qualifier.findOne({
    phone: { $regex: flexiblePattern },
  }).populate("batch", "name is_interview_batch is_active");

  if (qualifier && phoneDigitsMatch(qualifier.phone, rawPhone)) {
    return qualifier;
  }

  const candidates = await Qualifier.find({
    phone: { $regex: flexiblePattern },
  })
    .limit(20)
    .populate("batch", "name is_interview_batch is_active");

  return (
    candidates.find((item) => phoneDigitsMatch(item.phone, rawPhone)) || null
  );
};

/** Find panelist by phone, tolerant of formatting differences. */
const findPanelistByPhone = async (rawPhone) => {
  const digits = digitsOnly(rawPhone);
  if (!digits || digits.length < 10) return null;

  const last10 = digits.slice(-10);
  const flexiblePattern = last10.split("").join("\\D*");

  const panelist = await Panelist.findOne({
    phone: { $regex: flexiblePattern },
  });

  if (panelist && phoneDigitsMatch(panelist.phone, rawPhone)) {
    return panelist;
  }

  const candidates = await Panelist.find({
    phone: { $regex: flexiblePattern },
  }).limit(20);

  return (
    candidates.find((item) => phoneDigitsMatch(item.phone, rawPhone)) || null
  );
};

/** Ensure Role document exists for qualifier logins. */
const ensureQualifierRole = async () => {
  let role = await Role.findOne({
    name: { $regex: /^qualifier$/i },
  });
  if (!role) {
    role = await Role.create({
      name: "qualifier",
      description: "Interview qualifier portal access",
      permissions: [],
    });
  }
  return role;
};

/** Ensure Role document exists for panelist logins. */
const ensurePanelistRole = async () => {
  let role = await Role.findOne({
    name: { $regex: /^panelist$/i },
  });
  if (!role) {
    role = await Role.create({
      name: "panelist",
      description: "Interview panelist portal access",
      permissions: [],
    });
  }
  return role;
};

const resolveLoginUser = async ({ email, phone, identifier }) => {
  const raw = String(identifier || phone || email || "").trim();
  if (!raw) {
    return {
      user: null,
      studentFromPhone: null,
      qualifierFromPhone: null,
      panelistFromPhone: null,
      error: "Email or phone is required",
    };
  }

  // Phone-based login: students, then qualifiers, then panelists
  if (phone || looksLikePhone(raw)) {
    const phoneValue = phone || raw;
    const studentFromPhone = await findStudentByPhone(phoneValue);
    if (studentFromPhone) {
      if (studentFromPhone.is_active === false) {
        return {
          user: null,
          studentFromPhone,
          qualifierFromPhone: null,
          panelistFromPhone: null,
          error: INACTIVE_STUDENT_MESSAGE,
          status: 403,
        };
      }

      const user =
        (await User.findOne({
          email: studentFromPhone.email,
          role: { $regex: /^student$/i },
        })) || (await User.findOne({ email: studentFromPhone.email }));

      if (!user || String(user.role).toLowerCase() !== "student") {
        return {
          user: null,
          studentFromPhone,
          qualifierFromPhone: null,
          panelistFromPhone: null,
          error: "Student account not found. Please contact Lahore CSS Academy.",
          status: 403,
        };
      }

      return {
        user,
        studentFromPhone,
        qualifierFromPhone: null,
        panelistFromPhone: null,
        error: null,
      };
    }

    const qualifierFromPhone = await findQualifierByPhone(phoneValue);
    if (qualifierFromPhone) {
      if (qualifierFromPhone.is_active === false) {
        return {
          user: null,
          studentFromPhone: null,
          qualifierFromPhone,
          panelistFromPhone: null,
          error:
            "Your qualifier account is inactive. Please contact the academy.",
          status: 403,
        };
      }

      await ensureQualifierRole();

      const user =
        (await User.findOne({
          email: qualifierFromPhone.email,
          role: { $regex: /^qualifier$/i },
        })) ||
        (await User.findOne({
          phone: qualifierFromPhone.phone,
          role: { $regex: /^qualifier$/i },
        })) ||
        (await User.findOne({ email: qualifierFromPhone.email }));

      if (!user || String(user.role).toLowerCase() !== "qualifier") {
        return {
          user: null,
          studentFromPhone: null,
          qualifierFromPhone,
          panelistFromPhone: null,
          error:
            "Qualifier login account not found. Ask admin to set a password first.",
          status: 403,
        };
      }

      return {
        user,
        studentFromPhone: null,
        qualifierFromPhone,
        panelistFromPhone: null,
        error: null,
      };
    }

    const panelistFromPhone = await findPanelistByPhone(phoneValue);
    if (!panelistFromPhone) {
      return {
        user: null,
        studentFromPhone: null,
        qualifierFromPhone: null,
        panelistFromPhone: null,
        error: "Invalid credentials",
      };
    }
    if (panelistFromPhone.is_active === false) {
      return {
        user: null,
        studentFromPhone: null,
        qualifierFromPhone: null,
        panelistFromPhone,
        error: "Your panelist account is inactive. Please contact the academy.",
        status: 403,
      };
    }

    await ensurePanelistRole();

    const user =
      (await User.findOne({
        email: panelistFromPhone.email,
        role: { $regex: /^panelist$/i },
      })) ||
      (await User.findOne({
        phone: panelistFromPhone.phone,
        role: { $regex: /^panelist$/i },
      })) ||
      (await User.findOne({ email: panelistFromPhone.email }));

    if (!user || String(user.role).toLowerCase() !== "panelist") {
      return {
        user: null,
        studentFromPhone: null,
        qualifierFromPhone: null,
        panelistFromPhone,
        error:
          "Panelist login account not found. Ask admin to set a password first.",
        status: 403,
      };
    }

    return {
      user,
      studentFromPhone: null,
      qualifierFromPhone: null,
      panelistFromPhone,
      error: null,
    };
  }

  if (!looksLikeEmail(raw) && !email) {
    return {
      user: null,
      studentFromPhone: null,
      qualifierFromPhone: null,
      panelistFromPhone: null,
      error: "Enter a valid email or phone number",
    };
  }

  const user = await User.findOne({ email: email || raw });
  if (user && String(user.role).toLowerCase() === "qualifier") {
    await ensureQualifierRole();
  }
  if (user && String(user.role).toLowerCase() === "panelist") {
    await ensurePanelistRole();
  }
  return {
    user,
    studentFromPhone: null,
    qualifierFromPhone: null,
    panelistFromPhone: null,
    error: user ? null : "Invalid credentials",
  };
};

export const register = async (req, res) => {
  const { name, email, password, role } = req.body;
  try {
    const user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ message: "User already exists" });
    }
    const hashedPassword = await bcrypt.hash(password, 12);
    const newUser = new User({
      name,
      email,
      password: hashedPassword,
      role,
      avatar: DEFAULT_AVATAR,
    });
    await newUser.save();
    const data = { user: { id: newUser._id } };
    const authToken = jwt.sign(data, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    res.status(200).json({ authToken });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const resolveTeacherLoginContext = async (user) => {
  const teacher = await Teacher.findOne({
    $or: [{ user: user._id }, { email: user.email }],
  });

  if (!teacher) {
    return { teacherId: null, teacherData: null };
  }

  if (!teacher.user) {
    teacher.user = user._id;
    await teacher.save();
  }

  return {
    teacherId: teacher._id,
    teacherData: teacher.toObject(),
  };
};

export const login = async (req, res) => {
  const { email, phone, password, identifier } = req.body;
  try {
    if (!password) {
      return res.status(400).json({ message: "Password is required" });
    }

    const resolved = await resolveLoginUser({ email, phone, identifier });
    if (resolved.error) {
      return res.status(resolved.status || 400).json({ message: resolved.error });
    }

    const user = resolved.user;
    if (!user) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // Check if the password is correct
    const isPasswordCorrect = await bcrypt.compare(password, user.password);
    if (!isPasswordCorrect) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // Fetch the role associated with the user
    let role = await Role.findOne({ name: user.role });
    if (!role && String(user.role).toLowerCase() === "qualifier") {
      role = await ensureQualifierRole();
    }
    if (!role && String(user.role).toLowerCase() === "panelist") {
      role = await ensurePanelistRole();
    }

    if (!role) {
      return res.status(500).json({ message: "Role not found" });
    }

    // Fetch the permissions associated with the role
    const permissions = await Permission.find({
      _id: { $in: role.permissions },
    });

    let studentData = null;
    let check = 1;
    let studentId = null;
    let teacherId = null;
    let teacherData = null;
    let qualifierId = null;
    let qualifierData = null;
    let panelistId = null;
    let panelistData = null;

    if (role.name === "student") {
      const student =
        resolved.studentFromPhone ||
        (await Student.findOne({ email: user.email }).populate("batch"));
      if (!student) {
        return res.status(403).json({
          message: "Student account not found. Please contact Lahore CSS Academy.",
        });
      }
      if (student.is_active === false) {
        return res.status(403).json({
          message: INACTIVE_STUDENT_MESSAGE,
        });
      }
      studentId = student._id;
      studentData = student.toObject ? student.toObject() : student;
      const hasEmptyFields = Object.values(studentData).some(
        (field) => field === "" || field === null || field === undefined
      );
      if (hasEmptyFields) {
        check = 0;
      }
    }

    if (role.name === "teacher") {
      const teacherContext = await resolveTeacherLoginContext(user);
      teacherId = teacherContext.teacherId;
      teacherData = teacherContext.teacherData;
    }

    if (String(role.name).toLowerCase() === "qualifier") {
      const qualifier =
        resolved.qualifierFromPhone ||
        (await Qualifier.findOne({ email: user.email }).populate(
          "batch",
          "name is_interview_batch is_active"
        ));
      if (!qualifier) {
        return res.status(403).json({
          message:
            "Qualifier account not found. Please contact Lahore CSS Academy.",
        });
      }
      if (qualifier.is_active === false) {
        return res.status(403).json({
          message:
            "Your qualifier account is inactive. Please contact the academy.",
        });
      }
      qualifierId = qualifier._id;
      qualifierData = qualifier.toObject ? qualifier.toObject() : qualifier;
    }

    if (String(role.name).toLowerCase() === "panelist") {
      const panelist =
        resolved.panelistFromPhone ||
        (await Panelist.findOne({ email: user.email })) ||
        (await Panelist.findOne({ phone: user.phone }));
      if (!panelist) {
        return res.status(403).json({
          message:
            "Panelist account not found. Please contact Lahore CSS Academy.",
        });
      }
      if (panelist.is_active === false) {
        return res.status(403).json({
          message:
            "Your panelist account is inactive. Please contact the academy.",
        });
      }
      panelistId = panelist._id;
      panelistData = panelist.toObject ? panelist.toObject() : panelist;
    }

    const data = {
      user: {
        id: user._id,
        role: role.name,
        permissions: permissions.map((permission) => permission.name),
        ...(studentId ? { studentId } : {}),
        ...(teacherId ? { teacherId } : {}),
        ...(qualifierId ? { qualifierId } : {}),
        ...(panelistId ? { panelistId } : {}),
      },
    };
    const authToken = jwt.sign(data, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    await logLoginActivity({ req, user, roleName: role.name, statusCode: 200 });

    // Set token in cookies
    res.cookie("authToken", authToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: JWT_COOKIE_MAX_AGE_MS,
    });

    res.status(200).json({
      authToken,
      permissions: permissions.map((permission) => permission.name),
      role: role.name,
      check,
      studentData,
      studentId,
      teacherId,
      teacherData,
      qualifierId,
      qualifierData,
      panelistId,
      panelistData,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const adminlogin = async (req, res) => {
  const { email, password } = req.body;
  try {
    if (!email || looksLikePhone(email)) {
      return res.status(400).json({
        message: "Staff login requires email. Students should log in with phone number.",
      });
    }

    // Find staff user by email (students & qualifiers use phone login)
    const user = await User.findOne({
      $and: [
        { email },
        {
          role: {
            $not: { $regex: /^(student|qualifier)$/i },
          },
        },
      ],
    });
    if (!user) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // Check if the password is correct
    const isPasswordCorrect = await bcrypt.compare(password, user.password);
    if (!isPasswordCorrect) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // Fetch the role associated with the user
    const role = await Role.findOne({ name: user.role });

    if (!role) {
      return res.status(500).json({ message: "Role not found" });
    }

    // Fetch the permissions associated with the role
    const permissions = await Permission.find({
      _id: { $in: role.permissions },
    });

    let studentId;
    let teacherId;
    let teacherData = null;

    if (role.name === "student") {
      const student = await Student.findOne({ email: user.email });
      if (student) {
        studentId = student.id;
      }
    }

    if (role.name === "teacher") {
      const teacherContext = await resolveTeacherLoginContext(user);
      teacherId = teacherContext.teacherId;
      teacherData = teacherContext.teacherData;
    }

    const data = {
      user: {
        id: user._id,
        role: role.name,
        permissions: permissions.map((permission) => permission.name),
        ...(studentId ? { studentId } : {}),
        ...(teacherId ? { teacherId } : {}),
      },
    };
    const authToken = jwt.sign(data, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    await logLoginActivity({ req, user, roleName: role.name, statusCode: 200 });

    // Set token in cookies
    res.cookie("authToken", authToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: JWT_COOKIE_MAX_AGE_MS,
    });

    res.status(200).json({
      authToken,
      permissions: permissions.map((permission) => permission.name),
      role: role.name,
      studentId,
      teacherId,
      teacherData,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getUsers = async (req, res) => {
  const { query } = req.query;
  try {
    if (isStudentRole(req)) {
      const userId = req.user?.user?.id;
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      return res.status(200).json({
        docs: [user],
        totalDocs: 1,
        limit: 1,
        totalPages: 1,
        page: 1,
        pagingCounter: 1,
        hasPrevPage: false,
        hasNextPage: false,
        prevPage: null,
        nextPage: null,
      });
    }

    if (isTeacherRole(req)) {
      const userId = req.user?.user?.id;
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      return res.status(200).json({
        docs: [user],
        totalDocs: 1,
        limit: 1,
        totalPages: 1,
        page: 1,
        pagingCounter: 1,
        hasPrevPage: false,
        hasNextPage: false,
        prevPage: null,
        nextPage: null,
      });
    }

    let searchQuery = query ? query : "";
    // Student and teacher accounts are managed on their own screens, not All Users
    const rolesToExclude = ["student", "teacher", "secrateadmin"];
    const users = await User.paginate(
      {
        $and: [
          {
            $or: [
              { name: { $regex: searchQuery, $options: "i" } },
              { email: { $regex: searchQuery, $options: "i" } },
            ],
          },
          {
            role: {
              $not: {
                $regex: `^(${rolesToExclude.join("|")})$`,
                $options: "i",
              },
            },
          },
        ],
      },
      {
        page: parseInt(req.query.page),
        limit: parseInt(req.query.limit),
      }
    );
    res.status(200).json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const addUser = async (req, res) => {
  const { name, email, role, phone } = req.body;
  try {
    const trimmedName = String(name || "").trim();
    const trimmedEmail = String(email || "").trim().toLowerCase();
    const trimmedPhone = String(phone || "").trim();
    const trimmedRole = String(role || "").trim();

    if (!trimmedName || !trimmedEmail || !trimmedRole) {
      return res.status(400).json({
        message: "Name, email, and role are required",
      });
    }
    if (!trimmedPhone) {
      return res.status(400).json({
        message: "Phone number is required to send the welcome WhatsApp message",
      });
    }

    const user = await User.findOne({ email: trimmedEmail });
    if (user) {
      return res.status(400).json({ message: "User already exists" });
    }
    const randomPassword = "lcaadmin@123456";
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(randomPassword, saltRounds);
    const newUser = new User({
      name: trimmedName,
      email: trimmedEmail,
      phone: trimmedPhone,
      password: hashedPassword,
      role: trimmedRole,
      avatar: DEFAULT_AVATAR,
    });
    await newUser.save();

    let whatsappWelcome = { sent: false, skipped: true };
    try {
      whatsappWelcome = await sendUserWelcomeWhatsApp({
        user: newUser,
        password: randomPassword,
      });
    } catch (whatsappError) {
      console.error("WhatsApp welcome failed after user add:", whatsappError);
      whatsappWelcome = {
        sent: false,
        error: whatsappError?.message || "WhatsApp welcome failed",
      };
    }

    res.status(200).json({
      message: "User added successfully",
      whatsapp_welcome: whatsappWelcome,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateUser = async (req, res) => {
  const { id } = req.params;
  const { name, email, password, role, phone } = req.body;
  try {
    const user = await User.findById(id);
    if (!user) {
      return res.status(400).json({ message: "User does not exist" });
    }

    if (name !== undefined) user.name = String(name || "").trim();
    if (email !== undefined) user.email = String(email || "").trim().toLowerCase();
    if (role !== undefined) user.role = String(role || "").trim();
    if (phone !== undefined) user.phone = String(phone || "").trim();

    if (password && String(password).trim()) {
      user.password = await bcrypt.hash(String(password).trim(), 12);
    }

    await user.save();
    res.status(200).json("User updated successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteUser = async (req, res) => {
  const { id } = req.params;
  try {
    const user = await User.findById(id);
    if (!user) {
      return res.status(400).json({ message: "User does not exist" });
    }
    await User.findByIdAndDelete(id);
    res.status(200).json("User deleted successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getUser = async (req, res) => {
  const { id } = req.params;
  try {
    if (isStudentRole(req) && req.user?.user?.id !== id) {
      return res.status(403).json({ message: "Access denied" });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(400).json({ message: "User does not exist" });
    }
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const changeAvatar = async (req, res) => {
  const { id } = req.body;
  const avatar = req.files.avatar;
  try {
    const user = await User.findById(id);
    if (!user) {
      return res.status(400).json({ message: "User does not exist" });
    }

    const filesStorageUrl = process.env.FILES_STORAGE_URL;
    const filesStoragePath = process.env.FILES_STORAGE_PATH;

    // Upload the image to file storage
    const avatarFile = avatar;
    const avatarFileExt = path.extname(avatarFile.name);
    const avatarFileName = `avatar_${id}${avatarFileExt}`;
    await uploadFile(avatarFile, avatarFileName, `${filesStoragePath}/avatars`);
    
    // compress the image to webp 
    const webpFileName = `avatar_${id}.jpeg`;
    await compressImage(`${filesStoragePath}/avatars/${avatarFileName}`, `${filesStoragePath}/avatars/${webpFileName}`, 50);

    // Get the download URL of the compressed image
    const avatarURL = `${filesStorageUrl}/files/avatars/${webpFileName}`;

    await User.findByIdAndUpdate(id, { avatar: avatarURL });

    res.status(200).json({ avatar: avatarURL });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const changePassword = async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;

  // Validate request data
  if (!email || !currentPassword || !newPassword) {
    return res.status(400).json({
      message: "Email, current password, and new password are required",
    });
  }

  try {
    // Find the user by email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Verify the current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    // Hash the new password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // Update the password in the database
    user.password = hashedPassword;
    await user.save();

    res.status(200).json({ message: "Password changed successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const forgotPassword = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "Email is required" });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const resetToken = crypto.randomBytes(10).toString("hex");

    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 3600000;

    await user.save();

    await sendPasswordResetEmail(email, resetToken);

    res.status(200).json({ message: "Password reset token sent to email" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

//get all those users who have role student and change their password
export const resetPasswordForAllStudents = async (req, res) => {

  try {
    const users = await User.find({ role: "student" });

    for (const user of users) {
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash("lca@123456", saltRounds);

      user.password = hashedPassword;

      await user.save();
    }

    res.status(200).json({ message: "Password reset for all students successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

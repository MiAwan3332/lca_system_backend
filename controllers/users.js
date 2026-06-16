import User from "../models/users.js";
import Student from "../models/students.js";
import {
  isStudentRole,
  denyUnlessOwnStudent,
} from "../utils/studentScope.js";
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
    const authToken = jwt.sign(data, JWT_SECRET);

    res.status(200).json({ authToken });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const login = async (req, res) => {
  const { email, password } = req.body;
  try {
    // Find the user by email
    const user = await User.findOne({ email });
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

    let studentData = null;
    let check = 1;
    let studentId = null;
    if (role.name === "student") {
      const student = await Student.findOne({ email: user.email });
      if (student) {
        studentId = student._id;
        studentData = student.toObject(); // Convert the Mongoose document to a plain JavaScript object
        const hasEmptyFields = Object.values(studentData).some(
          (field) => field === "" || field === null || field === undefined
        );
        if (hasEmptyFields) {
          check = 0;
        }
      }
    }

    const data = {
      user: {
        id: user._id,
        role: role.name,
        permissions: permissions.map((permission) => permission.name),
        ...(studentId ? { studentId } : {}),
      },
    };
    const authToken = jwt.sign(data, JWT_SECRET);

    // Set token in cookies
    res.cookie("authToken", authToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
    });

    res.status(200).json({
      authToken,
      permissions: permissions.map((permission) => permission.name),
      role: role.name,
      check,
      studentData,
      studentId,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const adminlogin = async (req, res) => {
  const { email, password } = req.body;
  try {
    // Find the user by email
    const user = await User.findOne({
      $and: [{ email }, { role: { $ne: "student" } }],
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

    // Create a JWT token with user ID and role
    const data = {
      user: {
        id: user._id,
        role: role.name,
        permissions: permissions.map((permission) => permission.name),
      },
    };
    const authToken = jwt.sign(data, JWT_SECRET);

    // Set token in cookies
    res.cookie("authToken", authToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
    });

    let studentId;
    if (role.name === "student") {
      const student = await Student.findOne({ email: user.email });
      if (student) {
        studentId = student.id;
      }
    }

    res.status(200).json({
      authToken,
      permissions: permissions.map((permission) => permission.name),
      role: role.name,
      studentId,
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

    let searchQuery = query ? query : "";
    const rolesToExclude = ["student", "secrateadmin"];
    const users = await User.paginate(
      {
        $or: [
          { name: { $regex: searchQuery, $options: "i" } },
          { email: { $regex: searchQuery, $options: "i" } },
        ],
        role: { $nin: rolesToExclude },
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
  const { name, email, role } = req.body;
  try {
    const user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ message: "User already exists" });
    }
    // const randomPassword = crypto.randomBytes(4).toString("hex");
    const randomPassword = "lcaadmin@123456";
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(randomPassword, saltRounds);
    const newUser = new User({
      name,
      email,
      password: hashedPassword,
      role,
      avatar: DEFAULT_AVATAR,
    });
    await newUser.save();

    // send welcome email to user
    // await addEmailToQueue(email, name, randomPassword);

    res.status(200).json("User added successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateUser = async (req, res) => {
  const { id } = req.params;
  const { name, email, password, role } = req.body;
  try {
    const user = await User.findById(id);
    if (!user) {
      return res.status(400).json({ message: "User does not exist" });
    }
    const hashedPassword = await bcrypt.hash(password, 12);
    await User.findByIdAndUpdate(id, {
      name,
      email,
      password: hashedPassword,
      role,
    });
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

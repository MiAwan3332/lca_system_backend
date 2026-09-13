import Role from "../models/roles.js";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { ensureAccountsRole } from "../utils/ensureAccountsRole.js";
dotenv.config();
const JWT_SECRET = process.env.JWT_SECRET;

export const getRoles = async (req, res) => {
  const { query } = req.query;
  try {
    await ensureAccountsRole();

    const searchQuery = query ? query : "";
    const roles = await Role.paginate(
      {
        $or: [
          { name: { $regex: searchQuery, $options: "i" } },
          { description: { $regex: searchQuery, $options: "i" } },
        ],
        name: { $ne: "secrateadmin" },
      },
      {
        page: parseInt(req.query.page),
        limit: parseInt(req.query.limit),
      }
    );
    res.status(200).json(roles);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getRole = async (req, res) => {
  const { id } = req.params;
  try {
    const role = await Role.findById(id);
    if (!role) {
      return res.status(400).json({ message: "Role does not exist" });
    }
    res.status(200).json(role);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const addRole = async (req, res) => {
  const { name, description } = req.body;
  try {
    const newRole = new Role({ name, description });
    await newRole.save();
    res.status(200).json("Role added successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteRole = async (req, res) => {
  const { id } = req.params;
  try {
    await Role.findByIdAndDelete(id);
    res.status(200).json("Role deleted successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateRole = async (req, res) => {
  const { id } = req.params;
  const { name, description } = req.body;
  try {
    await Role.findByIdAndUpdate(id, { name, description });
    res.status(200).json("Role updated successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const assignPermissionsToRole = async (req, res) => {
  const { roleId, permissionIds } = req.body;
  try {
    const role = await Role.findById(roleId);
    role.permissions = permissionIds;
    await role.save();
    res.status(200).json("Permissions assigned to role successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getRolePermissions = async (req, res) => {
  const { id } = req.params;
  try {
    const role = await Role.findById(id).populate("permissions");
    res.status(200).json(role.permissions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

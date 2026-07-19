/**
 * Reset (or create) the local super admin password.
 *
 * Usage:
 *   node scripts/resetSuperAdminPassword.js
 *
 * Default credentials after running:
 *   email:    superadmin@development.com
 *   password: 12345678
 *   role:     secrateadmin
 */

import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

import User from "../models/users.js";
import Role from "../models/roles.js";
import Permission from "../models/permissions.js";

dotenv.config();

const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || "superadmin@development.com";
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || "12345678";
const SUPER_ADMIN_NAME = process.env.SUPER_ADMIN_NAME || "Super Development Admin";
const SUPER_ADMIN_ROLE = "secrateadmin";

const SUPER_ADMIN_ROLE_ALIASES = [
  "secrateadmin",
  "superadmin",
  "super_admin",
  "super admin",
  "Super Admin",
  "Super_Admin",
  "super admin development",
  "Super Admin Development",
];

const DEFAULT_AVATAR =
  "https://images.unsplash.com/photo-1619946794135-5bc917a27793?ixlib=rb-0.3.5&q=80&fm=jpg&crop=faces&fit=crop&h=200&w=200&s=b616b2c5b373a80ffc9636ba24f7a4a9";

async function ensureSuperAdminRole() {
  let role = await Role.findOne({ name: SUPER_ADMIN_ROLE });

  if (!role) {
    const allPermissions = await Permission.find({}).select("_id");
    role = await Role.create({
      name: SUPER_ADMIN_ROLE,
      description: "Full access super admin (local seed)",
      permissions: allPermissions.map((p) => p._id),
    });
    console.log(`Created role "${SUPER_ADMIN_ROLE}" with ${allPermissions.length} permissions`);
    return role;
  }

  if (!role.permissions?.length) {
    const allPermissions = await Permission.find({}).select("_id");
    role.permissions = allPermissions.map((p) => p._id);
    await role.save();
    console.log(`Assigned ${allPermissions.length} permissions to role "${SUPER_ADMIN_ROLE}"`);
  }

  return role;
}

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI is missing in .env");
  }

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");

  await ensureSuperAdminRole();

  const hashedPassword = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 12);

  let user =
    (await User.findOne({ email: SUPER_ADMIN_EMAIL })) ||
    (await User.findOne({ role: { $in: SUPER_ADMIN_ROLE_ALIASES } }));

  if (user) {
    user.email = SUPER_ADMIN_EMAIL;
    user.name = user.name || SUPER_ADMIN_NAME;
    user.role = SUPER_ADMIN_ROLE;
    user.password = hashedPassword;
    if (!user.avatar) user.avatar = DEFAULT_AVATAR;
    await user.save();
    console.log(`Updated super admin password for ${user.email}`);
  } else {
    user = await User.create({
      name: SUPER_ADMIN_NAME,
      email: SUPER_ADMIN_EMAIL,
      password: hashedPassword,
      role: SUPER_ADMIN_ROLE,
      avatar: DEFAULT_AVATAR,
    });
    console.log(`Created super admin user ${user.email}`);
  }

  console.log("\nLogin with:");
  console.log(`  email:    ${SUPER_ADMIN_EMAIL}`);
  console.log(`  password: ${SUPER_ADMIN_PASSWORD}`);
  console.log(`  role:     ${SUPER_ADMIN_ROLE}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });

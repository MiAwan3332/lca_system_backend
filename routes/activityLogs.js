import express from "express";
import auth from "../middlewares/auth.js";
import {
  getActivityLogs,
  getActivityLogModules,
} from "../controllers/activityLogs.js";

const router = express.Router();

router.get("/", auth, getActivityLogs);
router.get("/filters", auth, getActivityLogModules);

export default router;

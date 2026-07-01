import express from "express";
import auth from "../middlewares/auth.js";
import {
  getNotifications,
  markAsRead,
  markAllAsRead,
} from "../controllers/notifications.js";

const router = express.Router();

router.get("/", auth, getNotifications);
router.post("/read/:id", auth, markAsRead);
router.post("/read-all", auth, markAllAsRead);

export default router;

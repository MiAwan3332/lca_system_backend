import express from "express";
import auth from "../middlewares/auth.js";
import {
  getAnnouncements,
  getAnnouncementById,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  markAnnouncementAsRead,
} from "../controllers/announcements.js";

const router = express.Router();

router.get("/", auth, getAnnouncements);
router.get("/:id", auth, getAnnouncementById);
router.post("/add", auth, createAnnouncement);
router.put("/update/:id", auth, updateAnnouncement);
router.post("/read/:id", auth, markAnnouncementAsRead);
router.delete("/delete/:id", auth, deleteAnnouncement);

export default router;

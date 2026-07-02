import express from "express";
import auth from "../middlewares/auth.js";
import {
  createComplaint,
  deleteComplaint,
  getComplaintById,
  getComplaintMeta,
  getComplaints,
  respondToComplaint,
} from "../controllers/complaints.js";

const router = express.Router();

router.get("/meta", auth, getComplaintMeta);
router.get("/", auth, getComplaints);
router.get("/:id", auth, getComplaintById);
router.post("/add", auth, createComplaint);
router.post("/respond/:id", auth, respondToComplaint);
router.delete("/delete/:id", auth, deleteComplaint);

export default router;

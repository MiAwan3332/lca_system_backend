import express from "express";
import {
  addInterviewPanel,
  getInterviewPanels,
  getInterviewPanel,
  updateInterviewPanel,
  deleteInterviewPanel,
} from "../controllers/interviewPanel.js";
import auth from "../middlewares/auth.js";

const router = express.Router();

router.get("/", auth, getInterviewPanels);
router.get("/:id", auth, getInterviewPanel);
router.post("/add", auth, addInterviewPanel);
router.post("/update/:id", auth, updateInterviewPanel);
router.delete("/delete/:id", auth, deleteInterviewPanel);

export default router;

import express from "express";
import {
  addInterviewPanel,
  getInterviewPanels,
  getInterviewPanel,
  updateInterviewPanel,
  bookInterviewSlot,
  deleteInterviewPanel,
  startInterview,
  getConductInterview,
  submitInterviewEvaluation,
  getInterviewEvaluationDetails,
} from "../controllers/interviewPanel.js";
import auth from "../middlewares/auth.js";

const router = express.Router();

router.get("/", auth, getInterviewPanels);
router.get("/conduct/:id/:scheduleIndex", auth, getConductInterview);
router.get(
  "/evaluation-details/:id/:scheduleIndex",
  auth,
  getInterviewEvaluationDetails
);
router.post("/start-interview/:id", auth, startInterview);
router.post("/submit-evaluation/:id", auth, submitInterviewEvaluation);
router.get("/:id", auth, getInterviewPanel);
router.post("/add", auth, addInterviewPanel);
router.post("/update/:id", auth, updateInterviewPanel);
router.post("/book/:id", auth, bookInterviewSlot);
router.delete("/delete/:id", auth, deleteInterviewPanel);

export default router;

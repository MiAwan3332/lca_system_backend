import express from "express";
import auth from "../middlewares/auth.js";
import {
  createAssignment,
  getAssignments,
  getAssignmentById,
  updateAssignment,
  deleteAssignment,
  publishAssignment,
  submitAssignment,
  getAssignmentSubmissions,
  gradeSubmission,
  getBatchCoursesForAssignment,
} from "../controllers/assignments.js";

const router = express.Router();

router.get("/", auth, getAssignments);
router.get("/batch/:batchId/courses", auth, getBatchCoursesForAssignment);
router.get("/submissions/list", auth, getAssignmentSubmissions);
router.get("/:id", auth, getAssignmentById);
router.post("/add", auth, createAssignment);
router.post("/update/:id", auth, updateAssignment);
router.post("/publish/:id", auth, publishAssignment);
router.post("/submit/:id", auth, submitAssignment);
router.delete("/delete/:id", auth, deleteAssignment);
router.post("/submissions/:id/grade", auth, gradeSubmission);

export default router;

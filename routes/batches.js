import express from "express";
import {
  getBatches,
  getBatch,
  addBatch,
  updateBatch,
  deleteBatch,
  toggleBatchStatus,
  assignCoursesToBatch,
  assignTeachersToBatch,
  getBatchCourses,
  getBatchTeachers,
  getBatchTeacherAssignments,
  assignTeacherCoursesToBatch,
  getDeletedBatches,
  getDeletedBatchArchive,
} from "../controllers/batches.js";
import auth from "../middlewares/auth.js";

const router = express.Router();

router.get("/", auth, getBatches);
router.get("/deletion-archives", auth, getDeletedBatches);
router.get("/deletion-archives/:id", auth, getDeletedBatchArchive);
router.get("/courses/:id", auth, getBatchCourses);
router.get("/teachers/:id", auth, getBatchTeachers);
router.get("/teacher-assignments/:id", auth, getBatchTeacherAssignments);
router.get("/:id", auth, getBatch);
router.post("/add", auth, addBatch);
router.post("/update/:id", auth, updateBatch);
router.post("/toggle-status/:id", auth, toggleBatchStatus);
router.delete("/delete/:id", auth, deleteBatch);
router.post("/assignCourses", auth, assignCoursesToBatch);
router.post("/assignTeachers", auth, assignTeachersToBatch);
router.post("/assignTeacherCourses", auth, assignTeacherCoursesToBatch);

export default router;

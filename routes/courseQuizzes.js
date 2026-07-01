import express from "express";
import auth from "../middlewares/auth.js";
import {
  createCourseQuiz,
  getCourseQuizzes,
  getCourseQuizById,
  updateCourseQuiz,
  deleteCourseQuiz,
  publishCourseQuiz,
  startCourseQuizAttempt,
  saveCourseQuizAnswer,
  submitCourseQuizAttempt,
  getCourseQuizAttempts,
  getCourseQuizAttemptById,
  reviewCourseQuizAttempt,
  publishCourseQuizResults,
  getBatchCoursesForQuiz,
} from "../controllers/courseQuizzes.js";

const router = express.Router();

router.get("/", auth, getCourseQuizzes);
router.get("/batch/:batchId/courses", auth, getBatchCoursesForQuiz);
router.get("/attempts", auth, getCourseQuizAttempts);
router.get("/attempts/:id", auth, getCourseQuizAttemptById);
router.get("/:id", auth, getCourseQuizById);
router.post("/add", auth, createCourseQuiz);
router.post("/update/:id", auth, updateCourseQuiz);
router.post("/publish/:id", auth, publishCourseQuiz);
router.post("/:id/start", auth, startCourseQuizAttempt);
router.post("/attempts/:attemptId/answer", auth, saveCourseQuizAnswer);
router.post("/attempts/:attemptId/submit", auth, submitCourseQuizAttempt);
router.post("/attempts/:id/review", auth, reviewCourseQuizAttempt);
router.post("/:id/publish-results", auth, publishCourseQuizResults);
router.delete("/delete/:id", auth, deleteCourseQuiz);

export default router;

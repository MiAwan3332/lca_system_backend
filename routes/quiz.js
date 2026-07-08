import express from "express";
import auth from "../middlewares/auth.js";
import {
  getQuizSubjects,
  startQuiz,
  getQuizAttempt,
  saveQuizAnswer,
  submitQuiz,
  getQuizAttempts,
  getQuizAttemptLog,
} from "../controllers/quiz.js";

const router = express.Router();

router.get("/subjects", auth, getQuizSubjects);
router.post("/start", auth, startQuiz);
router.get("/attempts", auth, getQuizAttempts);
router.get("/attempts/:id/log", auth, getQuizAttemptLog);
router.get("/attempts/:id", auth, getQuizAttempt);
router.post("/attempts/:id/answer", auth, saveQuizAnswer);
router.post("/attempts/:id/submit", auth, submitQuiz);

export default router;

import express from "express";
import { createAttendence, getAttendences, getAttendanceByStudentId,getTodayAttendenceByStudentId } from "../controllers/attendence.js";
import auth from "../middlewares/auth.js";

const router = express.Router();

router.get("/", auth, getAttendences);
router.post("/create", auth, createAttendence);
router.get("/studentAttendence/:student_id", auth, getTodayAttendenceByStudentId);


export default router
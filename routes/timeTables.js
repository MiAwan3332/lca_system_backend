import express from "express";
import { createTimeTable, updateTimeTable, getTimeTableById, getAllTimeTables, deleteTimeTable, getTimeTableByStudentId, getTodayTimeTables } from "../controllers/timeTables.js";
import auth from "../middlewares/auth.js";

const router = express.Router();

router.post('/add', auth, createTimeTable);
router.put('/update/:id', auth, updateTimeTable);
router.get('/:id', auth, getTimeTableById);
router.get('/', auth, getAllTimeTables);
router.post('/delete/:id',auth,deleteTimeTable);
router.get('/get-time-table-by-student-id/:id', auth, getTimeTableByStudentId);
router.get('/today/get', auth, getTodayTimeTables);

export default router
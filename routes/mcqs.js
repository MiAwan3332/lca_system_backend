import express from "express"
import { getAllMcqs, getMcqById, createMcq, updateMcq, deleteMcq, getMcqsByCourseId } from "../controllers/mcqs.js";
import auth from "../middlewares/auth.js";

const router = express.Router();

//make routes with auth middle ware
router.get('/', getAllMcqs)
router.get('/course/:id', getMcqsByCourseId)
router.get('/:id', getMcqById)
router.post('/add', auth, createMcq)
router.post('/update/:id', auth, updateMcq)
router.delete('/delete/:id', auth, deleteMcq)

export default router
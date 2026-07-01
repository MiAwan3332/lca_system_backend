import express from "express"
import { getAllMcqs, getMcqById, createMcq, updateMcq, deleteMcq, getMcqsByCourseId, bulkImportMcqs } from "../controllers/mcqs.js";
import auth from "../middlewares/auth.js";

const router = express.Router();

//make routes with auth middle ware
router.get('/', auth, getAllMcqs)
router.get('/course/:id', auth, getMcqsByCourseId)
router.get('/:id', auth, getMcqById)
router.post('/add', auth, createMcq)
router.post('/bulk-import', auth, bulkImportMcqs)
router.post('/update/:id', auth, updateMcq)
router.delete('/delete/:id', auth, deleteMcq)

export default router
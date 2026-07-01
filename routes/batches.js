import express from "express";
import { getBatches, getBatch, addBatch, updateBatch, deleteBatch,assignCoursesToBatch,assignTeachersToBatch,getBatchCourses,getBatchTeachers,getBatchTeacherAssignments,assignTeacherCoursesToBatch } from "../controllers/batches.js";
import auth from "../middlewares/auth.js";

const router = express.Router();

//make routes with auth middle ware
router.get('/',auth,getBatches)
router.get('/:id',auth,getBatch)
router.post('/add',auth,addBatch);
router.post('/update/:id',auth,updateBatch);
router.delete('/delete/:id',auth,deleteBatch);
router.get('/courses/:id',auth,getBatchCourses)
router.get('/teachers/:id',auth,getBatchTeachers)
router.get('/teacher-assignments/:id',auth,getBatchTeacherAssignments)
router.post('/assignCourses',auth,assignCoursesToBatch)
router.post('/assignTeachers',auth,assignTeachersToBatch)
router.post('/assignTeacherCourses',auth,assignTeacherCoursesToBatch)


export default router
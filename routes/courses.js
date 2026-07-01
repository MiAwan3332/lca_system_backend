import express from 'express';
import { getCourse, getCourses, addCourse, updateCourse, deleteCourse, getBatchAndCourses} from '../controllers/courses.js';
import auth from '../middlewares/auth.js';

const router = express.Router();

//make routes with auth middle ware
router.get('/',auth,getCourses)
router.get('/:id',auth,getCourse)
router.post('/add',auth,addCourse);
router.post('/update/:id',auth,updateCourse);
router.delete('/delete/:id',auth,deleteCourse);
router.get('/student/courses/:studentId',auth,getBatchAndCourses);

export default router
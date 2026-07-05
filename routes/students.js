import express from 'express';
import { getStudent, getStudents, addStudent, getStudentsContacts, updateStudent, deleteStudent, getQrCode, updateStudentinfo, checkStudentFields, basicStudentUpdate, getStudentsGraph, getStudentsByBatchesGraph, deleteAllStudents, getStudentsByBatch, changeStudentPassword, getStudentPaymentLogs, toggleStudentStatus, toggleBatchStudentsStatus } from '../controllers/students.js';
import auth from '../middlewares/auth.js';

const router = express.Router();

//make routes with auth middle ware
router.get('/',auth,getStudents)
router.post('/change-password/:id', auth, changeStudentPassword);
router.get('/batch/:batchId', auth, getStudentsByBatch);
router.post('/batch/:batchId/toggle-status', auth, toggleBatchStudentsStatus);
router.post('/toggle-status/:id', auth, toggleStudentStatus);
router.get('/payment-logs/:id', auth, getStudentPaymentLogs);
router.get('/:id',auth,getStudent)
router.post('/add',auth,addStudent);
router.post('/update/:id',auth,updateStudent);
router.delete('/delete/:id',auth,deleteStudent);
router.get('/qrcode/:id',auth,getQrCode);
router.post('/studentInfoUpdate/:id',auth,updateStudentinfo);
router.get('/checkStudentFields/:id',auth,checkStudentFields);
router.post('/basic-update/:id',auth,basicStudentUpdate);
router.get('/students/graph',auth,getStudentsGraph)
router.get('/students/Batchesgraph',auth,getStudentsByBatchesGraph)
router.get('/students/getStudentsContacts',auth,getStudentsContacts)
router.delete('/deleteAllStudents',auth,deleteAllStudents);


export default router
import express from "express"
import { getFees, getFeeById, createFee, payFee, discountFee, deleteFee, getFeeLogs, getFeesByStudentId, getFinanceReport } from "../controllers/fees.js";
import auth from "../middlewares/auth.js";

const router = express.Router();

router.get('/report', auth, getFinanceReport)
router.get('/',auth,getFees)
router.get('/:id',auth,getFeeById)
router.post('/create',auth,createFee)
router.post('/pay/:id',auth,payFee)
router.post('/discount/:id',auth,discountFee)
router.delete('/delete/:id',auth,deleteFee)
router.get('/logs/:id',auth,getFeeLogs)
router.get('/student/:id',auth,getFeesByStudentId)

export default router
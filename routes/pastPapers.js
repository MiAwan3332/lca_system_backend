import express from "express"
import { getAllPastPapers, getPastPaperById, createPastPaper, updatePastPaper, deletePastPaper, getPastPaperByCourseAndYear} from "../controllers/pastPapers.js";
import auth from "../middlewares/auth.js";

const router = express.Router();

router.get('/',auth,getAllPastPapers)
router.get('/:id',auth,getPastPaperById)
router.post('/add',auth,createPastPaper)
router.post('/update/:id',auth,updatePastPaper)
router.delete('/delete/:id',auth,deletePastPaper)
router.post('/pastPapers/papers',auth,getPastPaperByCourseAndYear)

export default router
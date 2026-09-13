import express from 'express';
import { getStatistics, getBatchFinanceStats } from '../controllers/statistics.js';
import auth from '../middlewares/auth.js';

const router = express.Router();

router.get('/', auth, getStatistics);
router.get('/batch-finance', auth, getBatchFinanceStats);

export default router;

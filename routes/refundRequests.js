import express from "express";
import {
  getRefundRequests,
  createRefundRequest,
  approveRefundRequest,
  rejectRefundRequest,
  processRefundRequest,
} from "../controllers/refundRequests.js";
import auth from "../middlewares/auth.js";

const router = express.Router();

router.get("/", auth, getRefundRequests);
router.post("/add", auth, createRefundRequest);
router.post("/approve/:id", auth, approveRefundRequest);
router.post("/reject/:id", auth, rejectRefundRequest);
router.post("/process/:id", auth, processRefundRequest);

export default router;

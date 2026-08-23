import express from "express";
import auth from "../middlewares/auth.js";
import {
  issueAdmissionSlipVerification,
  verifyAdmissionSlip,
} from "../controllers/admissionSlipVerification.js";

const router = express.Router();

router.post("/issue", auth, issueAdmissionSlipVerification);
router.get("/verify/:token", verifyAdmissionSlip);

export default router;

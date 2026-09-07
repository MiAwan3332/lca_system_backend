import express from "express";
import auth from "../middlewares/auth.js";
import {
  addQualifier,
  bulkImportQualifiers,
  changeQualifierPassword,
  deleteQualifier,
  getQualifier,
  getQualifiers,
  toggleQualifierStatus,
  updateQualifier,
} from "../controllers/qualifiers.js";

const router = express.Router();

router.get("/", auth, getQualifiers);
router.get("/:id", auth, getQualifier);
router.post("/add", auth, addQualifier);
router.post("/bulk-import", auth, bulkImportQualifiers);
router.post("/update/:id", auth, updateQualifier);
router.post("/toggle-status/:id", auth, toggleQualifierStatus);
router.post("/change-password/:id", auth, changeQualifierPassword);
router.delete("/delete/:id", auth, deleteQualifier);

export default router;

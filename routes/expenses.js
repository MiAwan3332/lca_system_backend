import express from "express";
import {
  getExpenses,
  getExpense,
  addExpense,
  updateExpense,
  deleteExpense,
  approveExpense,
  rejectExpense,
} from "../controllers/expenses.js";
import auth from "../middlewares/auth.js";

const router = express.Router();

router.get("/", auth, getExpenses);
router.post("/add", auth, addExpense);
router.post("/approve/:id", auth, approveExpense);
router.post("/reject/:id", auth, rejectExpense);
router.get("/:id", auth, getExpense);
router.post("/update/:id", auth, updateExpense);
router.delete("/delete/:id", auth, deleteExpense);

export default router;

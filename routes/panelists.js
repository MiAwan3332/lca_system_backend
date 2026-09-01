import express from "express";
import auth from "../middlewares/auth.js";
import {
  addPanelist,
  deletePanelist,
  getPanelist,
  getPanelists,
  updatePanelist,
  changePanelistPassword,
} from "../controllers/panelists.js";

const router = express.Router();

router.get("/", auth, getPanelists);
router.get("/:id", auth, getPanelist);
router.post("/add", auth, addPanelist);
router.post("/update/:id", auth, updatePanelist);
router.post("/change-password/:id", auth, changePanelistPassword);
router.delete("/delete/:id", auth, deletePanelist);

export default router;

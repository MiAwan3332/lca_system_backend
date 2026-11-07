import express from "express";
import auth from "../middlewares/auth.js";
import { lookupPanelistIdentity } from '../utils/panelistProvisioning.js';
import {
  addPanelist,
  deletePanelist,
  getPanelist,
  getPanelists,
  updatePanelist,
  changePanelistPassword,
  togglePanelistStatus,
} from "../controllers/panelists.js";

const router = express.Router();
router.post('/identity/lookup', auth, lookupPanelistIdentity);

router.get("/", auth, getPanelists);
router.get("/:id", auth, getPanelist);
router.post("/add", auth, addPanelist);
router.post("/update/:id", auth, updatePanelist);
router.post('/toggle-status/:id',auth,togglePanelistStatus);
router.post("/change-password/:id", auth, changePanelistPassword);
router.delete("/delete/:id", auth, deletePanelist);

export default router;

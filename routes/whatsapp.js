import express from "express";
import auth from "../middlewares/auth.js";
import { denyUnlessPlatformSuperAdmin } from "../utils/lmsAccess.js";
import {
  connectWhatsApp,
  createWhatsAppSession,
  deleteWhatsAppSession,
  getWhatsAppConfig,
  getWhatsAppSession,
  getWhatsAppSessionQr,
  listWhatsAppSessions,
  logoutWhatsAppSession,
  requestWhatsAppPairingCode,
  startWhatsAppSession,
  stopWhatsAppSession,
} from "../controllers/whatsapp.js";
import {
  createWhatsAppTemplate,
  deleteWhatsAppTemplate,
  getWhatsAppTemplate,
  listWhatsAppTemplateTags,
  listWhatsAppTemplates,
  previewWhatsAppTemplate,
  testWhatsAppTemplate,
  updateWhatsAppTemplate,
} from "../controllers/whatsappTemplates.js";

const router = express.Router();

const requirePlatformSuperAdmin = (req, res, next) => {
  if (denyUnlessPlatformSuperAdmin(req, res)) return;
  next();
};

// WhatsApp Connect + Templates: Super Admin only
router.use(auth, requirePlatformSuperAdmin);

router.get("/config", getWhatsAppConfig);
router.get("/sessions", listWhatsAppSessions);
router.post("/sessions", createWhatsAppSession);
router.post("/connect", connectWhatsApp);
router.get("/sessions/:id", getWhatsAppSession);
router.post("/sessions/:id/start", startWhatsAppSession);
router.post("/sessions/:id/stop", stopWhatsAppSession);
router.post("/sessions/:id/logout", logoutWhatsAppSession);
router.delete("/sessions/:id", deleteWhatsAppSession);
router.get("/sessions/:id/qr", getWhatsAppSessionQr);
router.post("/sessions/:id/pairing-code", requestWhatsAppPairingCode);

router.get("/templates/tags", listWhatsAppTemplateTags);
router.get("/templates", listWhatsAppTemplates);
router.post("/templates", createWhatsAppTemplate);
router.get("/templates/:keyOrId", getWhatsAppTemplate);
router.put("/templates/:keyOrId", updateWhatsAppTemplate);
router.delete("/templates/:keyOrId", deleteWhatsAppTemplate);
router.post("/templates/:keyOrId/preview", previewWhatsAppTemplate);
router.post("/templates/:keyOrId/test", testWhatsAppTemplate);

export default router;

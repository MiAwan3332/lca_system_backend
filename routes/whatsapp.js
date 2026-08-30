import express from "express";
import auth from "../middlewares/auth.js";
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

router.get("/config", auth, getWhatsAppConfig);
router.get("/sessions", auth, listWhatsAppSessions);
router.post("/sessions", auth, createWhatsAppSession);
router.post("/connect", auth, connectWhatsApp);
router.get("/sessions/:id", auth, getWhatsAppSession);
router.post("/sessions/:id/start", auth, startWhatsAppSession);
router.post("/sessions/:id/stop", auth, stopWhatsAppSession);
router.post("/sessions/:id/logout", auth, logoutWhatsAppSession);
router.delete("/sessions/:id", auth, deleteWhatsAppSession);
router.get("/sessions/:id/qr", auth, getWhatsAppSessionQr);
router.post("/sessions/:id/pairing-code", auth, requestWhatsAppPairingCode);

router.get("/templates/tags", auth, listWhatsAppTemplateTags);
router.get("/templates", auth, listWhatsAppTemplates);
router.post("/templates", auth, createWhatsAppTemplate);
router.get("/templates/:keyOrId", auth, getWhatsAppTemplate);
router.put("/templates/:keyOrId", auth, updateWhatsAppTemplate);
router.delete("/templates/:keyOrId", auth, deleteWhatsAppTemplate);
router.post("/templates/:keyOrId/preview", auth, previewWhatsAppTemplate);
router.post("/templates/:keyOrId/test", auth, testWhatsAppTemplate);

export default router;

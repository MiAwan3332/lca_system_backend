import {
  getOpenWaPublicConfig,
  isOpenWaConfigured,
  openWaRequest,
} from "../utils/openwaClient.js";

const sendOpenWaError = (res, error) => {
  const status = error.status || 500;
  return res.status(status).json({
    message: error.message || "OpenWA request failed",
    details: error.data || undefined,
  });
};

/** Public config for the admin UI (never exposes API key). */
export const getWhatsAppConfig = async (_req, res) => {
  try {
    res.status(200).json(getOpenWaPublicConfig());
  } catch (error) {
    sendOpenWaError(res, error);
  }
};

/** List all WhatsApp sessions on the OpenWA gateway. */
export const listWhatsAppSessions = async (_req, res) => {
  try {
    if (!isOpenWaConfigured()) {
      return res.status(503).json({
        message:
          "OpenWA is not configured. Set OPENWA_BASE_URL and OPENWA_API_KEY.",
      });
    }
    const data = await openWaRequest("GET", "/api/sessions");
    res.status(200).json(data);
  } catch (error) {
    sendOpenWaError(res, error);
  }
};

/** Create a new WhatsApp session. */
export const createWhatsAppSession = async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name || name.length < 3 || name.length > 50) {
      return res.status(400).json({
        message:
          "Session name must be 3–50 characters (letters, digits, hyphens).",
      });
    }
    if (!/^[A-Za-z0-9-]+$/.test(name)) {
      return res.status(400).json({
        message: "Session name may only contain letters, digits, and hyphens.",
      });
    }

    const data = await openWaRequest("POST", "/api/sessions", {
      body: { name },
    });
    res.status(200).json(data);
  } catch (error) {
    sendOpenWaError(res, error);
  }
};

/** Get one session by id. */
export const getWhatsAppSession = async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const data = await openWaRequest("GET", `/api/sessions/${id}`);
    res.status(200).json(data);
  } catch (error) {
    sendOpenWaError(res, error);
  }
};

/** Start session (boots engine / shows QR). */
export const startWhatsAppSession = async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const data = await openWaRequest("POST", `/api/sessions/${id}/start`, {
      timeoutMs: 60000,
    });
    res.status(200).json(data);
  } catch (error) {
    sendOpenWaError(res, error);
  }
};

/** Stop session (disconnect, keep credentials). */
export const stopWhatsAppSession = async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const data = await openWaRequest("POST", `/api/sessions/${id}/stop`);
    res.status(200).json(data);
  } catch (error) {
    sendOpenWaError(res, error);
  }
};

/** Logout (unlink device) then stop. */
export const logoutWhatsAppSession = async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const data = await openWaRequest("POST", `/api/sessions/${id}/logout`, {
      timeoutMs: 60000,
    });
    res.status(200).json(data);
  } catch (error) {
    sendOpenWaError(res, error);
  }
};

/** Delete session. */
export const deleteWhatsAppSession = async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const data = await openWaRequest("DELETE", `/api/sessions/${id}`);
    res.status(200).json(data ?? { success: true });
  } catch (error) {
    sendOpenWaError(res, error);
  }
};

/** Get QR code data URL for linking. */
export const getWhatsAppSessionQr = async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const data = await openWaRequest("GET", `/api/sessions/${id}/qr`);
    res.status(200).json(data);
  } catch (error) {
    sendOpenWaError(res, error);
  }
};

/** Request pairing code (alternative to QR). */
export const requestWhatsAppPairingCode = async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const phoneNumber = String(req.body?.phoneNumber || "")
      .replace(/\D/g, "");
    if (!phoneNumber || phoneNumber.length < 8) {
      return res.status(400).json({
        message:
          "Enter phone number in international format digits only (e.g. 923001234567).",
      });
    }

    const data = await openWaRequest(
      "POST",
      `/api/sessions/${id}/pairing-code`,
      { body: { phoneNumber } }
    );
    res.status(200).json(data);
  } catch (error) {
    sendOpenWaError(res, error);
  }
};

/**
 * One-click connect helper:
 * ensure a session exists (by name), start it, return session + QR when available.
 */
export const connectWhatsApp = async (req, res) => {
  try {
    if (!isOpenWaConfigured()) {
      return res.status(503).json({
        message:
          "OpenWA is not configured. Set OPENWA_BASE_URL and OPENWA_API_KEY.",
      });
    }

    const config = getOpenWaPublicConfig();
    const requestedName = String(req.body?.name || "").trim();
    const sessionName =
      requestedName || config.default_session_name || "lca-portal";

    if (!/^[A-Za-z0-9-]{3,50}$/.test(sessionName)) {
      return res.status(400).json({
        message:
          "Session name must be 3–50 characters (letters, digits, hyphens).",
      });
    }

    let sessionsPayload = await openWaRequest("GET", "/api/sessions");
    const sessions = Array.isArray(sessionsPayload)
      ? sessionsPayload
      : Array.isArray(sessionsPayload?.data)
        ? sessionsPayload.data
        : Array.isArray(sessionsPayload?.sessions)
          ? sessionsPayload.sessions
          : [];

    let session =
      sessions.find((s) => String(s?.name || "") === sessionName) || null;

    if (!session) {
      session = await openWaRequest("POST", "/api/sessions", {
        body: { name: sessionName },
      });
    }

    const sessionId = session?.id || session?._id;
    if (!sessionId) {
      return res.status(500).json({ message: "OpenWA did not return a session id." });
    }

    const status = String(session?.status || "").toLowerCase();
    const needsStart = [
      "",
      "created",
      "disconnected",
      "failed",
      "action_required",
    ].includes(status);

    if (needsStart) {
      try {
        session = await openWaRequest("POST", `/api/sessions/${sessionId}/start`, {
          timeoutMs: 60000,
        });
      } catch (startError) {
        // Already started / racing is fine — re-fetch session
        if (![409, 400].includes(startError.status)) {
          throw startError;
        }
        session = await openWaRequest("GET", `/api/sessions/${sessionId}`);
      }
    }

    let qr = null;
    try {
      qr = await openWaRequest("GET", `/api/sessions/${sessionId}/qr`);
    } catch {
      qr = null;
    }

    res.status(200).json({
      session,
      qr,
      gateway: config.base_url,
    });
  } catch (error) {
    sendOpenWaError(res, error);
  }
};

/**
 * OpenWA HTTP client — credentials stay on the server only.
 * Docs: https://docs.open-wa.org/api-reference
 */
export const getOpenWaConfig = () => {
  const baseUrl = String(process.env.OPENWA_BASE_URL || "")
    .trim()
    .replace(/\/$/, "");
  const apiKey = String(process.env.OPENWA_API_KEY || "").trim();
  const defaultSessionName =
    String(process.env.OPENWA_SESSION_NAME || "lca-portal").trim() ||
    "lca-portal";

  return { baseUrl, apiKey, defaultSessionName };
};

export const isOpenWaConfigured = () => {
  const { baseUrl, apiKey } = getOpenWaConfig();
  return Boolean(baseUrl && apiKey);
};

export const openWaRequest = async (method, path, { body, timeoutMs = 45000 } = {}) => {
  const { baseUrl, apiKey } = getOpenWaConfig();
  if (!baseUrl || !apiKey) {
    const error = new Error(
      "OpenWA is not configured. Set OPENWA_BASE_URL and OPENWA_API_KEY in the backend .env."
    );
    error.status = 503;
    throw error;
  }

  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
        ...(body != null ? { "Content-Type": "application/json" } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text };
      }
    }

    if (!response.ok) {
      const message =
        data?.message ||
        data?.error ||
        data?.error?.message ||
        `OpenWA request failed (${response.status})`;
      const error = new Error(message);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("OpenWA request timed out.");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

export const getOpenWaPublicConfig = () => {
  const { baseUrl, defaultSessionName } = getOpenWaConfig();
  return {
    configured: isOpenWaConfigured(),
    base_url: baseUrl || null,
    default_session_name: defaultSessionName,
  };
};

export default {
  getOpenWaConfig,
  getOpenWaPublicConfig,
  isOpenWaConfigured,
  openWaRequest,
};

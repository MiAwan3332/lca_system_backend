import crypto from "crypto";
import { creationAudit } from './creationAudit.js';

const windows = new Map();
export function recentRequestMetrics() {
  const cutoff = Math.floor(Date.now() / 60000) - 4;
  const result = { requests: 0, serverErrors: 0, gatewayTimeouts: 0, disconnected: 0 };
  for (const [minute, counts] of windows) {
    if (minute < cutoff) windows.delete(minute);
    else for (const field of Object.keys(result)) result[field] += counts[field];
  }
  return result;
}

export const requestObservability = (req, res, next) => {
  const supplied = String(req.get('x-request-id') || '');
  const requestId = /^[a-zA-Z0-9_-]{1,100}$/.test(supplied) ? supplied : crypto.randomUUID();
  const startedAt = Date.now();

  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    const minute = Math.floor(Date.now() / 60000);
    const counts = windows.get(minute) || { requests: 0, serverErrors: 0, gatewayTimeouts: 0, disconnected: 0 };
    counts.requests++;
    if (res.statusCode >= 500) counts.serverErrors++;
    if (res.statusCode === 504) counts.gatewayTimeouts++;
    windows.set(minute, counts);
    recentRequestMetrics();
    if (res.statusCode >= 400 || durationMs >= 2000 || /^\/(students|users)\/add\/?$/.test(req.path)) {
      creationAudit('http_request', {
          level: res.statusCode >= 500 ? "error" : "info",
          requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs,
          userId: req.user?.user?.id || null,
        });
    }
  });
  res.once('close', () => {
    if (res.writableFinished) return;
    const minute = Math.floor(Date.now() / 60000);
    const counts = windows.get(minute) || { requests: 0, serverErrors: 0, gatewayTimeouts: 0, disconnected: 0 };
    counts.disconnected++;
    windows.set(minute, counts);
    creationAudit('http_disconnected', { requestId, method: req.method, path: req.path, durationMs: Date.now() - startedAt });
  });

  next();
};

export const errorHandler = (error, req, res, _next) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "unhandled_request_error",
      requestId: req.requestId || null,
      method: req.method,
      path: req.originalUrl,
      message: error?.message || "Unknown error",
    })
  );

  if (res.headersSent) return;
  res.status(error?.status || 500).json({
    message: error?.message || "Internal server error",
    ...(error?.code === 'CREATION_NOT_COMMITTED' ? { code: error.code } : {}),
    requestId: req.requestId || null,
  });
};

import crypto from "crypto";
import { creationAudit } from './creationAudit.js';
import { errorDiagnostic } from './operationalDiagnostics.js';

const windows = new Map();
const failures = [];
export function recentRequestFailures() {
  while (failures.length && failures[0].time < Date.now() - 300000) failures.shift();
  return failures.slice(-20);
}
const captureFailure = (entry) => {
  failures.push({ time: Date.now(), ...entry });
  if (failures.length > 100) failures.shift();
};
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
    const queueHealthWarning = res.statusCode === 503 && req.path === '/operations/creation-metrics';
    if (res.statusCode >= 500 && !queueHealthWarning) counts.serverErrors++;
    if (res.statusCode === 504) counts.gatewayTimeouts++;
    windows.set(minute, counts);
    if (res.statusCode >= 500 && !queueHealthWarning) captureFailure({ requestId, method: req.method, path: req.route?.path || req.path.split('?')[0],
      status: res.statusCode, durationMs, userId: req.user?.user?.id, diagnostic: req.operationalError });
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
    captureFailure({ requestId, method: req.method, path: req.route?.path || req.path.split('?')[0],
      status: 'disconnected', durationMs: Date.now() - startedAt });
    creationAudit('http_disconnected', { requestId, method: req.method, path: req.path, durationMs: Date.now() - startedAt });
  });

  next();
};

export const errorHandler = (error, req, res, _next) => {
  req.operationalError = errorDiagnostic(error);
  console.error(
    JSON.stringify({
      level: "error",
      event: "unhandled_request_error",
      requestId: req.requestId || null,
      method: req.method,
      path: req.route?.path || req.path.split('?')[0],
      diagnostic: req.operationalError,
    })
  );

  if (res.headersSent) return;
  res.status(error?.status || 500).json({
    message: error?.message || "Internal server error",
    ...(error?.code === 'CREATION_NOT_COMMITTED' ? { code: error.code } : {}),
    requestId: req.requestId || null,
  });
};

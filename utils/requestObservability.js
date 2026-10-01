import crypto from "crypto";

export const requestObservability = (req, res, next) => {
  const requestId = String(req.get("x-request-id") || crypto.randomUUID());
  const startedAt = Date.now();

  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    if (res.statusCode >= 400 || durationMs >= 2000) {
      console.log(
        JSON.stringify({
          level: res.statusCode >= 500 ? "error" : "info",
          event: "http_request",
          requestId,
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs,
          userId: req.user?.user?.id || null,
        })
      );
    }
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
    requestId: req.requestId || null,
  });
};

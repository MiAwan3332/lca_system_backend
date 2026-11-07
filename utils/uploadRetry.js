import { setTimeout as sleep } from 'node:timers/promises';

export const isRetryableUploadError = (error) => {
  const status = error.$metadata?.httpStatusCode;
  return status === 408 || status === 429 || status >= 500 ||
    ['TimeoutError', 'AbortError', 'RequestTimeout', 'SlowDown', 'ServiceUnavailable'].includes(error.name) ||
    ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error.code);
};

export const retryUpload = async ({ run, attempts = 3, deadlineMs = 60000,
  attemptTimeoutMs = 15000, onAttempt = () => {}, delay = sleep }) => {
  const started = Date.now();
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remaining = deadlineMs - (Date.now() - started);
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, attemptTimeoutMs));
    const attemptStarted = Date.now();
    try {
      const result = await run({ attempt, signal: controller.signal });
      onAttempt({ attempt, durationMs: Date.now() - attemptStarted, result });
      return result;
    } catch (error) {
      lastError = error;
      onAttempt({ attempt, durationMs: Date.now() - attemptStarted, error });
      if (!isRetryableUploadError(error) || attempt === attempts) throw error;
    } finally {
      clearTimeout(timer);
    }
    const backoff = Math.min(500 * 2 ** (attempt - 1), deadlineMs - (Date.now() - started));
    if (backoff <= 0) break;
    await delay(backoff);
  }
  const error = new Error('Object storage upload exceeded its overall deadline', { cause: lastError });
  error.name = 'TimeoutError';
  throw error;
};

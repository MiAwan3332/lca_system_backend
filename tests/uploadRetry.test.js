import test from 'node:test';
import assert from 'node:assert/strict';
import { retryUpload } from '../utils/uploadRetry.js';

test('a transient failure starts a fresh attempt and succeeds', async () => {
  const signals = [];
  const result = await retryUpload({
    delay: async () => {},
    run: async ({ signal, attempt }) => {
      signals.push(signal);
      if (attempt === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      return 'uploaded';
    },
  });
  assert.equal(result, 'uploaded');
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
});

test('permission failures are returned immediately', async () => {
  let calls = 0;
  await assert.rejects(retryUpload({ run: async () => {
    calls += 1;
    throw Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } });
  } }), /denied/);
  assert.equal(calls, 1);
});

test('stalled requests are aborted within the total budget', async () => {
  const started = Date.now();
  let calls = 0;
  await assert.rejects(retryUpload({ deadlineMs: 60, attemptTimeoutMs: 20,
    delay: async () => {}, run: ({ signal }) => new Promise((resolve, reject) => {
      calls += 1;
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }),
  }));
  assert.ok(calls <= 3);
  assert.ok(Date.now() - started < 500);
});

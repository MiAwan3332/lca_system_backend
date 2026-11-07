import test from 'node:test';
import assert from 'node:assert/strict';
import { errorDiagnostic, redactDiagnostic } from '../utils/operationalDiagnostics.js';
import { requestObservability, recentRequestFailures, recentRequestMetrics, errorHandler } from '../utils/requestObservability.js';
import { EventEmitter } from 'node:events';

test('diagnostics retain actionable codes without credentials or URLs', () => {
  process.env.TEST_API_KEY = 'super-secret-test-only';
  const error = Object.assign(new Error('socket timed out password=private-value https://example.invalid/?token=private super-secret-test-only'),
    { code: 'ETIMEDOUT', status: 504, cause: new Error('connection timed out'), $metadata: { requestId: 'provider-123' } });
  const result = errorDiagnostic(error);
  assert.equal(result.code, 'ETIMEDOUT'); assert.equal(result.status, 504);
  assert.equal(result.providerRequestId, 'provider-123'); assert.ok(result.message.includes('socket timed out'));
  assert.ok(!JSON.stringify(result).includes('private')); assert.ok(!JSON.stringify(result).includes('super-secret-test-only'));
  assert.equal(redactDiagnostic('x'.repeat(5000)).length, 3000);
  delete process.env.TEST_API_KEY;
});

test('HTTP failures retain route, request ID, duration and diagnostic without query/body', () => {
  const req = { get: () => 'test-request-id', path: '/students/add', originalUrl: '/students/add?token=do-not-log',
    method: 'POST', user: { user: { id: 'operator' } }, body: { password: 'never include me' } };
  const res = new EventEmitter(); Object.assign(res, { setHeader() {}, status(code) { this.statusCode = code; return this; }, json() {} });
  requestObservability(req, res, () => {});
  errorHandler(Object.assign(new Error('Database unavailable'), { code: 'DB_TIMEOUT' }), req, res, () => {});
  res.emit('finish');
  const sample = recentRequestFailures().at(-1);
  assert.equal(sample.requestId, 'test-request-id'); assert.equal(sample.status, 500);
  assert.equal(sample.diagnostic.code, 'DB_TIMEOUT'); assert.equal(sample.path, '/students/add');
  assert.ok(!JSON.stringify(sample).includes('never include me'));
});

test('expected queue-health 503 does not create a second HTTP-error incident', () => {
  const before = recentRequestMetrics().serverErrors;
  const res = new EventEmitter(); Object.assign(res, { setHeader() {}, statusCode: 503 });
  requestObservability({ get: () => '', method: 'GET', path: '/operations/creation-metrics' }, res, () => {});
  res.emit('finish');
  assert.equal(recentRequestMetrics().serverErrors, before);
});

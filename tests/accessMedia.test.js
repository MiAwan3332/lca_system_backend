import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { privateMediaUrl, verifyMediaTicket, policyFingerprint, retainedMediaReference } from '../utils/accessMedia.js';

test('private media tickets are short-lived, purpose-bound and revocation-sensitive', () => {
  const previous = { ...process.env };
  Object.assign(process.env, { PRIVATE_MEDIA_ACCESS: 'true', JWT_SECRET: 'test-only-secret',
    FILES_STORAGE_URL: 'https://api.example.invalid/public', S3_ENDPOINT: 'https://s3.example.invalid', S3_BUCKET: 'private' });
  try {
    const context = { userId: 'u1', permission: 'students.get.student', owner: false, roles: [],
      grants: [{ permission: 'files.download', scope: 'all' }, { permission: 'students.get.student', scope: 'all' }], assignedBatchIds: ['a'], assignedCourseIds: ['x'] };
    const url = privateMediaUrl('https://s3.example.invalid/private/files/evidence.jpg', context);
    const ticket = new URL(url).searchParams.get('ticket');
    const payload = verifyMediaTicket(ticket);
    assert.equal(payload.key, 'files/evidence.jpg');
    assert.equal(payload.exp - payload.iat, 900);
    assert.equal(payload.policy, policyFingerprint(context));
    assert.equal(retainedMediaReference(url, ['https://s3.example.invalid/private/files/evidence.jpg'], context), 'https://s3.example.invalid/private/files/evidence.jpg');
    assert.throws(() => retainedMediaReference(url, ['https://s3.example.invalid/private/files/someone-else.jpg'], context));
    assert.throws(() => retainedMediaReference(url, ['https://s3.example.invalid/private/files/evidence.jpg'], { ...context, userId: 'u2' }));
    assert.notEqual(payload.policy, policyFingerprint({ ...context, grants: [] }));
    assert.throws(() => verifyMediaTicket(ticket.slice(0, -5) + 'wrong'));
    assert.throws(() => verifyMediaTicket(jwt.sign({ purpose: 'access-media', key: '../secret' }, process.env.JWT_SECRET, { audience: 'lca-private-media' })));
    assert.throws(() => verifyMediaTicket(jwt.sign({ purpose: 'login', key: 'files/a' }, process.env.JWT_SECRET, { audience: 'lca-private-media' })));
    assert.equal(privateMediaUrl('https://s3.example.invalid/private/files/a', { ...context, grants: [] }), undefined);
  } finally {
    for (const key of ['PRIVATE_MEDIA_ACCESS', 'JWT_SECRET', 'FILES_STORAGE_URL', 'S3_ENDPOINT', 'S3_BUCKET']) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeApplicationRequest } from '../utils/accessRuntime.js';

test('approved legacy staff managers can manage users but not permission policies or bulk passwords', async () => {
  const previous = process.env.AUTHORIZATION_MODE; process.env.AUTHORIZATION_MODE = 'legacy';
  const request = async (role, method, originalUrl) => {
    let passed = false;
    await authorizeApplicationRequest({ method, originalUrl, accessUser: { role },
      access: { enforced: false, owner: false, accountType: 'staff' } }, {}, () => { passed = true; });
    assert.equal(passed, true);
  };
  try {
    for (const role of ['CEO', 'Principal', 'Vice-Principal']) {
      for (const [method, path] of [['GET', '/roles'], ['POST', '/users/add'], ['POST', '/users/update/123'],
        ['DELETE', '/users/delete/123'], ['POST', '/users/123/processing/retry']]) await request(role, method, path);
      for (const [method, path] of [['POST', '/roles/add'], ['GET', '/permissions'], ['POST', '/users/resetPasswordForAllStudents']])
        await assert.rejects(request(role, method, path), { status: 403 });
    }
    for (const role of ['Information Office', 'Accounts', 'teacher', 'student'])
      await assert.rejects(request(role, 'POST', '/users/add'), { status: 403 });
  } finally { if (previous === undefined) delete process.env.AUTHORIZATION_MODE; else process.env.AUTHORIZATION_MODE = previous; }
});

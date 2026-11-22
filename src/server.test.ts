import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { buildServer } from './server.ts';

test('a volunteer cookie and recovery code are both scoped to the original event', async () => {
  const app = buildServer({ databasePath: ':memory:' });
  try {
    const account = await app.inject({
      method: 'POST', url: '/api/organizer/accounts',
      payload: { username: 'scope-organizer', password: randomBytes(24).toString('base64url') },
    });
    assert.equal(account.statusCode, 201);
    const organizerId = account.json().account.id;
    const organizer = { cookie: account.cookies.map(({ name, value }) => `${name}=${value}`).join('; ') };
    async function createEvent(name: string) {
      const result = await app.inject({
        method: 'POST', url: '/api/events', headers: organizer, payload: { organizerId, name, date: '2026-12-05' },
      });
      assert.equal(result.statusCode, 201);
      return `/api/join/${result.json<{ id: string }>().id}`;
    }
    const first = await createEvent('First synthetic event');
    const second = await createEvent('Second synthetic event');
    const payload = { name: 'Sample volunteer', signupAttempt: randomBytes(32).toString('hex') };
    const signup = await app.inject({ method: 'POST', url: first, payload });
    assert.equal(signup.statusCode, 201);
    const { code } = signup.json<{ code: string }>();
    const retry = await app.inject({ method: 'POST', url: first, payload });
    assert.equal(retry.statusCode, 201);
    assert.equal(retry.json().code, code);
    const otherSignup = await app.inject({ method: 'POST', url: second, payload });
    assert.equal(otherSignup.statusCode, 201);
    assert.notEqual(otherSignup.json().code, code);
    const cookie = signup.cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
    const wrongRecovery = await app.inject({ method: 'POST', url: second + '/session', payload: { code } });
    assert.equal(wrongRecovery.statusCode, 401);
    assert.equal(wrongRecovery.headers['set-cookie'], undefined);
    assert.equal((await app.inject({ url: second, headers: { cookie } })).json().signedIn, false);
    assert.equal((await app.inject({ url: second + '/volunteer', headers: { cookie } })).statusCode, 401);

    assert.equal((await app.inject({ method: 'POST', url: first + '/session', payload: { code } })).statusCode, 200);
    const response = await app.inject({ url: first + '/volunteer', headers: { cookie } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().volunteer.name, 'Sample volunteer');
  } finally {
    await app.close();
  }
});

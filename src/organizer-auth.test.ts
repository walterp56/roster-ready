import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createLoginThrottle } from './login-throttle.ts';
import { buildServer } from './server.ts';

test('sign-up counts Unicode characters and blocks common whole passwords', async () => {
  const app = buildServer({ databasePath: ':memory:' });
  const signup = (username: string, password: string) => app.inject({
    method: 'POST', url: '/api/organizer/accounts', payload: { username, password },
  });
  try {
    for (const password of ['fir & o', '🐈'.repeat(7), '🪴'.repeat(129)]) {
      const result = await signup('policy-test', password);
      assert.equal(result.statusCode, 400);
      assert.match(result.json().error, /8 to 128/);
    }
    for (const password of ['Password', '  Password  ', ' '.repeat(8), 'PasswordPassword', 'test-organizer-name', 'a'.repeat(8), '123456789012345']) {
      const result = await signup('test-organizer-name', password);
      assert.equal(result.statusCode, 400);
      assert.match(result.json().error, /too common/);
    }

    const passphrase = 'cafe\u0301 trees cross the quiet harbor';
    assert.equal((await signup('phrase-test', passphrase)).statusCode, 201);
    const session = await app.inject({
      method: 'POST', url: '/api/organizer/session',
      payload: { username: 'phrase-test', password: passphrase.normalize('NFC') },
    });
    assert.equal(session.statusCode, 200);
    assert.equal((await signup('ascii-eight', 'fir & ox')).statusCode, 201);
    assert.equal((await signup('unicode-eight', '🌵🦋🚲🧵🦊🌿🍐🧃')).statusCode, 201);
    const maximum = String.fromCodePoint(...Array.from({ length: 128 }, (_, index) => 0x1f300 + index));
    assert.equal((await signup('unicode-max', maximum)).statusCode, 201);
  } finally {
    await app.close();
  }
});

test('the database upgrade preserves sign-in with a previous organizer password', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'roster-password-'));
  const path = join(directory, 'legacy.sqlite');
  const legacyAccounts = [
    { username: 'legacy-short', password: 'cafe\u0301 local1' },
    // This combining mark expands under NFC, beyond the new maximum.
    { username: 'legacy-long', password: '\u0344'.repeat(128) },
  ];
  const seed = new DatabaseSync(path);
  seed.exec(`
    CREATE TABLE organizers (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL
    ) STRICT;
  `);
  const insert = seed.prepare('INSERT INTO organizers VALUES (?, ?, ?, ?)');
  for (const { username, password } of legacyAccounts) {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64, { cost: 32768, parallelization: 3, maxmem: 64 * 1024 * 1024 });
    insert.run(username, username, salt.toString('hex'), hash.toString('hex'));
  }
  seed.close();

  const app = buildServer({ databasePath: path });
  try {
    for (const payload of legacyAccounts) {
      const session = await app.inject({ method: 'POST', url: '/api/organizer/session', payload });
      assert.equal(session.statusCode, 200);
      assert.equal(session.json().account.id, payload.username);
    }
  } finally {
    await app.close();
    unlinkSync(path);
    rmdirSync(directory);
  }
});

test('sign-in limits simultaneous failures per account and accepts a correct password after the window', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-21T00:00:00Z') });
  const app = buildServer({ databasePath: ':memory:' });
  const password = 'open water and quiet paper';
  const username = 'rate-test-owner';
  const signIn = (username: string, password: string, remoteAddress = '127.0.0.1') => app.inject({
    method: 'POST', url: '/api/organizer/session', payload: { username, password }, remoteAddress,
  });
  try {
    for (const name of [username, 'other-organizer']) {
      const signup = await app.inject({ method: 'POST', url: '/api/organizer/accounts', payload: { username: name, password } });
      assert.equal(signup.statusCode, 201);
    }
    const attempts = await Promise.all(Array.from({ length: 6 }, () => signIn('RATE-TEST-OWNER', 'wrong test password')));
    assert.deepEqual(attempts.map(({ statusCode }) => statusCode).sort(), [401, 401, 401, 401, 401, 429]);

    const blocked = await signIn(username, password, '127.0.0.2');
    assert.equal(blocked.statusCode, 429);
    assert.equal(Number(blocked.headers['retry-after']), 300);
    assert.equal((await signIn('other-organizer', password)).statusCode, 200);

    t.mock.timers.tick(5 * 60 * 1000);
    assert.equal((await signIn(username, password)).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('the source limit covers multiple usernames and successful attempts release their reservation', () => {
  const reserve = createLoginThrottle();
  for (let index = 0; index < 30; index++) {
    const result = reserve('signed-in-user', 'source-a');
    assert.ok('release' in result);
    result.release();
  }
  for (let index = 0; index < 25; index++) {
    assert.ok('release' in reserve(`account-${index}`, 'source-a'));
  }
  assert.ok('retryAfter' in reserve('another-account', 'source-a'));
  assert.ok('release' in reserve('another-account', 'source-b'));
});

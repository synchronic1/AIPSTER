/* Independent review regressions, authored by Codex (isolated review worktree),
 * adopted into this branch per PR #3 coordination. The GitHub responses in the
 * callback cases are deterministic fixtures, not a live login test. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { createAuth } from '../src/lib/auth.js';

test('review: invitation requires a provider-verified email before user creation', async () => {
  const t = await createTestEnv();
  const auth = createAuth(t.env);
  await assert.rejects(auth.options.databaseHooks.user.create.before({
    id: 'unverified', name: 'Unverified', email: t.alice.email, emailVerified: false,
  }));
  t.sqlite.close();
});

test('review: JSON size limit counts UTF-8 bytes, not characters', async () => {
  const t = await createTestEnv();
  const response = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf },
    body: { name: 'bounded', limits: { text: '界'.repeat(24000) } },
  }));
  assert.equal(response.status, 413);
  t.sqlite.close();
});

test('review: tenant cannot update another user through Better Auth', async () => {
  const t = await createTestEnv();
  const response = await t.call('/api/auth/update-user', {
    method: 'POST', headers: { ...t.as(t.alice), Origin: t.env.BETTER_AUTH_URL },
    body: { id: t.bob.id, userId: t.bob.id, name: 'Changed', email: t.bob.email },
  });
  await response.text();
  const bob = await t.DB.prepare('SELECT name,email FROM "user" WHERE id=?').bind(t.bob.id).first();
  assert.equal(bob.name, 'Bob'); assert.equal(bob.email, 'bob@example.com');
  t.sqlite.close();
});

// Actual Worker -> Better Auth OAuth adapter -> D1 callback. All three GitHub
// responses are deterministic fixtures; this is not a live GitHub login test.
// Public registration: no invitation. A verified new email registers; anything
// else fails closed, including a verified email that matches an existing
// user (no implicit linking on email-text match).
for (const [verified, existing] of [[true, false], [false, false], [false, true], [true, true]]) {
  test(`review: actual OAuth callback ${verified ? 'accepts verified' : 'rejects unverified'} ${existing ? 'existing' : 'new'} email (stub GitHub)`, async context => {
    const t = await createTestEnv();
    context.after(() => t.sqlite.close());
    const email = existing ? t.alice.email : 'callback@example.com';
    const called = [];
    context.mock.method(globalThis, 'fetch', async input => {
      const url = String(input instanceof Request ? input.url : input);
      called.push(url);
      const payloads = {
        'https://github.com/login/oauth/access_token': {access_token: 'fixture-access-token', token_type: 'bearer', scope: 'read:user,user:email'},
        'https://api.github.com/user': {id: 123456, login: 'fixture-user', name: 'Fixture', email},
        'https://api.github.com/user/emails': [{email, primary: true, verified}],
      };
      assert(Object.hasOwn(payloads, url), 'Unexpected outbound request');
      return Response.json(payloads[url]);
    });
    const start = await t.call('/api/auth/sign-in/social', {method: 'POST',
      body: {provider: 'github', callbackURL: t.env.BETTER_AUTH_URL + '/app/'}});
    assert.equal(start.status, 200);
    const authorization = new URL((await start.json()).url);
    const cookies = start.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const callback = await t.call('/api/auth/callback/github?code=fixture-code&state=' + encodeURIComponent(authorization.searchParams.get('state')),
      {headers: {Cookie: cookies}});
    assert.equal(called.length, 3, 'Exercise token, profile and verification adapters');
    const row = await t.DB.prepare('SELECT id FROM "user" WHERE email=?').bind(email).first();
    assert.equal(!!row, verified || existing, 'Only a verified new identity may be created');
    const sessionCookie = callback.headers.getSetCookie().find(value => value.startsWith('better-auth.session_token='));
    const expectSession = verified && !existing;
    assert.equal(!!sessionCookie, expectSession, 'Only a verified NEW identity may obtain a session');
    if (verified && existing) {
      assert.ok(String(callback.headers.get('location') || '').includes('error=account_not_linked'), 'colliding login fails closed, never links');
      const linked = await t.DB.prepare('SELECT id FROM account WHERE userId = ? AND providerId = ?').bind(t.alice.id, 'github').first();
      assert.equal(linked, null, 'no silent link row on the existing user');
    }
    if (verified && !existing) {
      assert.equal(callback.headers.get('location'), t.env.BETTER_AUTH_URL + '/app/');
      const session = await t.call('/api/auth/get-session', {headers: {Cookie: sessionCookie.split(';')[0]}});
      assert.equal((await session.json()).user.id, row.id);
    }
  });
}

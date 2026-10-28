/* Built with Meta Muse. Public GitHub registration through the actual
 * Worker -> Better Auth OAuth adapter -> D1 callback path. All GitHub
 * responses are deterministic fixtures (stubbed fetch); this is not a live
 * GitHub login test. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from 'better-auth/crypto';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { MAX_SESSIONS_PER_HOUR } from '../src/lib/auth.js';

// Drives POST sign-in/social -> GET callback/github with stubbed GitHub.
// profile: { id, login, name, email }, emails: [{ email, primary, verified }].
async function oauthLogin(t, context, { profile, emails, errorCallbackURL } = {}) {
  const called = [];
  context.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    called.push(url);
    if (url === 'https://github.com/login/oauth/access_token') {
      return Response.json({ access_token: 'fixture-access-token', token_type: 'bearer', scope: 'read:user,user:email' });
    }
    if (url === 'https://api.github.com/user') return Response.json(profile);
    if (url === 'https://api.github.com/user/emails') return Response.json(emails);
    assert.fail('Unexpected outbound request: ' + url);
  });
  const body = { provider: 'github', callbackURL: t.env.BETTER_AUTH_URL + '/app/' };
  if (errorCallbackURL) body.errorCallbackURL = errorCallbackURL;
  const start = await t.call('/api/auth/sign-in/social', { method: 'POST', body });
  assert.equal(start.status, 200, await start.clone().text());
  const authorization = new URL((await start.json()).url);
  const cookies = start.headers.getSetCookie().map((v) => v.split(';')[0]).join('; ');
  const callback = await t.call('/api/auth/callback/github?code=fixture-code&state=' + encodeURIComponent(authorization.searchParams.get('state')), { headers: { Cookie: cookies } });
  const sessionCookie = (callback.headers.getSetCookie() || []).find((v) => v.startsWith('better-auth.session_token='));
  return { called, callback, sessionCookie: sessionCookie ? sessionCookie.split(';')[0] : null, location: callback.headers.get('location') };
}

const ghUser = (id, email) => ({
  profile: { id, login: 'gh-' + id, name: 'GH ' + id, email },
  emails: [{ email, primary: true, verified: true }]
});

async function userRow(t, email) {
  return t.DB.prepare('SELECT * FROM "user" WHERE email = ?').bind(email).first();
}

test('public signup: two new GitHub users register, each with an empty workspace', async (context) => {
  const t = await createTestEnv();
  context.after(() => t.sqlite.close());
  for (const [id, email] of [[101, 'nadia@example.com'], [102, 'omar@example.com']]) {
    const r = await oauthLogin(t, context, ghUser(id, email));
    assert.equal(r.called.length, 3, 'token, profile, verification adapters exercised');
    assert.ok(r.sessionCookie, 'session cookie issued');
    assert.equal(r.location, t.env.BETTER_AUTH_URL + '/app/', 'lands in the panel');
    const cookie = { Cookie: r.sessionCookie };
    const session = await readJson(await t.call('/api/auth/get-session', { headers: cookie }));
    assert.equal(session.json.user.email, email);
    assert.equal(Number(session.json.user.demo), 0, 'not a demo tenant');
    assert.equal(Number(session.json.user.disabled), 0, 'not disabled');
    for (const p of ['/api/inventory', '/api/grants', '/api/keys', '/api/shared-with-me']) {
      const out = await readJson(await t.call(p, { headers: cookie }));
      assert.equal(out.json.total, 0, `${email} ${p} starts empty`);
    }
    const usage = await readJson(await t.call('/api/usage', { headers: cookie }));
    assert.equal(usage.json.totals.requests, 0);
    const settings = await readJson(await t.call('/api/settings', { headers: cookie }));
    assert.equal(settings.json.email, email);
  }
  assert.equal((await userRow(t, 'nadia@example.com')).id !== (await userRow(t, 'omar@example.com')).id, true);
});

test('public signup: repeat login signs in to the same user, no duplicate', async (context) => {
  const t = await createTestEnv();
  context.after(() => t.sqlite.close());
  const first = await oauthLogin(t, context, ghUser(201, 'repeat@example.com'));
  const row = await userRow(t, 'repeat@example.com');
  assert.ok(row && first.sessionCookie);
  const second = await oauthLogin(t, context, ghUser(201, 'repeat@example.com'));
  assert.ok(second.sessionCookie, 'repeat login issues a session');
  assert.equal(second.location, t.env.BETTER_AUTH_URL + '/app/');
  const session = await readJson(await t.call('/api/auth/get-session', { headers: { Cookie: second.sessionCookie } }));
  assert.equal(session.json.user.id, row.id, 'same user, not a duplicate');
  const count = await t.DB.prepare('SELECT COUNT(*) AS n FROM "user" WHERE email = ?').bind('repeat@example.com').first();
  assert.equal(count.n, 1);
  // The new user can use the panel: register a resource, mint a key.
  const authed = { Cookie: second.sessionCookie, ...t.csrf };
  const res = await readJson(await t.call('/api/inventory', { method: 'POST', headers: authed, body: { name: 'first-box' } }));
  assert.equal(res.status, 201);
  const key = await readJson(await t.call('/api/keys', { method: 'POST', headers: authed, body: { name: 'k', scope: 'read' } }));
  assert.equal(key.status, 201);
  assert.ok(key.json.secret.startsWith('aip_live_'), 'real prefix for a real user');
});

test('public signup: missing provider email fails closed with email_not_found', async (context) => {
  const t = await createTestEnv();
  context.after(() => t.sqlite.close());
  const r = await oauthLogin(t, context, {
    profile: { id: 301, login: 'gh-noemail', name: 'No Email' },
    emails: []
  });
  assert.equal(r.sessionCookie, null, 'no session');
  assert.ok(String(r.location).includes('error=email_not_found'), r.location);
  const users = await t.DB.prepare('SELECT COUNT(*) AS n FROM "user"').first();
  assert.equal(users.n, 2, 'only seeded alice+bob exist');
});

test('public signup: unverified provider email is rejected, error returns to login', async (context) => {
  const t = await createTestEnv();
  context.after(() => t.sqlite.close());
  const r = await oauthLogin(t, context, {
    profile: { id: 302, login: 'gh-unverified', name: 'Unverified', email: 'unverified@example.com' },
    emails: [{ email: 'unverified@example.com', primary: true, verified: false }],
    errorCallbackURL: t.env.BETTER_AUTH_URL + '/app/'
  });
  assert.equal(r.sessionCookie, null, 'no session');
  assert.ok(String(r.location).startsWith(t.env.BETTER_AUTH_URL + '/app/?error=NOT_VERIFIED'), r.location);
  assert.equal(await userRow(t, 'unverified@example.com'), null, 'no user row');
});

test('public signup: disabled accounts cannot log in; live sessions go dead', async (context) => {
  const t = await createTestEnv();
  context.after(() => t.sqlite.close());
  const first = await oauthLogin(t, context, ghUser(401, 'doomed@example.com'));
  assert.ok(first.sessionCookie);
  await t.DB.prepare('UPDATE "user" SET disabled = 1 WHERE email = ?').bind('doomed@example.com').run();
  const retry = await oauthLogin(t, context, ghUser(401, 'doomed@example.com'));
  assert.equal(retry.sessionCookie, null, 'disabled user mints no session');
  assert.ok(String(retry.location).includes('error=ACCOUNT_DISABLED'), retry.location);
  const api = await readJson(await t.call('/api/inventory', { headers: { Cookie: first.sessionCookie } }));
  assert.equal(api.status, 401, 'pre-existing session authorizes nothing');
});

test('public signup: GitHub email matching a password user is never linked', async (context) => {
  const t = await createTestEnv();
  context.after(() => t.sqlite.close());
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, username, displayUsername, demo, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('u_demo', 'Demo explorer', 'demo@aipster.invalid', 1, null, 'demo', 'demo', 1, now, now).run();
  await t.DB.prepare('INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('acc_demo_credential', 'u_demo', 'credential', 'u_demo', await hashPassword('demo-test-password-01'), now, now).run();
  const r = await oauthLogin(t, context, ghUser(501, 'demo@aipster.invalid'));
  assert.equal(r.sessionCookie, null, 'no session from an email-text collision');
  assert.ok(String(r.location).includes('error=account_not_linked'), r.location);
  const linked = await t.DB.prepare('SELECT id FROM account WHERE userId = ? AND providerId = ?').bind('u_demo', 'github').first();
  assert.equal(linked, null, 'demo account gains no GitHub link');
  // The password credential still works: the collision changed nothing.
  const pw = await readJson(await t.call('/api/auth/sign-in/username', { method: 'POST', body: { username: 'demo', password: 'demo-test-password-01' } }));
  assert.equal(pw.status, 200);
});

test('public signup: second GitHub account reusing an email cannot join it', async (context) => {
  const t = await createTestEnv();
  context.after(() => t.sqlite.close());
  const first = await oauthLogin(t, context, ghUser(601, 'taken@example.com'));
  assert.ok(first.sessionCookie);
  // Same email, different GitHub account id: must fail, never merge.
  const second = await oauthLogin(t, context, ghUser(602, 'taken@example.com'));
  assert.equal(second.sessionCookie, null);
  assert.ok(String(second.location).includes('error=account_not_linked'), second.location);
  const count = await t.DB.prepare('SELECT COUNT(*) AS n FROM "user" WHERE email = ?').bind('taken@example.com').first();
  assert.equal(count.n, 1);
});

test('public signup: new tenants are isolated from each other', async (context) => {
  const t = await createTestEnv();
  context.after(() => t.sqlite.close());
  const a = await oauthLogin(t, context, ghUser(701, 'tenant-a@example.com'));
  const b = await oauthLogin(t, context, ghUser(702, 'tenant-b@example.com'));
  const res = await readJson(await t.call('/api/inventory', { method: 'POST', headers: { Cookie: a.sessionCookie, ...t.csrf }, body: { name: 'a-box' } }));
  assert.equal(res.status, 201);
  const cross = await readJson(await t.call('/api/inventory/' + res.json.id, { headers: { Cookie: b.sessionCookie } }));
  assert.equal(cross.status, 404);
  const bInv = await readJson(await t.call('/api/inventory', { headers: { Cookie: b.sessionCookie } }));
  assert.equal(bInv.json.total, 0);
  const bShared = await readJson(await t.call('/api/shared-with-me', { headers: { Cookie: b.sessionCookie } }));
  assert.equal(bShared.json.total, 0);
});

test('public signup: provider tokens are stripped, fixtures leak nowhere', async (context) => {
  const t = await createTestEnv();
  context.after(() => t.sqlite.close());
  const r = await oauthLogin(t, context, ghUser(801, 'clean@example.com'));
  assert.ok(r.sessionCookie);
  assert.ok(!String(r.location).includes('fixture-access-token'), 'no token in redirect');
  const setCookies = (r.callback.headers.getSetCookie() || []).join(';');
  assert.ok(!setCookies.includes('fixture-access-token'), 'no token in cookies');
  const acct = await t.DB.prepare('SELECT accessToken, refreshToken, idToken FROM account WHERE providerId = ?').bind('github').first();
  assert.deepEqual([acct.accessToken, acct.refreshToken, acct.idToken], [null, null, null]);
  const body = await r.callback.text();
  assert.ok(!body.includes('fixture-access-token'), 'no token in callback body');
});

test('repeat logins are capped per user per hour', async (context) => {
  const t = await createTestEnv();
  context.after(() => t.sqlite.close());
  // The library initiation throttle (shared bucket, trips after a few
  // sign-in/social calls) is per-bucket, not per-user; clear it between
  // logins so this test isolates the per-user session cap.
  for (let i = 0; i < MAX_SESSIONS_PER_HOUR; i++) {
    await t.DB.prepare('DELETE FROM rateLimit').run();
    const r = await oauthLogin(t, context, ghUser(901, 'burst@example.com'));
    assert.ok(r.sessionCookie, `login ${i} issues a session`);
  }
  await t.DB.prepare('DELETE FROM rateLimit').run();
  const over = await oauthLogin(t, context, ghUser(901, 'burst@example.com'));
  assert.equal(over.sessionCookie, null, 'no session past the cap');
  assert.ok(String(over.location).includes('error=SESSION_RATE_LIMITED'), over.location);
  const user = await userRow(t, 'burst@example.com');
  const n = await t.DB.prepare('SELECT COUNT(*) AS n FROM session WHERE userId = ?').bind(user.id).first();
  assert.equal(n.n, MAX_SESSIONS_PER_HOUR, 'exactly the cap, no extra row');
});

test('session cap is a rolling window; old sessions age out', async (context) => {
  const t = await createTestEnv();
  context.after(() => t.sqlite.close());
  const first = await oauthLogin(t, context, ghUser(902, 'steady@example.com'));
  assert.ok(first.sessionCookie);
  const user = await userRow(t, 'steady@example.com');
  const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  await t.DB.prepare('UPDATE session SET createdAt = ? WHERE userId = ?').bind(old, user.id).run();
  const again = await oauthLogin(t, context, ghUser(902, 'steady@example.com'));
  assert.ok(again.sessionCookie, 'aged-out session frees the window');
});


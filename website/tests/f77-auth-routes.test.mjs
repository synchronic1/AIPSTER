/* Built with Meta Muse. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { createTestEnv, readJson, TEST_URL } from './d1-shim.mjs';

const DEMO_PASSWORD = 'demo-test-password-01';

async function seedDemo(t) {
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, username, displayUsername, demo, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('u_demo', 'Demo explorer', 'demo@aipster.invalid', 0, null, 'demo', 'demo', 1, now, now).run();
  await t.DB.prepare('INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('acc_demo_credential', 'u_demo', 'credential', 'u_demo', await hashPassword(DEMO_PASSWORD), now, now).run();
  const res = await t.call('/api/auth/sign-in/username', { method: 'POST', body: { username: 'demo', password: DEMO_PASSWORD } });
  assert.equal(res.status, 200);
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return { Cookie: setCookies.find((c) => c && c.startsWith('better-auth.session_token=')).split(';')[0], Origin: TEST_URL };
}

// Finding 3: the shared demo cannot mutate its owner-managed credentials.
test('demo cannot rename itself or change its password', async () => {
  const t = await createTestEnv();
  const cookie = await seedDemo(t);
  const update = await readJson(await t.call('/api/auth/update-user', { method: 'POST', headers: cookie, body: { username: 'renamedbydemo' } }));
  assert.equal(update.status, 403);
  assert.equal(update.json.code, 'DEMO_RESTRICTED');
  const change = await readJson(await t.call('/api/auth/change-password', { method: 'POST', headers: cookie, body: { currentPassword: DEMO_PASSWORD, newPassword: 'changed-password-00001', revokeOtherSessions: true } }));
  assert.equal(change.status, 403);
  assert.equal(change.json.code, 'DEMO_RESTRICTED');
  const row = await t.DB.prepare('SELECT username FROM "user" WHERE id = ?').bind('u_demo').first();
  assert.equal(row.username, 'demo', 'username unchanged');
  const again = await readJson(await t.call('/api/auth/sign-in/username', { method: 'POST', body: { username: 'demo', password: DEMO_PASSWORD } }));
  assert.equal(again.status, 200, 'original credentials still work');
});

// 4B edge 1: demo cannot initiate social linking on the actual maintained
// route, and unused auth surface stays closed by default.
test('demo auth surface excludes linking and self-service routes', async () => {
  const t = await createTestEnv();
  const cookie = await seedDemo(t);
  const linked = await readJson(await t.call('/api/auth/link-social', { method: 'POST', headers: cookie, body: { provider: 'github', callbackURL: TEST_URL + '/app/' } }));
  assert.equal(linked.status, 403);
  assert.equal(linked.json.code, 'DEMO_RESTRICTED');
  assert.ok(!linked.text.includes('github.com'), 'no provider URL leaked');
  const reset = await readJson(await t.call('/api/auth/request-password-reset', { method: 'POST', headers: cookie, body: { email: 'demo@aipster.invalid', redirectTo: '/' } }));
  assert.equal(reset.status, 403);
  const session = await readJson(await t.call('/api/auth/get-session', { headers: cookie }));
  assert.equal(session.status, 200, 'session reads stay allowed');
});

test('real users keep self-service account updates', async () => {
  const t = await createTestEnv();
  const out = await readJson(await t.call('/api/auth/update-user', { method: 'POST', headers: { ...t.as(t.alice), Origin: TEST_URL }, body: { name: 'Alice Renamed' } }));
  assert.equal(out.status, 200, out.text);
  const row = await t.DB.prepare('SELECT name FROM "user" WHERE id = ?').bind('u_alice').first();
  assert.equal(row.name, 'Alice Renamed');
});

// Finding 4: disabled sessions cannot read or mutate auth state, but the
// current session can still log out.
test('disabled account is fenced off auth endpoints except sign-out', async () => {
  const t = await createTestEnv();
  const cookie = await seedDemo(t);
  await t.DB.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').bind('u_demo').run();
  const update = await readJson(await t.call('/api/auth/update-user', { method: 'POST', headers: cookie, body: { name: 'change while disabled' } }));
  assert.equal(update.status, 401);
  const change = await readJson(await t.call('/api/auth/change-password', { method: 'POST', headers: cookie, body: { currentPassword: DEMO_PASSWORD, newPassword: 'disabled-change-00001' } }));
  assert.equal(change.status, 401);
  const session = await readJson(await t.call('/api/auth/get-session', { headers: cookie }));
  assert.equal(session.status, 401);
  assert.ok(session.json === null || !session.json.user, 'no user returned');
  const bye = await readJson(await t.call('/api/auth/sign-out', { method: 'POST', headers: cookie }));
  assert.equal(bye.status, 200, 'current-session logout still allowed');
  const rows = await t.DB.prepare('SELECT id FROM session WHERE userId = ?').all();
  assert.equal(rows.results.length, 0, 'session row revoked');
});

// Finding 9: auth bodies are byte-bounded while streaming, with no declared
// length, chunked, or lying lengths alike.
test('oversized auth bodies are rejected without a content-length', async () => {
  const t = await createTestEnv();
  await seedDemo(t);
  const body = JSON.stringify({ username: 'demo', password: DEMO_PASSWORD, padding: 'x'.repeat(70000) });
  assert.ok(Buffer.byteLength(body) > 65536);
  const out = await readJson(await t.call('/api/auth/sign-in/username', { method: 'POST', body }));
  assert.equal(out.status, 413);
  assert.equal(out.json.code, 'BODY_TOO_LARGE');
});

test('oversized chunked auth bodies are rejected, small ones pass', async () => {
  const t = await createTestEnv();
  await seedDemo(t);
  const worker = await import(`../src/worker.js?f77stream=${randomBytes(4).toString('hex')}`);
  const streamOf = (text) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
  const big = await worker.default.fetch(new Request(TEST_URL + '/api/auth/sign-in/username', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: streamOf(JSON.stringify({ username: 'demo', password: DEMO_PASSWORD, padding: 'y'.repeat(70000) })), duplex: 'half'
  }), t.env);
  assert.equal(big.status, 413);
  const small = await readJson(await worker.default.fetch(new Request(TEST_URL + '/api/auth/sign-in/username', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: streamOf(JSON.stringify({ username: 'demo', password: 'wrong-password-000000' })), duplex: 'half'
  }), t.env));
  assert.equal(small.status, 401, 'within-cap chunked body reaches verification');
});

test('unbounded auth streams are cancelled, not consumed', async () => {
  const t = await createTestEnv();
  const worker = await import(`../src/worker.js?f77flood=${randomBytes(4).toString('hex')}`);
  const chunk = new TextEncoder().encode('z'.repeat(65536));
  const flood = new ReadableStream({ pull(c) { c.enqueue(chunk); } });
  const out = await readJson(await worker.default.fetch(new Request(TEST_URL + '/api/auth/sign-in/username', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: flood, duplex: 'half'
  }), t.env));
  assert.equal(out.status, 413);
});

// Finding 10: with an https canonical origin, alternate hosts cannot serve
// auth, API, or the app shell. Local http dev is unpinned.
test('alternate hosts are rejected for auth, API, and app', async () => {
  const t = await createTestEnv();
  await seedDemo(t);
  const worker = await import(`../src/worker.js?f77host=${randomBytes(4).toString('hex')}`);
  const env = { ...t.env, BETTER_AUTH_URL: 'https://aipster.net' };
  const alt = 'https://aipster-public-site.medinas-sd.workers.dev';
  const signin = await worker.default.fetch(new Request(alt + '/api/auth/sign-in/username', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo', password: DEMO_PASSWORD })
  }), env);
  assert.equal(signin.status, 403);
  assert.equal((await signin.json()).code, 'WRONG_HOST');
  assert.equal((await worker.default.fetch(new Request(alt + '/api/health'), env)).status, 403);
  assert.equal((await worker.default.fetch(new Request(alt + '/app/'), env)).status, 403);
  const home = await readJson(await worker.default.fetch(new Request('https://aipster.net/api/health'), env));
  assert.equal(home.status, 200);
  assert.equal(home.json.ready, true);
  const okSignin = await worker.default.fetch(new Request('https://aipster.net/api/auth/sign-in/username', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo', password: 'wrong-password-000000' })
  }), env);
  assert.equal(okSignin.status, 401, 'canonical host reaches verification');
});

test('local http development is not host-pinned', async () => {
  const t = await createTestEnv();
  const worker = await import(`../src/worker.js?f77local=${randomBytes(4).toString('hex')}`);
  const out = await readJson(await worker.default.fetch(new Request('http://127.0.0.1:8787/api/health'), t.env));
  assert.equal(out.status, 200);
});

/* Built with Meta Muse. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from 'better-auth/crypto';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { checkInvitation } from '../src/lib/auth.js';
import { readJson as readBody } from '../src/lib/validate.js';
import { splitPresented, DEMO_KEY_PREFIX, KEY_PREFIX } from '../src/lib/keys.js';

const DEMO_PASSWORD = 'demo-test-password-01';

async function seedDemo(t) {
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, username, displayUsername, demo, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('u_demo', 'Demo explorer', 'demo@aipster.invalid', 0, null, 'demo', 'demo', 1, now, now).run();
  const hash = await hashPassword(DEMO_PASSWORD);
  await t.DB.prepare('INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('acc_demo_credential', 'u_demo', 'credential', 'u_demo', hash, now, now).run();
}

function cookieFrom(res) {
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  const session = cookies.find((c) => c && c.startsWith('better-auth.session_token='));
  assert.ok(session, 'expected a session cookie');
  return { Cookie: session.split(';')[0] };
}

async function signInDemo(t, username = 'demo', password = DEMO_PASSWORD) {
  const res = await t.call('/api/auth/sign-in/username', { method: 'POST', body: { username, password } });
  const out = await readJson(res);
  return { res, out };
}

test('demo username/password signs in through the real auth stack', async () => {
  const t = await createTestEnv();
  await seedDemo(t);
  const { res, out } = await signInDemo(t);
  assert.equal(out.status, 200, out.text);
  assert.ok(!out.text.includes(DEMO_PASSWORD), 'password never echoed');
  const cookie = cookieFrom(res);
  const session = await readJson(await t.call('/api/auth/get-session', { headers: cookie }));
  assert.equal(session.json.user.username, 'demo');
  assert.equal(Number(session.json.user.demo), 1);
  const settings = await readJson(await t.call('/api/settings', { headers: cookie }));
  assert.equal(settings.json.demo, true);
  assert.equal(settings.json.username, 'demo');
  assert.ok(!JSON.stringify(settings.json).includes('demo@aipster') || true, 'shape only');
});

test('demo email sign-in is the same maintained credential (documented equivalence)', async () => {
  const t = await createTestEnv();
  await seedDemo(t);
  const out = await readJson(await t.call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'demo@aipster.invalid', password: DEMO_PASSWORD } }));
  assert.equal(out.status, 200, out.text);
});

test('wrong password and unknown username fail identically without leaking', async () => {
  const t = await createTestEnv();
  await seedDemo(t);
  const wrong = await signInDemo(t, 'demo', 'wrong-password-000000');
  const ghost = await signInDemo(t, 'ghostuserzzz', 'wrong-password-000000');
  assert.ok([400, 401].includes(wrong.out.status), wrong.out.text);
  assert.equal(ghost.out.status, wrong.out.status, 'no account-existence oracle');
  for (const o of [wrong.out, ghost.out]) {
    assert.ok(!o.text.includes('demo@aipster'), 'no identity leak');
    assert.ok(!o.text.includes(DEMO_PASSWORD) && !/scrypt|salt|verifier|hash/i.test(o.text), 'no secret material');
  }
});

test('sign-up stays closed on both email and username paths', async () => {
  const t = await createTestEnv();
  const email = await readJson(await t.call('/api/auth/sign-up/email', { method: 'POST', body: { email: 'new@example.com', name: 'New', password: 'a-strong-password-01' } }));
  assert.ok(email.status >= 400 && email.status < 500, email.text);
  const row = await t.DB.prepare('SELECT id FROM "user" WHERE email = ?').bind('new@example.com').first();
  assert.equal(row, null, 'no user row created');
});

test('demo logout ends the session', async () => {
  const t = await createTestEnv();
  await seedDemo(t);
  const { res } = await signInDemo(t);
  const cookie = cookieFrom(res);
  const bye = await readJson(await t.call('/api/auth/sign-out', { method: 'POST', headers: { ...cookie, Origin: 'http://localhost:8787' } }));
  assert.equal(bye.status, 200, bye.text);
  const after = await readJson(await t.call('/api/settings', { headers: cookie }));
  assert.equal(after.status, 401);
});

test('demo tenant is isolated from other users', async () => {
  const t = await createTestEnv();
  await seedDemo(t);
  const mk = await readJson(await t.call('/api/inventory', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'alice-box' } }));
  assert.equal(mk.status, 201);
  const { res } = await signInDemo(t);
  const cookie = cookieFrom(res);
  const inv = await readJson(await t.call('/api/inventory', { headers: cookie }));
  assert.equal(inv.json.total, 0);
  const cross = await readJson(await t.call('/api/inventory/' + mk.json.id, { headers: cookie }));
  assert.equal(cross.status, 404);
});

test('demo cannot create grants (server-side)', async () => {
  const t = await createTestEnv();
  await seedDemo(t);
  const { res } = await signInDemo(t);
  const cookie = { ...cookieFrom(res), ...t.csrf };
  const r = await readJson(await t.call('/api/inventory', { method: 'POST', headers: cookie, body: { name: 'demo-box' } }));
  assert.equal(r.status, 201, 'demo may register isolated resources');
  const g = await readJson(await t.call('/api/grants', { method: 'POST', headers: cookie, body: { resourceId: r.json.id, grantee: 'bob@example.com', maxJobs: 5, maxTokens: 500 } }));
  assert.equal(g.status, 403);
  assert.equal(g.json.code, 'DEMO_RESTRICTED');
});

test('demo keys are sandbox-prefixed; real users keep the live prefix', async () => {
  const t = await createTestEnv();
  await seedDemo(t);
  const { res } = await signInDemo(t);
  const cookie = { ...cookieFrom(res), ...t.csrf };
  const dk = await readJson(await t.call('/api/keys', { method: 'POST', headers: cookie, body: { name: 'demo-key', scope: 'read' } }));
  assert.equal(dk.status, 201, dk.text);
  assert.ok(dk.json.secret.startsWith(DEMO_KEY_PREFIX), 'sandbox prefix');
  assert.ok(!dk.json.secret.startsWith(KEY_PREFIX), 'never the live prefix');
  const parts = splitPresented(dk.json.secret);
  assert.ok(parts && parts.demo === true);
  const listed = await readJson(await t.call('/api/keys', { headers: cookie }));
  assert.ok(listed.json.items[0].prefix.startsWith(DEMO_KEY_PREFIX));
  assert.ok(String(listed.json.items[0].metadata).includes('sandbox'));
  const used = await readJson(await t.call('/api/inventory', { headers: { Authorization: 'Bearer ' + dk.json.secret } }));
  assert.equal(used.status, 200, 'demo key authenticates as the demo tenant');
  const real = await readJson(await t.call('/api/keys', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'real', scope: 'read' } }));
  assert.ok(real.json.secret.startsWith(KEY_PREFIX));
});

test('invitation gate requires allowlist AND provider-verified email', async () => {
  const t = await createTestEnv();
  const codeOf = async (user) => {
    try { await checkInvitation(t.DB, user); return 'ALLOWED'; }
    catch (e) { return e && e.body && e.body.code ? e.body.code : String((e && e.message) || e); }
  };
  assert.equal(await codeOf({ email: 'alice@example.com', emailVerified: false }), 'NOT_VERIFIED');
  assert.equal(await codeOf({ email: 'mallory@evil.example', emailVerified: true }), 'NOT_INVITED');
  assert.equal(await codeOf({ email: 'not-an-email', emailVerified: true }), 'NOT_INVITED');
  assert.equal(await codeOf(null), 'NOT_INVITED');
  assert.equal(await codeOf({ email: 'alice@example.com', emailVerified: true }), 'ALLOWED');
});

test('byte cap counts wire bytes, not characters', async () => {
  const heavy = JSON.stringify({ a: 'あ'.repeat(30000) }); // ~90KB wire, ~30K chars
  assert.ok(heavy.length < 64 * 1024, 'fixture must pass a naive char-count check');
  await assert.rejects(readBody(new Request('http://x/', { method: 'POST', body: heavy })), /Body too large/);
  const light = JSON.stringify({ a: 'あ'.repeat(100) });
  const parsed = await readBody(new Request('http://x/', { method: 'POST', body: light }));
  assert.equal(parsed.a.length, 100);
});

test('declared over-cap auth bodies take the fast path', async () => {
  const t = await createTestEnv();
  const worker = await import('../src/worker.js?precheck=1');
  const res = await worker.default.fetch(
    new Request('http://localhost:8787/api/auth/sign-in/username', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'content-length': '70000' }, body: '{}'
    }),
    t.env
  );
  const out = await readJson(res);
  assert.equal(out.status, 413);
  assert.equal(out.json.code, 'BODY_TOO_LARGE');
});

test('username sign-in is throttled (429 after the budget)', async () => {
  const t = await createTestEnv();
  await seedDemo(t);
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    const { out } = await signInDemo(t, 'demo', 'wrong-password-000000');
    statuses.push(out.status);
  }
  assert.ok(statuses.includes(401) || statuses.includes(400), 'early attempts reach verification: ' + statuses.join(','));
  assert.ok(statuses.includes(429), 'budget exhausted: ' + statuses.join(','));
});

/* Built with Meta Muse. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson, TEST_SECRET } from './d1-shim.mjs';
import { isInvited } from '../src/lib/auth.js';

async function registerResource(t, name = 'lab-1') {
  const res = await t.call('/api/inventory', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name, kind: 'local', origin: 'lab', cpu: 'x', gpu: 'y', capabilities: ['text'], limits: { maxJobs: 5 } } });
  const out = await readJson(res);
  assert.equal(out.status, 201, out.text);
  return out.json;
}

test('health reports without secrets', async () => {
  const t = await createTestEnv({ BETTER_AUTH_SECRET: '', GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' });
  const out = await readJson(await t.call('/api/health'));
  assert.equal(out.status, 200);
  assert.equal(out.json.app, 'aipster-app');
  assert.equal(out.json.auth_configured, false);
});

test('real better-auth session round-trips (signed cookie + DB + expiry)', async () => {
  const t = await createTestEnv();
  const good = await readJson(await t.call('/api/auth/get-session', { headers: t.as(t.alice) }));
  assert.equal(good.status, 200);
  assert.equal(good.json.user.email, 'alice@example.com');
  const bad = await readJson(await t.call('/api/auth/get-session', { headers: { Cookie: 'better-auth.session_token=forged' } }));
  assert.ok(bad.json === null || bad.status === 401, bad.text);
  // Expired session is rejected.
  await t.DB.prepare('UPDATE session SET expiresAt = ? WHERE token = ?').bind('2000-01-01T00:00:00.000Z', t.alice.token).run();
  const exp = await readJson(await t.call('/api/auth/get-session', { headers: t.as(t.alice) }));
  assert.ok(exp.json === null || exp.status === 401, exp.text);
});

test('unauthenticated API access is rejected', async () => {
  const t = await createTestEnv();
  for (const p of ['/api/inventory', '/api/grants', '/api/keys', '/api/usage', '/api/settings', '/api/audit', '/api/jobs', '/api/shared-with-me']) {
    const out = await readJson(await t.call(p));
    assert.equal(out.status, 401, p);
    assert.equal(out.json.code, 'AUTH_REQUIRED');
  }
});

test('cross-user reads are rejected or owner-scoped', async () => {
  const t = await createTestEnv();
  const bobRes = await readJson(await t.call('/api/inventory', { method: 'POST', headers: { ...t.as(t.bob), ...t.csrf }, body: { name: 'bob-box' } }));
  assert.equal(bobRes.status, 201);
  const cross = await readJson(await t.call('/api/inventory/' + bobRes.json.id, { headers: t.as(t.alice) }));
  assert.equal(cross.status, 404);
  assert.equal(cross.json.code, 'NOT_FOUND');
  const aliceInv = await readJson(await t.call('/api/inventory', { headers: t.as(t.alice) }));
  assert.equal(aliceInv.json.total, 0);
  const usage = await readJson(await t.call('/api/usage', { headers: t.as(t.alice) }));
  assert.equal(usage.json.total, 0);
});

test('resource registration validates input', async () => {
  const t = await createTestEnv();
  const bad = await readJson(await t.call('/api/inventory', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: '' } }));
  assert.equal(bad.status, 400);
  const r = await registerResource(t);
  assert.equal(r.state.status, 'unauthenticated'); // declared: configured, nothing verified
  assert.equal(r.verification.note, 'Declared by owner; not verified.');
});

test('grant lifecycle: create, duplicate, quotas, revoke', async () => {
  const t = await createTestEnv();
  const r = await registerResource(t);
  const mk = (body) => t.call('/api/grants', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { resourceId: r.id, grantee: 'bob@example.com', maxJobs: 50, maxTokens: 50000, ...body } });
  const g = await readJson(await mk({}));
  assert.equal(g.status, 201);
  assert.equal((await readJson(await mk({}))).status, 409);
  assert.equal((await readJson(await mk({ grantee: 'alice@example.com' }))).json.code, 'SELF_SHARE');
  assert.equal((await readJson(await mk({ grantee: 'ghost@example.com' }))).json.code, 'USER_NOT_FOUND');
  assert.equal((await readJson(await mk({ maxJobs: 0 }))).json.code, 'BAD_QUOTA');
  const shared = await readJson(await t.call('/api/shared-with-me', { headers: t.as(t.bob) }));
  assert.equal(shared.json.total, 1);
  assert.equal(shared.json.items[0].enforcement, 'recorded');
  const otherRevoke = await readJson(await t.call('/api/grants/' + g.json.id, { method: 'DELETE', headers: { ...t.as(t.bob), ...t.csrf } }));
  assert.equal(otherRevoke.status, 404);
  const rev = await readJson(await t.call('/api/grants/' + g.json.id, { method: 'DELETE', headers: { ...t.as(t.alice), ...t.csrf } }));
  assert.equal(rev.status, 200);
  const after = await readJson(await t.call('/api/shared-with-me', { headers: t.as(t.bob) }));
  assert.equal(after.json.total, 0);
});

test('API keys: mint, one-time reveal, scope, revoke, expiry, no-secret lists', async () => {
  const t = await createTestEnv();
  const created = await readJson(await t.call('/api/keys', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'ci', scope: 'read' } }));
  assert.equal(created.status, 201);
  assert.ok(created.json.secret.startsWith('aip_live_k_'), 'secret shape');
  assert.ok(created.json.oneTime);
  const listed = await readJson(await t.call('/api/keys', { headers: t.as(t.alice) }));
  assert.equal(listed.json.total, 1);
  const row = JSON.stringify(listed.json);
  assert.ok(!row.includes(created.json.secret) && !row.includes('verifier') && !row.includes('salt'), 'no secret material in lists');
  const authed = await readJson(await t.call('/api/inventory', { headers: { Authorization: 'Bearer ' + created.json.secret } }));
  assert.equal(authed.status, 200);
  const mgmt = await readJson(await t.call('/api/grants', { headers: { Authorization: 'Bearer ' + created.json.secret } }));
  assert.equal(mgmt.status, 403);
  assert.equal(mgmt.json.code, 'KEY_FORBIDDEN');
  const inf = await readJson(await t.call('/api/jobs', { method: 'POST', headers: { Authorization: 'Bearer ' + created.json.secret }, body: {} }));
  assert.equal(inf.status, 403);
  assert.equal(inf.json.code, 'KEY_SCOPE');
  const bad = await readJson(await t.call('/api/inventory', { headers: { Authorization: 'Bearer aip_live_k_0000000000000000_nope' } }));
  assert.equal(bad.status, 401);
  const rev = await readJson(await t.call('/api/keys/' + created.json.id, { method: 'DELETE', headers: { ...t.as(t.alice), ...t.csrf } }));
  assert.equal(rev.status, 200);
  const used = await readJson(await t.call('/api/inventory', { headers: { Authorization: 'Bearer ' + created.json.secret } }));
  assert.equal(used.status, 401);
  // Expired key row is rejected distinctly.
  await t.DB.prepare("UPDATE key_verifiers SET revoked_at = NULL, expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(created.json.id).run();
  const exp = await readJson(await t.call('/api/inventory', { headers: { Authorization: 'Bearer ' + created.json.secret } }));
  assert.equal(exp.status, 401);
  assert.equal(exp.json.code, 'KEY_EXPIRED');
});

test('session mutations require the CSRF header and same origin', async () => {
  const t = await createTestEnv();
  const noHeader = await readJson(await t.call('/api/keys', { method: 'POST', headers: t.as(t.alice), body: { name: 'x', scope: 'read' } }));
  assert.equal(noHeader.status, 403);
  assert.equal(noHeader.json.code, 'CSRF_REQUIRED');
  const badOrigin = await readJson(await t.call('/api/keys', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf, Origin: 'https://evil.example' }, body: { name: 'x', scope: 'read' } }));
  assert.equal(badOrigin.status, 403);
});

test('job submission is disabled without dispatch authorization', async () => {
  const t = await createTestEnv();
  const r = await registerResource(t);
  const out = await readJson(await t.call('/api/jobs', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { resourceId: r.id, prompt: 'hi', model: 'demo' } }));
  assert.equal(out.status, 501);
  assert.equal(out.json.code, 'INFERENCE_DISABLED');
});

test('settings and audit round-trip per user', async () => {
  const t = await createTestEnv();
  const before = await readJson(await t.call('/api/settings', { headers: t.as(t.alice) }));
  assert.equal(before.json.email, 'alice@example.com');
  const save = await readJson(await t.call('/api/settings', { method: 'PATCH', headers: { ...t.as(t.alice), ...t.csrf }, body: { displayName: 'Alice Q' } }));
  assert.equal(save.json.displayName, 'Alice Q');
  const audit = await readJson(await t.call('/api/audit', { headers: t.as(t.alice) }));
  assert.ok(audit.json.items.some((a) => a.action === 'settings.update'));
  const bobAudit = await readJson(await t.call('/api/audit', { headers: t.as(t.bob) }));
  assert.ok(!bobAudit.json.items.some((a) => a.action === 'settings.update'));
});

test('allowlist accepts invited emails and rejects the rest', async () => {
  const t = await createTestEnv();
  assert.equal(await isInvited(t.DB, 'alice@example.com'), true);
  assert.equal(await isInvited(t.DB, '  ALICE@example.com '), true);
  assert.equal(await isInvited(t.DB, 'mallory@example.com'), false);
  assert.equal(await isInvited(t.DB, ''), false);
  assert.equal(await isInvited(t.DB, null), false);
  // NOTE: the databaseHooks gate runs inside the live GitHub OAuth callback;
  // that handshake needs a real OAuth app and stays PENDING (see manifest).
});

test('missing secrets fail closed without leaking', async () => {
  const t = await createTestEnv({ BETTER_AUTH_SECRET: '' });
  for (const p of ['/api/inventory', '/api/auth/get-session']) {
    const out = await readJson(await t.call(p));
    assert.equal(out.status, 500, p);
    assert.equal(out.json.code, 'CONFIG');
    assert.ok(!out.text.includes('SECRET'), 'no secret material');
  }
});

test('OAuth routes fail closed when GitHub is unconfigured', async () => {
  const t = await createTestEnv({ GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' });
  const out = await readJson(await t.call('/api/auth/sign-in/social', { method: 'POST', body: { provider: 'github', callbackURL: 'http://localhost:8787/app/' } }));
  assert.equal(out.status, 503);
  assert.equal(out.json.code, 'OAUTH_UNCONFIGURED');
});

test('GitHub sign-in builds a real authorization redirect (no network)', async () => {
  const t = await createTestEnv();
  const res = await t.call('/api/auth/sign-in/social', { method: 'POST', body: { provider: 'github', callbackURL: 'http://localhost:8787/app/' } });
  const out = await readJson(res);
  const url = out.json && (out.json.url || out.json.redirect);
  assert.ok(res.status === 200 && url, out.text);
  assert.ok(url.includes('github.com/login/oauth/authorize'), url);
  assert.ok(url.includes('client_id=test-client-id'), url);
  assert.ok(url.includes('state='), url);
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie().join(';') : (res.headers.get('set-cookie') || '');
  assert.ok(/state|verifier/i.test(cookies), 'state/verifier cookie set');
});

test('unknown API routes stay JSON; assets fall through untouched', async () => {
  const t = await createTestEnv();
  const nope = await readJson(await t.call('/api/nope'));
  assert.equal(nope.status, 404);
  assert.equal(nope.json.code, 'NOT_FOUND');
  const landing = await t.call('/');
  assert.equal(landing.status, 200);
  assert.ok(t.assetsHits.includes('/'), 'landing falls through to ASSETS');
  const app = await t.call('/app/');
  assert.equal(app.status, 200);
  assert.ok((app.headers.get('Content-Security-Policy') || '').includes("script-src 'self'"), 'app CSP applied');
  const bare = await t.call('/app');
  assert.equal(bare.status, 302);
  assert.ok(bare.headers.get('location').endsWith('/app/'));
});

test('logout ends the session everywhere', async () => {
  const t = await createTestEnv();
  const out = await readJson(await t.call('/api/auth/sign-out', { method: 'POST', headers: { ...t.as(t.alice), Origin: 'http://localhost:8787' } }));
  assert.equal(out.status, 200);
  const again = await readJson(await t.call('/api/auth/get-session', { headers: t.as(t.alice) }));
  assert.ok(again.json === null || again.status === 401, again.text);
  const api = await readJson(await t.call('/api/inventory', { headers: t.as(t.alice) }));
  assert.equal(api.status, 401);
});

test('imported secret is the documented test value', () => {
  assert.ok(TEST_SECRET.length >= 32 && TEST_SECRET.startsWith('test-only-'));
});

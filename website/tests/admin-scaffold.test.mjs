/* Built with Meta Muse. */
// Admin scaffold tests: deny-by-default authorization, role separation,
// unavailable-state envelopes, and mutation stubs that change nothing.
// All keys and grants are disposable in-memory fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';

const READS = [
  '/api/admin/v1/status',
  '/api/admin/v1/overview',
  '/api/admin/v1/fabrics',
  '/api/admin/v1/resources',
  '/api/admin/v1/metrics',
  '/api/admin/v1/access/users',
  '/api/admin/v1/operations/health',
  '/api/admin/v1/operations/alerts',
  '/api/admin/v1/tickets',
  '/api/admin/v1/engineering/exports',
  '/api/admin/v1/engineering/assignments',
  '/api/admin/v1/audit',
  '/api/admin/v1/coverage'
];

async function grant(t, userId, role, over = {}) {
  const now = new Date().toISOString();
  await t.DB.prepare(
    'INSERT INTO admin_grants (id, user_id, role, scope, expires_at, created_at, created_by, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind('g_' + Math.random().toString(36).slice(2, 10), userId, role,
    over.scope === undefined ? 'platform' : over.scope,
    over.expires_at === undefined ? null : over.expires_at,
    now, 'operator', over.revoked_at === undefined ? null : over.revoked_at).run();
}

async function mintKey(t, user, body) {
  const out = await readJson(await t.call('/api/keys', { method: 'POST', headers: { ...t.as(user), ...t.csrf }, body }));
  assert.equal(out.status, 201, out.text);
  return out.json;
}

test('admin: unauthenticated callers get 401 on known and unknown routes', async () => {
  const t = await createTestEnv();
  for (const p of [...READS, '/api/admin/v1/nope']) {
    const out = await readJson(await t.call(p));
    assert.equal(out.status, 401, p);
    assert.equal(out.json.code, 'AUTH_REQUIRED');
  }
  const post = await readJson(await t.call('/api/admin/v1/access/users/u_bob/suspensions', { method: 'POST', body: {} }));
  assert.equal(post.status, 401);
});

test('admin: sessions without a grant are forbidden everywhere, authz before CSRF', async () => {
  const t = await createTestEnv();
  for (const p of READS) {
    const out = await readJson(await t.call(p, { headers: t.as(t.alice) }));
    assert.equal(out.status, 403, p);
    assert.equal(out.json.code, 'ADMIN_FORBIDDEN');
  }
  // No CSRF header either: authorization still answers first.
  const post = await readJson(await t.call('/api/admin/v1/access/users/u_bob/suspensions',
    { method: 'POST', headers: t.as(t.alice), body: {} }));
  assert.equal(post.status, 403);
  assert.equal(post.json.code, 'ADMIN_FORBIDDEN');
});

test('admin: user API keys never authorize administration', async () => {
  const t = await createTestEnv();
  const read = await mintKey(t, t.alice, { name: 'r', scope: 'read' });
  const inf = await mintKey(t, t.alice, { name: 'i', scope: 'inference' });
  for (const secret of [read.secret, inf.secret]) {
    const status = await readJson(await t.call('/api/admin/v1/status', { headers: { Authorization: 'Bearer ' + secret } }));
    assert.equal(status.status, 403);
    assert.equal(status.json.code, 'ADMIN_FORBIDDEN');
    const post = await readJson(await t.call('/api/admin/v1/access/users/u_bob/suspensions',
      { method: 'POST', headers: { Authorization: 'Bearer ' + secret }, body: {} }));
    assert.equal(post.status, 403);
    assert.equal(post.json.code, 'ADMIN_FORBIDDEN');
  }
  await t.DB.prepare('UPDATE key_verifiers SET expires_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - 3600 * 1000).toISOString(), read.id).run();
  const expired = await readJson(await t.call('/api/admin/v1/status', { headers: { Authorization: 'Bearer ' + read.secret } }));
  assert.equal(expired.status, 403);
  assert.equal(expired.json.code, 'ADMIN_FORBIDDEN');
});

test('admin: heartbeat keys fail closed', async () => {
  const t = await createTestEnv();
  const reg = await readJson(await t.call('/api/inventory',
    { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'hb-box' } }));
  assert.equal(reg.status, 201, reg.text);
  const hb = await mintKey(t, t.alice, { name: 'hb', scope: 'heartbeat', resourceId: reg.json.id });
  const out = await readJson(await t.call('/api/admin/v1/status', { headers: { Authorization: 'Bearer ' + hb.secret } }));
  assert.equal(out.status, 403);
  assert.equal(out.json.code, 'ADMIN_FORBIDDEN');
});

test('admin: revoked, expired, unknown-role, and wrong-scope grants fail closed', async () => {
  const t = await createTestEnv();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  await grant(t, 'u_alice', 'operations_observer', { revoked_at: new Date().toISOString() });
  await grant(t, 'u_bob', 'operations_observer', { expires_at: past });
  let out = await readJson(await t.call('/api/admin/v1/status', { headers: t.as(t.alice) }));
  assert.equal(out.status, 403, 'revoked grant must fail');
  out = await readJson(await t.call('/api/admin/v1/status', { headers: t.as(t.bob) }));
  assert.equal(out.status, 403, 'expired grant must fail');
  await t.DB.prepare('UPDATE admin_grants SET revoked_at = NULL WHERE user_id = ?').bind('u_alice').run();
  out = await readJson(await t.call('/api/admin/v1/status', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200, 'un-revoked grant authorizes again');
  await t.DB.prepare('UPDATE admin_grants SET role = ? WHERE user_id = ?').bind('superuser', 'u_alice').run();
  out = await readJson(await t.call('/api/admin/v1/status', { headers: t.as(t.alice) }));
  assert.equal(out.status, 403, 'unknown role must fail');
  await t.DB.prepare('UPDATE admin_grants SET role = ?, scope = ? WHERE user_id = ?').bind('operations_observer', 'other', 'u_alice').run();
  out = await readJson(await t.call('/api/admin/v1/status', { headers: t.as(t.alice) }));
  assert.equal(out.status, 403, 'unrecognized scope must fail');
});

test('admin: disabled users authorize nothing even with a live grant', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'operations_observer');
  await t.DB.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').bind('u_alice').run();
  const out = await readJson(await t.call('/api/admin/v1/status', { headers: t.as(t.alice) }));
  assert.equal(out.status, 401);
  assert.equal(out.json.code, 'AUTH_REQUIRED');
});

test('admin: live grant unlocks scoped reads as unavailable envelopes, never zeros', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'operations_observer');
  const status = await readJson(await t.call('/api/admin/v1/status', { headers: t.as(t.alice) }));
  assert.equal(status.status, 200);
  assert.equal(status.json.grant.role, 'operations_observer');
  assert.equal(status.json.elevation, 'not_implemented');
  for (const p of ['/api/admin/v1/overview', '/api/admin/v1/fabrics', '/api/admin/v1/resources',
    '/api/admin/v1/operations/health', '/api/admin/v1/operations/alerts', '/api/admin/v1/coverage']) {
    const out = await readJson(await t.call(p, { headers: t.as(t.alice) }));
    assert.equal(out.status, 200, p);
    assert.equal(out.json.state, 'unavailable', p);
    assert.ok(out.json.reason_code, p);
    assert.ok(out.json.schema_version, p);
    if (Array.isArray(out.json.items)) assert.equal(out.json.total, null, p + ' total must be null, not 0');
  }
  const metrics = await readJson(await t.call('/api/admin/v1/metrics?metric=time_to_first_token_ms&window=15m', { headers: t.as(t.alice) }));
  assert.equal(metrics.status, 200);
  assert.equal(metrics.json.schema_version, 'admin.metrics.v1');
  assert.equal(metrics.json.state, 'not_instrumented');
  assert.equal(metrics.json.value, null);
  const badMetric = await readJson(await t.call('/api/admin/v1/metrics?metric=everything', { headers: t.as(t.alice) }));
  assert.equal(badMetric.status, 400);
  assert.equal(badMetric.json.code, 'BAD_METRIC');
  const badWindow = await readJson(await t.call('/api/admin/v1/metrics?window=99y', { headers: t.as(t.alice) }));
  assert.equal(badWindow.status, 400);
  assert.equal(badWindow.json.code, 'BAD_WINDOW');
});

test('admin: roles stay separated across reads', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'operations_observer');
  await grant(t, 'u_bob', 'access_administrator');
  // Observer sees metrics but no user directory; access admin sees the
  // directory but no metric slices: no identity-to-traffic join.
  let out = await readJson(await t.call('/api/admin/v1/access/users', { headers: t.as(t.alice) }));
  assert.equal(out.status, 403);
  out = await readJson(await t.call('/api/admin/v1/metrics', { headers: t.as(t.bob) }));
  assert.equal(out.status, 403);
  out = await readJson(await t.call('/api/admin/v1/access/users', { headers: t.as(t.bob) }));
  assert.equal(out.status, 200);
  await grant(t, 'u_bob', 'security_reviewer');
  out = await readJson(await t.call('/api/admin/v1/audit', { headers: t.as(t.bob) }));
  assert.equal(out.status, 200);
  out = await readJson(await t.call('/api/admin/v1/tickets', { headers: t.as(t.bob) }));
  assert.equal(out.status, 403);
});

test('admin: mutations enforce CSRF, then 501 without changing state', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'access_administrator');
  const before = await t.DB.prepare('SELECT COUNT(*) AS n FROM audit').bind().first('n');
  const noCsrf = await readJson(await t.call('/api/admin/v1/access/users/u_bob/suspensions',
    { method: 'POST', headers: t.as(t.alice), body: {} }));
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.code, 'CSRF_REQUIRED');
  for (const p of [
    '/api/admin/v1/access/users/u_bob/suspensions',
    '/api/admin/v1/access/users/u_bob/restorations',
    '/api/admin/v1/access/users/u_bob/sessions/revocations',
    '/api/admin/v1/access/users/u_bob/keys/revocations',
    '/api/admin/v1/access/users/u_bob/keys/replacements',
    '/api/admin/v1/access/users/u_bob/recovery/challenges'
  ]) {
    const out = await readJson(await t.call(p, { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: {} }));
    assert.equal(out.status, 501, p);
    assert.equal(out.json.code, 'ADMIN_NOT_IMPLEMENTED');
  }
  // Nothing changed: no audit rows, target sessions and keys untouched.
  const after = await t.DB.prepare('SELECT COUNT(*) AS n FROM audit').bind().first('n');
  assert.equal(after, before);
  const sessions = await t.DB.prepare('SELECT COUNT(*) AS n FROM session WHERE userId = ?').bind('u_bob').first('n');
  assert.equal(sessions, 1);
  const bobInv = await readJson(await t.call('/api/inventory', { headers: t.as(t.bob) }));
  assert.equal(bobInv.status, 200);
});

test('admin: observer stays read-only on alert acknowledgement', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'operations_observer');
  const out = await readJson(await t.call('/api/admin/v1/operations/alerts/a_1/acknowledgements',
    { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: {} }));
  assert.equal(out.status, 403);
  assert.equal(out.json.code, 'ADMIN_FORBIDDEN');
});

test('admin: unknown routes do not leak to unauthorized callers', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'operations_observer');
  let out = await readJson(await t.call('/api/admin/v1/does-not-exist', { headers: t.as(t.bob) }));
  assert.equal(out.status, 403);
  out = await readJson(await t.call('/api/admin/v1/does-not-exist', { headers: t.as(t.alice) }));
  assert.equal(out.status, 404);
  assert.equal(out.json.code, 'NOT_FOUND');
});

test('admin: panel shell serves with app headers; methods restricted', async () => {
  const t = await createTestEnv();
  const redir = await t.call('/admin', { method: 'GET' });
  assert.equal(redir.status, 302);
  assert.equal(redir.headers.get('Location'), 'http://localhost:8787/admin/');
  const shell = await t.call('/admin/');
  assert.equal(shell.status, 200);
  assert.ok((shell.headers.get('Content-Security-Policy') || '').includes("script-src 'self'"));
  assert.ok((shell.headers.get('Cache-Control') || '').includes('no-store'));
  const denied = await t.call('/admin/', { method: 'POST' });
  assert.equal(denied.status, 405);
});

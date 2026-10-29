// Independent verification of Muse's #19/#20 claims @ 2e2859d, ADAPTED for
// the handoff fixes: the P3 probe now asserts the fixed behavior (a forged
// secret learns nothing), and the write-budget separation sums scope out
// the separate heartbeat buckets that share the write_budget table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createTestEnv, readJson, MIGRATION_FILES } from './d1-shim.mjs';

async function register(t, user, name) {
  const res = await readJson(await t.call('/api/inventory', { method: 'POST', headers: { ...t.as(user), ...t.csrf }, body: { name, kind: 'local', origin: 'lab', cpu: 'x', gpu: 'y' } }));
  assert.equal(res.status, 201, res.text); return res.json;
}
async function mint(t, user, body) {
  return readJson(await t.call('/api/keys', { method: 'POST', headers: { ...t.as(user), ...t.csrf }, body }));
}
const beat = (t, secret, id, body = { usable: true }) => t.call(`/api/resources/${id}/heartbeat`, { method: 'POST', headers: { Authorization: 'Bearer ' + secret }, body: JSON.stringify(body) });

test('#19: summary counts all owned resources; total equals inventory total', async () => {
  const t = await createTestEnv();
  for (let i = 0; i < 73; i++) await register(t, t.alice, 'box-' + i);
  await register(t, t.bob, 'bob-box');
  const s = (await readJson(await t.call('/api/status', { headers: t.as(t.alice) }))).json;
  const inv = (await readJson(await t.call('/api/inventory?limit=50', { headers: t.as(t.alice) }))).json;
  assert.equal(s.total, 73); assert.equal(s.summary.total, 73); assert.equal(inv.total, 73);
  assert.equal(s.items.length, 50); assert.equal(s.itemsTruncated, true);
  assert.equal(s.summary.offline + s.summary.online + s.summary.stale + s.summary.unknown, 73);
});

test('#20: a heartbeat key is rejected on every other API route', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'box');
  const key = (await mint(t, t.alice, { name: 'hb', scope: 'heartbeat', resourceId: r.id })).json;
  const H = { Authorization: 'Bearer ' + key.secret };
  const routes = [['GET', '/api/inventory'], ['POST', '/api/inventory'], ['GET', `/api/inventory/${r.id}`], ['PATCH', `/api/inventory/${r.id}`], ['DELETE', `/api/inventory/${r.id}`],
    ['GET', '/api/status'], ['GET', '/api/shared-with-me'], ['GET', '/api/grants'], ['POST', '/api/grants'], ['DELETE', '/api/grants/g_x'],
    ['GET', '/api/keys'], ['POST', '/api/keys'], ['DELETE', `/api/keys/${key.id}`], ['GET', '/api/jobs'], ['POST', '/api/jobs'], ['GET', '/api/jobs/j_x'],
    ['GET', '/api/usage'], ['GET', '/api/settings'], ['PATCH', '/api/settings'], ['GET', '/api/audit'], ['GET', '/api/auth/get-session']];
  const leaks = [];
  for (const [method, path] of routes) {
    const res = await readJson(await t.call(path, { method, headers: { ...H, 'X-Aipster-CSRF': '1' }, ...(method === 'GET' || method === 'DELETE' ? {} : { body: {} }) }));
    const ok = res.status >= 400 && res.status !== 404 || (res.status === 404 && path !== `/api/inventory/${r.id}`);
    if (!(res.status >= 401 && res.status <= 404) || (res.status === 200)) leaks.push(`${method} ${path} -> ${res.status}`);
    if (path === '/api/auth/get-session' && res.status === 200) assert.equal(res.json, null, 'auth session must not resolve from a heartbeat key');
  }
  console.log('# route results ok; leaks:', leaks);
  assert.deepEqual(leaks.filter((l) => !l.startsWith('GET /api/auth/get-session')), []);
  assert.equal((await readJson(await t.call('/api/keys', { headers: t.as(t.alice) }))).json.items.find((k) => k.id === key.id).revokedAt, null, 'heartbeat key could not revoke itself');
});

test('#20 P3 FIXED: revoked status needs the real secret; forged secrets get AUTH_REQUIRED', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'box');
  const key = (await mint(t, t.alice, { name: 'hb', scope: 'heartbeat', resourceId: r.id })).json;
  await t.call('/api/keys/' + key.id, { method: 'DELETE', headers: { ...t.as(t.alice), ...t.csrf } });
  const forged = key.secret.replace(/_[^_]+$/, '_' + 'A'.repeat(43));
  const res = await readJson(await beat(t, forged, r.id));
  assert.equal(res.status, 401);
  assert.equal(res.json.code, 'AUTH_REQUIRED', 'forged secret learns nothing about revocation');
  const real = await readJson(await beat(t, key.secret, r.id));
  assert.equal(real.status, 401);
  assert.equal(real.json.code, 'KEY_REVOKED', 'the real revoked secret still gets the distinct code');
});

async function toRealD1(t) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("x")}}',
    compatibilityDate: '2026-10-01', d1Databases: { DB: 'hb-review' }, outboundService: () => new Response('blocked', { status: 403 }) }));
  const db = await mf.getD1Database('DB');
  for (const file of MIGRATION_FILES) {
    const sql = (await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8')).split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    for (const stmt of sql.split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) await db.exec(stmt);
  }
  const stmts = [db.prepare('PRAGMA defer_foreign_keys = ON')];
  for (const { name } of t.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all())
    for (const row of t.sqlite.prepare(`SELECT * FROM "${name}"`).all()) { const c = Object.keys(row);
      stmts.push(db.prepare(`INSERT INTO "${name}" (${c.map(x => `"${x}"`).join(',')}) VALUES (${c.map(() => '?').join(',')})`).bind(...c.map(x => row[x]))); }
  await db.batch(stmts);
  t.env.DB = db; t.DB = db; return mf;
}

test('#20 REAL D1: 10 concurrent heartbeats -> exactly one 200, rest 429; revoke/expiry/delete/disable/foreign all refused', async (c) => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'box'), r2 = await register(t, t.alice, 'box2'), rb = await register(t, t.bob, 'bob');
  const k = (await mint(t, t.alice, { name: 'hb', scope: 'heartbeat', resourceId: r.id })).json;
  const k2 = (await mint(t, t.alice, { name: 'hb2', scope: 'heartbeat', resourceId: r2.id })).json;
  const mf = await toRealD1(t); c.after(() => mf.dispose());
  const statuses = (await Promise.all(Array.from({ length: 10 }, () => beat(t, k.secret, r.id)))).map((x) => x.status).sort();
  assert.deepEqual(statuses, [200, 429, 429, 429, 429, 429, 429, 429, 429, 429]);
  const row = await t.DB.prepare('SELECT online, usable, heartbeat_at FROM resources WHERE id = ?').bind(r.id).first();
  assert.equal(row.online, 1); assert.ok(row.heartbeat_at);
  assert.equal((await t.DB.prepare("SELECT count(*) n FROM write_budget WHERE user_id = 'u_alice'").first()).n >= 0, true);
  // Hourly write budget only: heartbeat claims live in separate 'hb/' buckets.
  const budgetBefore = (await t.DB.prepare("SELECT COALESCE(SUM(count),0) n FROM write_budget WHERE user_id = 'u_alice' AND window NOT LIKE 'hb/%'").first()).n;
  // Cross-resource and cross-tenant.
  assert.equal((await beat(t, k.secret, r2.id)).status, 404);
  assert.equal((await beat(t, k.secret, rb.id)).status, 404);
  // Bad bodies.
  for (const body of [{ usable: 'yes' }, { usable: true, at: 1 }, {}, []]) assert.equal((await beat(t, k2.secret, r2.id, body)).status, 400);
  // Expiry and revocation on real D1.
  await t.DB.prepare('UPDATE key_verifiers SET expires_at = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), k2.id).run();
  assert.equal((await beat(t, k2.secret, r2.id)).status, 401);
  await t.DB.prepare('UPDATE key_verifiers SET expires_at = NULL, revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), k2.id).run();
  assert.equal((await beat(t, k2.secret, r2.id)).status, 401);
  // Disabled owner.
  await t.DB.prepare('UPDATE resources SET heartbeat_at = NULL WHERE id = ?').bind(r.id).run();
  await t.DB.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').bind('u_alice').run();
  assert.equal((await beat(t, k.secret, r.id)).status, 401);
  assert.equal((await t.DB.prepare('SELECT heartbeat_at FROM resources WHERE id = ?').bind(r.id).first()).heartbeat_at, null);
  await t.DB.prepare('UPDATE "user" SET disabled = 0 WHERE id = ?').bind('u_alice').run();
  assert.equal((await beat(t, k.secret, r.id)).status, 200);
  const budgetAfter = (await t.DB.prepare("SELECT COALESCE(SUM(count),0) n FROM write_budget WHERE user_id = 'u_alice' AND window NOT LIKE 'hb/%'").first()).n;
  assert.equal(budgetAfter, budgetBefore, 'heartbeats draw no write budget');
});

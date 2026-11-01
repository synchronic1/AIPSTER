/* Built with Meta Muse. */
// Admin milestone 1 tests: real overview/resources data, honest empty/stale
// states, pagination, denial matrix, and tenant/identity isolation. All rows
// and grants are disposable in-memory fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';

async function grant(t, userId, role) {
  const now = new Date().toISOString();
  await t.DB.prepare(
    'INSERT INTO admin_grants (id, user_id, role, scope, expires_at, created_at, created_by, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind('g_' + Math.random().toString(36).slice(2, 10), userId, role, 'platform', null, now, 'operator', null).run();
}

async function seedResource(t, over = {}) {
  const now = new Date().toISOString();
  const id = over.id || ('r_' + Math.random().toString(36).slice(2, 10));
  await t.DB.prepare(
    'INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated, online, usable, heartbeat_at, limits_json, scope, verification_json, credits_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, over.owner_id || 'u_alice', over.name || ('box-' + id), over.kind === undefined ? 'local' : over.kind,
    'lab-bench-3', 'cpu-x9', 'none', '[]', over.configured === undefined ? 1 : over.configured,
    over.authenticated === undefined ? 1 : over.authenticated, over.online === undefined ? 0 : over.online,
    over.usable === undefined ? 0 : over.usable, over.heartbeat_at === undefined ? null : over.heartbeat_at,
    '{}', 'owner only', '{}', null, over.created_at || now).run();
  return id;
}

async function mintKey(t, user, body) {
  const out = await readJson(await t.call('/api/keys', { method: 'POST', headers: { ...t.as(user), ...t.csrf }, body }));
  assert.equal(out.status, 201, out.text);
  return out.json;
}

const READS = ['/api/admin/v1/overview', '/api/admin/v1/resources'];

test('admin overview/resources: denial matrix unchanged for real reads', async () => {
  const t = await createTestEnv();
  await seedResource(t, { id: 'r_den1' });
  for (const p of READS) {
    const anon = await readJson(await t.call(p));
    assert.equal(anon.status, 401, p);
    const grantless = await readJson(await t.call(p, { headers: t.as(t.alice) }));
    assert.equal(grantless.status, 403, p);
    assert.equal(grantless.json.code, 'ADMIN_FORBIDDEN');
  }
  await grant(t, 'u_alice', 'access_administrator');
  for (const p of READS) {
    const wrongRole = await readJson(await t.call(p, { headers: t.as(t.alice) }));
    assert.equal(wrongRole.status, 403, p + ' directory role must not read operations inventory');
  }
  const key = await mintKey(t, t.alice, { name: 'k', scope: 'read' });
  for (const p of READS) {
    const viaKey = await readJson(await t.call(p, { headers: { Authorization: 'Bearer ' + key.secret } }));
    assert.equal(viaKey.status, 403, p);
  }
  await grant(t, 'u_bob', 'operations_observer');
  await t.DB.prepare('UPDATE "user" SET demo = 1 WHERE id = ?').bind('u_bob').run();
  for (const p of READS) {
    const demo = await readJson(await t.call(p, { headers: t.as(t.bob) }));
    assert.equal(demo.status, 403, p + ' demo tenant never administers');
  }
});

test('admin overview: empty inventory reports measured zeros, gaps stay explicit', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'operations_observer');
  const out = await readJson(await t.call('/api/admin/v1/overview', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.equal(out.json.schema_version, 'admin.overview.v1');
  assert.equal(out.json.state, 'available');
  assert.ok(out.json.observed_at, 'observed_at anchors the counts');
  assert.deepEqual(out.json.resources, { total: 0, online: 0, stale: 0, offline: 0, unknown: 0 });
  assert.equal(out.json.fabrics, null);
  assert.equal(out.json.fabrics_state, 'unavailable');
  assert.equal(out.json.fabrics_reason_code, 'fabric_model_pending');
  assert.equal(out.json.usable_capacity, null);
  assert.equal(out.json.usable_capacity_state, 'not_instrumented');
  assert.equal(out.json.coverage, null);
  assert.equal(out.json.coverage_state, 'unavailable');
  assert.equal(out.json.coverage_reason_code, 'coverage_pending');
});

test('admin overview/resources: liveness buckets derive from heartbeat freshness', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'operations_observer');
  const now = Date.now();
  await seedResource(t, { id: 'r_fresh', online: 1, usable: 1, heartbeat_at: new Date(now - 60 * 1000).toISOString() });
  await seedResource(t, { id: 'r_stale', online: 1, heartbeat_at: new Date(now - 10 * 60 * 1000).toISOString() });
  await seedResource(t, { id: 'r_off', online: 0, heartbeat_at: new Date(now - 60 * 1000).toISOString() });
  await seedResource(t, { id: 'r_never', online: 1 });
  await seedResource(t, { id: 'r_garbled', online: 1, heartbeat_at: 'not-a-timestamp' });
  const over = await readJson(await t.call('/api/admin/v1/overview', { headers: t.as(t.alice) }));
  assert.equal(over.status, 200);
  assert.deepEqual(over.json.resources, { total: 5, online: 1, stale: 1, offline: 1, unknown: 2 });
  const res = await readJson(await t.call('/api/admin/v1/resources?limit=50', { headers: t.as(t.alice) }));
  assert.equal(res.status, 200);
  assert.equal(res.json.schema_version, 'admin.resources.v1');
  assert.equal(res.json.state, 'available');
  assert.equal(res.json.total, 5);
  const byId = Object.fromEntries(res.json.items.map((it) => [it.id, it]));
  assert.equal(byId.r_fresh.liveness, 'online');
  assert.ok(byId.r_fresh.lastSeenAt, 'fresh rows carry lastSeenAt');
  assert.ok(Number.isSafeInteger(byId.r_fresh.lastSeenAgeMs) && byId.r_fresh.lastSeenAgeMs >= 0);
  assert.equal(byId.r_stale.liveness, 'stale');
  assert.ok(byId.r_stale.lastSeenAgeMs > 5 * 60 * 1000 - 60 * 1000, 'stale age reflects the old heartbeat');
  assert.equal(byId.r_off.liveness, 'offline');
  assert.equal(byId.r_off.lastSeenAt, null, 'offline rows carry no last-seen timestamp');
  assert.equal(byId.r_off.lastSeenAgeMs, null);
  assert.equal(byId.r_never.liveness, 'unknown');
  assert.equal(byId.r_never.lastSeenAt, null);
  assert.equal(byId.r_garbled.liveness, 'unknown', 'unparseable telemetry is unknown, never online');
  assert.equal(byId.r_fresh.usable, true);
  assert.equal(byId.r_fresh.configured, true);
  assert.equal(byId.r_fresh.authenticated, true);
});

test('admin resources: pagination windows are stable and bounded', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'operations_observer');
  for (const id of ['r_01', 'r_02', 'r_03', 'r_04', 'r_05']) await seedResource(t, { id });
  const page = async (qs) => readJson(await t.call('/api/admin/v1/resources' + qs, { headers: t.as(t.alice) }));
  const p1 = await page('?limit=2&offset=0');
  assert.equal(p1.status, 200);
  assert.deepEqual(p1.json.items.map((it) => it.id), ['r_01', 'r_02']);
  assert.equal(p1.json.total, 5);
  assert.equal(p1.json.limit, 2);
  assert.equal(p1.json.offset, 0);
  const p2 = await page('?limit=2&offset=2');
  assert.deepEqual(p2.json.items.map((it) => it.id), ['r_03', 'r_04']);
  assert.equal(p2.json.total, 5);
  const p3 = await page('?limit=2&offset=4');
  assert.deepEqual(p3.json.items.map((it) => it.id), ['r_05']);
  const beyond = await page('?limit=2&offset=9');
  assert.deepEqual(beyond.json.items, []);
  assert.equal(beyond.json.total, 5, 'total survives over-offset');
  const garbage = await page('?limit=abc&offset=-5');
  assert.equal(garbage.json.limit, 20, 'garbage limit falls back to the default');
  assert.equal(garbage.json.offset, 0);
  assert.equal(garbage.json.items.length, 5);
  const capped = await page('?limit=9999');
  assert.equal(capped.json.limit, 50, 'limit clamps to the shared page cap');
});

test('admin resources: items carry no identity- or address-shaped fields', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'operations_observer');
  await seedResource(t, { id: 'r_x', owner_id: 'u_bob', online: 1, heartbeat_at: new Date().toISOString() });
  const res = await readJson(await t.call('/api/admin/v1/resources', { headers: t.as(t.alice) }));
  assert.equal(res.status, 200);
  assert.equal(res.json.items.length, 1, 'platform scope sees cross-tenant rows');
  const keys = Object.keys(res.json.items[0]).sort();
  assert.deepEqual(keys, ['authenticated', 'configured', 'id', 'kind', 'lastSeenAgeMs', 'lastSeenAt', 'liveness', 'name', 'usable']);
  for (const banned of ['owner_id', 'owner', 'user', 'email', 'cpu', 'gpu', 'origin', 'limits', 'limits_json', 'credits', 'credits_json', 'verification', 'verification_json']) {
    assert.ok(!(banned in res.json.items[0]), banned + ' must stay out of admin items');
  }
  const denied = await readJson(await t.call('/api/admin/v1/resources', { headers: t.as(t.bob) }));
  assert.equal(denied.status, 403, 'row owner without a grant still denied');
});

test('admin resources: malformed rows skip items but keep the measured total', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'operations_observer');
  await seedResource(t, { id: 'r_good' });
  await seedResource(t, { id: 'r_bad', kind: 'bogus-kind!!' });
  const res = await readJson(await t.call('/api/admin/v1/resources', { headers: t.as(t.alice) }));
  assert.equal(res.status, 200);
  assert.equal(res.json.total, 2, 'aggregate counts every row, like the status route');
  assert.deepEqual(res.json.items.map((it) => it.id), ['r_good'], 'malformed rows fail closed per row');
});

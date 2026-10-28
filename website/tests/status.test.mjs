/* Built with Meta Muse. */
// Tests for the read-only resource-status slice (GET /api/status).
// Provenance: adapter shape adapted (not copied) from the upstream fabric
// worker domain.ts nodeStatus/aggregateFabricState and src/contracts.ts
// FabricState/FabricNode, inspected at upstream SHA
// f5223d39a4346a3fb2726be5e9b0f007861c9f0c. AIPSTER base
// 7b38ba071d6a6f1520140486835f9d6a01adafab. Apache-2.0, see LICENSE/NOTICE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatus, parseStatusRow, resourceLiveness, STALE_AFTER_MS } from '../src/lib/status.mjs';
import { createTestEnv, readJson } from './d1-shim.mjs';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

test('parseStatusRow accepts minimal authorized rows, rejects malformed ones', () => {
  assert.deepEqual(parseStatusRow({ id: 'r_1', name: 'lab', kind: 'local', online: 1, heartbeat_at: iso(NOW) }),
    { id: 'r_1', name: 'lab', kind: 'local', online: true, heartbeatAt: iso(NOW) });
  assert.equal(parseStatusRow(null), null);
  assert.equal(parseStatusRow({ id: 'r_1', name: '', kind: 'local' }), null);
  assert.equal(parseStatusRow({ id: 'r_1', name: 'x'.repeat(81), kind: 'local' }), null);
  assert.equal(parseStatusRow({ id: 'r_1', name: 'lab', kind: 'datacenter' }), null);
  assert.equal(parseStatusRow({ id: '../evil', name: 'lab', kind: 'local' }), null);
});

test('resourceLiveness adapts online|stale|offline and adds honest unknown', () => {
  const row = (online, heartbeatAt) => ({ id: 'r_1', name: 'lab', kind: 'local', online, heartbeatAt });
  assert.equal(resourceLiveness(row(false, null), NOW), 'offline');
  assert.equal(resourceLiveness(row(false, iso(NOW)), NOW), 'offline');
  assert.equal(resourceLiveness(row(true, null), NOW), 'unknown');
  assert.equal(resourceLiveness(row(true, 'not-a-time'), NOW), 'unknown');
  assert.equal(resourceLiveness(row(true, iso(NOW - 1000)), NOW), 'online');
  assert.equal(resourceLiveness(row(true, iso(NOW - STALE_AFTER_MS - 1)), NOW), 'stale');
});

test('buildStatus summarizes, caps items, and labels demo vs declared', () => {
  const rows = [
    { id: 'r_on', name: 'fresh', kind: 'local', online: 1, heartbeat_at: iso(NOW - 1000) },
    { id: 'r_st', name: 'old', kind: 'cluster', online: 1, heartbeat_at: iso(NOW - STALE_AFTER_MS - 1) },
    { id: 'r_off', name: 'declared', kind: 'provider', online: 0, heartbeat_at: null },
    { id: 'r_un', name: 'flag-no-telemetry', kind: 'local', online: 1, heartbeat_at: null },
    { id: 'bad id!', name: 'skipped', kind: 'local', online: 1, heartbeat_at: iso(NOW) },
  ];
  const out = buildStatus({ rows, sharedWithMe: 2, demo: false, nowMs: NOW });
  assert.equal(out.schema, 'aipster.status/1');
  assert.equal(out.telemetry, 'unavailable');
  assert.equal(out.demo, false);
  assert.equal(out.source, 'declared-resources');
  assert.deepEqual(out.summary, { total: 4, online: 1, stale: 1, offline: 1, unknown: 1 });
  assert.equal(out.sharedWithMe, 2);
  assert.equal(out.items.length, 4);
  assert.deepEqual(out.items.map((i) => i.liveness), ['online', 'stale', 'offline', 'unknown']);
  assert.ok(out.items.every((i) => i.demoFixture === false));
  assert.equal(out.items[0].lastSeenAgeMs, 1000);
  assert.equal(out.items[2].lastSeenAt, null);
  assert.equal(out.items[2].lastSeenAgeMs, null);
  const demo = buildStatus({ rows, sharedWithMe: -3, demo: true, nowMs: NOW });
  assert.equal(demo.source, 'demo-fixture');
  assert.equal(demo.sharedWithMe, 0);
  assert.ok(demo.items.every((i) => i.demoFixture === true));
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `r_${i}`, name: `n${i}`, kind: 'local', online: 0, heartbeat_at: null }));
  assert.equal(buildStatus({ rows: many, sharedWithMe: 0, demo: false, nowMs: NOW }).items.length, 50);
});

async function register(t, user, name) {
  const res = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: { ...t.as(user), ...t.csrf },
    body: { name, kind: 'local', origin: 'lab', cpu: 'x', gpu: 'y' },
  }));
  assert.equal(res.status, 201, res.text);
  return res.json;
}

test('GET /api/status requires auth and is read-only', async () => {
  const t = await createTestEnv();
  const anon = await readJson(await t.call('/api/status'));
  assert.equal(anon.status, 401);
  assert.equal(anon.json.code, 'AUTH_REQUIRED');
  const post = await readJson(await t.call('/api/status', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: {} }));
  assert.equal(post.status, 404);
  assert.equal(post.json.code, 'NOT_FOUND');
});

test('status is owner-scoped and leaks no free-text or cross-tenant fields', async () => {
  const t = await createTestEnv();
  const mine = await register(t, t.alice, 'alice-box');
  await register(t, t.bob, 'bob-box');
  await t.DB.prepare('UPDATE resources SET online = 1, heartbeat_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - 1000).toISOString(), mine.id).run();
  const out = await readJson(await t.call('/api/status', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.equal(out.json.schema, 'aipster.status/1');
  assert.equal(out.json.telemetry, 'unavailable');
  assert.equal(out.json.demo, false);
  assert.deepEqual(out.json.summary, { total: 1, online: 1, stale: 0, offline: 0, unknown: 0 });
  assert.deepEqual(Object.keys(out.json.items[0]).sort(),
    ['demoFixture', 'id', 'kind', 'lastSeenAgeMs', 'lastSeenAt', 'liveness', 'name']);
  const text = JSON.stringify(out.json);
  assert.ok(!text.includes('bob-box'), 'no other-tenant resource names');
  assert.ok(!/cpu|gpu|origin|limits|verifier|salt|secret/i.test(text.replace(/demoFixture/g, '')), 'no free-text or credential fields');
  const bob = await readJson(await t.call('/api/status', { headers: t.as(t.bob) }));
  assert.equal(bob.json.summary.total, 1);
  assert.equal(bob.json.items[0].name, 'bob-box');
  assert.equal(bob.json.items[0].liveness, 'offline');
});

test('read-scoped API keys may poll status; shared grants are counted', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'alice-box');
  const key = await readJson(await t.call('/api/keys', {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'poll', scope: 'read' },
  }));
  const viaKey = await readJson(await t.call('/api/status', { headers: { Authorization: 'Bearer ' + key.json.secret } }));
  assert.equal(viaKey.status, 200);
  assert.equal(viaKey.json.summary.total, 1);
  const grant = await readJson(await t.call('/api/grants', {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf },
    body: { resourceId: r.id, grantee: 'bob@example.com', maxJobs: 5, maxTokens: 500 },
  }));
  assert.equal(grant.status, 201);
  const bob = await readJson(await t.call('/api/status', { headers: t.as(t.bob) }));
  assert.equal(bob.json.sharedWithMe, 1);
  assert.equal(bob.json.summary.total, 0, 'shared resources are counted, never listed');
});

test('demo workspace is labeled as fixture, never live', async () => {
  const t = await createTestEnv();
  await t.DB.prepare('UPDATE "user" SET demo = 1 WHERE id = ?').bind(t.alice.id).run();
  await register(t, t.alice, 'demo-node');
  const out = await readJson(await t.call('/api/status', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.equal(out.json.demo, true);
  assert.equal(out.json.source, 'demo-fixture');
  assert.equal(out.json.telemetry, 'unavailable');
  assert.ok(out.json.items.every((i) => i.demoFixture === true));
});

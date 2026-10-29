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
    { id: 'r_1', name: 'lab', kind: 'local', online: true, heartbeatAt: iso(NOW), usable: null });
  assert.deepEqual(parseStatusRow({ id: 'r_1', name: 'lab', kind: 'local', online: 1, usable: 1, heartbeat_at: iso(NOW) }).usable, true);
  assert.deepEqual(parseStatusRow({ id: 'r_1', name: 'lab', kind: 'local', online: 1, usable: 0, heartbeat_at: iso(NOW) }).usable, false);
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
    ['demoFixture', 'id', 'kind', 'lastSeenAgeMs', 'lastSeenAt', 'liveness', 'name', 'usable']);
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

test('buildStatus uses the aggregate summary and flags truncation', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ id: `r_${i}`, name: `n${i}`, kind: 'local', online: 0, heartbeat_at: null }));
  const agg = buildStatus({
    rows, summary: { online: 3, stale: 3, offline: 52, unknown: 2 }, total: 60,
    sharedWithMe: 0, demo: false, nowMs: NOW,
  });
  assert.deepEqual(agg.summary, { total: 60, online: 3, stale: 3, offline: 52, unknown: 2 });
  assert.equal(agg.total, 60);
  assert.equal(agg.items.length, 50);
  assert.equal(agg.itemsTruncated, true);
  const small = buildStatus({
    rows: rows.slice(0, 4), summary: { online: 0, stale: 0, offline: 4, unknown: 0 }, total: 4,
    sharedWithMe: 0, demo: false, nowMs: NOW,
  });
  assert.equal(small.total, 4);
  assert.equal(small.itemsTruncated, false);
  // Legacy callers without an aggregate still derive counts from the page.
  const legacy = buildStatus({ rows: rows.slice(0, 4), sharedWithMe: 0, demo: false, nowMs: NOW });
  assert.deepEqual(legacy.summary, { total: 4, online: 0, stale: 0, offline: 4, unknown: 0 });
  assert.equal(legacy.itemsTruncated, false);
});

// Bulk seeding with deterministic created_at ordering: index 0 is the
// oldest, so ORDER BY created_at DESC pages from the end of `states`.
async function seedResources(t, user, states) {
  const base = Date.now();
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    await t.DB.prepare(`INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated, online, usable, heartbeat_at, limits_json, scope, verification_json, credits_json, created_at)
      VALUES (?, ?, ?, 'local', 'seed', 'x', 'y', '[]', 1, 0, ?, 0, ?, '{}', 'owner only', '{}', NULL, ?)`)
      .bind(`r_seed_${i}`, user.id, `seed-${i}`, s.online ? 1 : 0, s.hb ?? null,
        new Date(base + i * 1000).toISOString()).run();
  }
}
const freshHb = () => new Date(Date.now() - 1000).toISOString();
const staleHb = () => new Date(Date.now() - STALE_AFTER_MS - 60000).toISOString();

test('status total equals the inventory total beyond the 50-item page (60 resources)', async () => {
  const t = await createTestEnv();
  await seedResources(t, t.alice, Array.from({ length: 60 }, (_, i) => {
    const m = i % 4;
    if (m === 0) return { online: true, hb: freshHb() };
    if (m === 1) return { online: true, hb: staleHb() };
    if (m === 2) return { online: false, hb: null };
    return { online: true, hb: null };
  }));
  const out = await readJson(await t.call('/api/status', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.deepEqual(out.json.summary, { total: 60, online: 15, stale: 15, offline: 15, unknown: 15 });
  assert.equal(out.json.total, 60);
  assert.equal(out.json.items.length, 50);
  assert.equal(out.json.itemsTruncated, true);
  const inv = await readJson(await t.call('/api/inventory?limit=1', { headers: t.as(t.alice) }));
  assert.equal(inv.json.total, 60);
  assert.equal(out.json.total, inv.json.total, 'status total must equal the Overview inventory total');
});

test('status total equals the inventory total at the 100-resource cap', async () => {
  const t = await createTestEnv();
  await seedResources(t, t.alice, Array.from({ length: 100 }, (_, i) =>
    (i < 5 ? { online: true, hb: freshHb() } : { online: false, hb: null })));
  const out = await readJson(await t.call('/api/status', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.deepEqual(out.json.summary, { total: 100, online: 5, stale: 0, offline: 95, unknown: 0 });
  assert.equal(out.json.total, 100);
  assert.equal(out.json.items.length, 50);
  assert.equal(out.json.itemsTruncated, true);
  const inv = await readJson(await t.call('/api/inventory?limit=1', { headers: t.as(t.alice) }));
  assert.equal(inv.json.total, 100);
  assert.equal(out.json.total, inv.json.total, 'status total must equal the Overview inventory total');
});

test('status with zero resources reports an empty untruncated summary', async () => {
  const t = await createTestEnv();
  const out = await readJson(await t.call('/api/status', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.deepEqual(out.json.summary, { total: 0, online: 0, stale: 0, offline: 0, unknown: 0 });
  assert.equal(out.json.total, 0);
  assert.deepEqual(out.json.items, []);
  assert.equal(out.json.itemsTruncated, false);
  const inv = await readJson(await t.call('/api/inventory?limit=1', { headers: t.as(t.alice) }));
  assert.equal(inv.json.total, 0);
});

test('status counts come from the aggregate, not the listed page', async () => {
  const t = await createTestEnv();
  // Oldest 10 carry every liveness; the newest 50 (the listed page) are all offline.
  const head = [
    { online: true, hb: freshHb() }, { online: true, hb: freshHb() }, { online: true, hb: freshHb() },
    { online: true, hb: staleHb() }, { online: true, hb: staleHb() }, { online: true, hb: staleHb() },
    { online: true, hb: null }, { online: true, hb: null },
    { online: false, hb: null }, { online: false, hb: null },
  ];
  await seedResources(t, t.alice, [...head, ...Array.from({ length: 50 }, () => ({ online: false, hb: null }))]);
  const out = await readJson(await t.call('/api/status', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.deepEqual(out.json.summary, { total: 60, online: 3, stale: 3, offline: 52, unknown: 2 });
  assert.equal(out.json.total, 60);
  assert.equal(out.json.items.length, 50);
  assert.equal(out.json.itemsTruncated, true);
  assert.ok(out.json.items.every((i) => i.liveness === 'offline'), 'listed page is all offline while the aggregate is mixed');
  const inv = await readJson(await t.call('/api/inventory?limit=1', { headers: t.as(t.alice) }));
  assert.equal(out.json.total, inv.json.total, 'status total must equal the Overview inventory total');
});
test('inventory list stays under the D1 per-invocation query cap at 50 resources', async () => {
  // Codex P2 round 13: one ownerName() query per resource plus count,
  // list, and auth pushed a full 50-resource page past D1's 50-query
  // limit, 500ing the inventory the overview and keys tab depend on.
  // Every row is caller-owned, so one lookup must serve the whole page.
  const t = await createTestEnv();
  await seedResources(t, t.alice, Array.from({ length: 50 }, () => ({ online: false, hb: null })));
  let queries = 0;
  const origPrepare = t.DB.prepare.bind(t.DB);
  t.DB.prepare = (sql) => { queries++; return origPrepare(sql); };
  try {
    const inv = await readJson(await t.call('/api/inventory?limit=50', { headers: t.as(t.alice) }));
    assert.equal(inv.status, 200, inv.text);
    assert.equal(inv.json.items.length, 50);
    assert.ok(inv.json.items.every((c) => c.owner && c.owner.name === 'Alice'), 'owner name still resolved');
    assert.ok(queries < 50, `${queries} queries issued for one 50-resource page (D1 cap is 50)`);
  } finally {
    t.DB.prepare = origPrepare;
  }
});

test('shared-with-me resolves names in batched queries, not per grant', async () => {
  // Same round-13 finding: per-grant resource + owner lookups broke the
  // page past ~20 grants. Query count must not grow with the grant list.
  const t = await createTestEnv();
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, demo, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('u_carol', 'Carol', 'carol@example.com', 1, null, 0, now, now).run();
  let n = 0;
  const addGrants = async (ownerId, count) => {
    for (let i = 0; i < count; i++) {
      const r = `r_sh_${n}`;
      const g = `g_sh_${n}`;
      n++;
      await t.DB.prepare(`INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated, online, usable, heartbeat_at, limits_json, scope, verification_json, credits_json, created_at)
        VALUES (?, ?, ?, 'local', 'seed', 'x', 'y', '[]', 1, 1, 0, 0, NULL, '{}', 'owner only', '{}', NULL, ?)`)
        .bind(r, ownerId, `shared-${r}`, now).run();
      await t.DB.prepare('INSERT INTO grants (id, resource_id, owner_id, grantee_id, max_jobs, max_tokens, used_jobs, used_tokens, inference_only, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, ?, NULL)')
        .bind(g, r, ownerId, 'u_bob', 5, 500, now).run();
    }
  };
  await addGrants('u_alice', 3);
  await addGrants('u_carol', 2);
  const origPrepare = t.DB.prepare.bind(t.DB);
  let queries = 0;
  t.DB.prepare = (sql) => { queries++; return origPrepare(sql); };
  const fetchAsBob = async () => {
    queries = 0;
    const out = await readJson(await t.call('/api/shared-with-me?limit=50', { headers: t.as(t.bob) }));
    assert.equal(out.status, 200, out.text);
    return { out, queries };
  };
  try {
    // Warm the per-isolate auth cache so both measurements exclude it.
    await fetchAsBob();
    const first = await fetchAsBob();
    assert.equal(first.out.json.total, 5);
    await addGrants('u_alice', 5);
    const second = await fetchAsBob();
    assert.equal(second.out.json.total, 10);
    assert.equal(second.queries, first.queries, `queries grew with the grant list: ${first.queries} -> ${second.queries}`);
    const owners = new Set(second.out.json.items.map((g) => g.ownerName));
    assert.deepEqual([...owners].sort(), ['Alice', 'Carol']);
    assert.ok(second.out.json.items.every((g) => g.resourceName && g.resourceName.startsWith('shared-')), 'resource names resolved');
  } finally {
    t.DB.prepare = origPrepare;
  }
});

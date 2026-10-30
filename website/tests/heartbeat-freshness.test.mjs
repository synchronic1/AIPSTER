/* Handoff fix 1 (P2): inventory cards derive displayed online/usable/status
 * from heartbeat freshness at read time, using the same resourceLiveness /
 * STALE_AFTER_MS rule as GET /api/status. Covers the inventory list, the
 * inventory detail route, the POST response, and the shared-with-me arm. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { cardFor } from '../src/lib/store.js';
import { STALE_AFTER_MS } from '../src/lib/status.mjs';

async function register(t, user, name) {
  const res = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: { ...t.as(user), ...t.csrf },
    body: { name, kind: 'local', origin: 'lab', cpu: 'x', gpu: 'y' },
  }));
  assert.equal(res.status, 201, res.text);
  return res.json;
}

const byId = (items) => Object.fromEntries(items.map((i) => [i.id, i]));

test('parity: inventory state agrees with status liveness in every state', async () => {
  const t = await createTestEnv();
  const now = Date.now();
  const fixtures = {
    online: { online: 1, hb: new Date(now - 1000).toISOString() },
    stale: { online: 1, hb: new Date(now - STALE_AFTER_MS - 60000).toISOString() },
    unknown: { online: 1, hb: null },
    offline: { online: 0, hb: null },
  };
  const ids = {};
  for (const name of Object.keys(fixtures)) ids[name] = (await register(t, t.alice, name)).id;
  for (const [name, f] of Object.entries(fixtures)) {
    await t.DB.prepare('UPDATE resources SET online = ?, usable = 1, heartbeat_at = ? WHERE id = ?')
      .bind(f.online, f.hb, ids[name]).run();
  }
  const status = (await readJson(await t.call('/api/status', { headers: t.as(t.alice) }))).json;
  const inv = (await readJson(await t.call('/api/inventory?limit=50', { headers: t.as(t.alice) }))).json;
  const live = byId(status.items);
  const cards = byId(inv.items);
  assert.deepEqual(
    Object.fromEntries(Object.entries(ids).map(([n, id]) => [n, live[id].liveness])),
    { online: 'online', stale: 'stale', unknown: 'unknown', offline: 'offline' },
  );
  for (const [name, id] of Object.entries(ids)) {
    assert.equal(cards[id].state.online, live[id].liveness === 'online', `${name}: inventory online matches status`);
  }
  // usable is shown only while online: stale/unknown rows must not imply
  // readiness even though the stored usable bit is still 1.
  assert.equal(cards[ids.online].state.usable, true);
  assert.equal(cards[ids.stale].state.usable, false);
  assert.equal(cards[ids.unknown].state.usable, false);
  assert.equal(cards[ids.offline].state.usable, false);
  const stored = await t.DB.prepare('SELECT online, usable FROM resources WHERE id = ?').bind(ids.stale).first();
  assert.deepEqual([stored.online, stored.usable], [1, 1], 'display derives at read time; the stored flags are untouched');
});

test('cardFor uses the status rule exactly, at the stale boundary', () => {
  const now = Date.parse('2026-10-28T12:00:00.000Z');
  const row = (hb) => ({ id: 'r_1', owner_id: 'u_1', name: 'lab', kind: 'local', origin: 'lab', cpu: 'x', gpu: 'y', capabilities_json: '[]', configured: 1, authenticated: 1, online: 1, usable: 1, heartbeat_at: hb, limits_json: '{}', scope: 'owner only', verification_json: '{}', credits_json: null, created_at: new Date(now).toISOString() });
  const fresh = cardFor(row(new Date(now - STALE_AFTER_MS).toISOString()), 'Alice', now);
  assert.equal(fresh.state.online, true, 'age == STALE_AFTER_MS is still online (same `>` rule as resourceLiveness)');
  assert.equal(fresh.state.status, 'ready');
  const aged = cardFor(row(new Date(now - STALE_AFTER_MS - 1).toISOString()), 'Alice', now);
  assert.equal(aged.state.online, false);
  assert.equal(aged.state.usable, false);
  assert.equal(aged.state.status, 'offline');
  const noTelemetry = cardFor(row(null), 'Alice', now);
  assert.equal(noTelemetry.state.online, false, 'flag-online without telemetry is unknown, never online');
});

test('detail route and POST response follow the same rule', async () => {
  const t = await createTestEnv();
  const created = await register(t, t.alice, 'fresh-box');
  assert.equal(created.state.online, false, 'POST response for a never-seen resource is offline');
  const id = created.id;
  await t.DB.prepare('UPDATE resources SET online = 1, usable = 1, heartbeat_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - 10 * 60 * 1000).toISOString(), id).run();
  const detail = (await readJson(await t.call('/api/inventory/' + id, { headers: t.as(t.alice) }))).json;
  assert.equal(detail.state.online, false, 'stale detail renders offline');
  assert.equal(detail.state.usable, false);
});

test('shared-with-me carries no liveness display fields', async () => {
  // The review asked for the same rule on shared-with-me cards; the route
  // returns grant rows, not resource cards, so there is no online/usable
  // display state to go stale. This pins that shape: no liveness fields.
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'shared-box');
  const grant = await readJson(await t.call('/api/grants', {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf },
    body: { resourceId: r.id, grantee: 'bob@example.com', maxJobs: 5, maxTokens: 500 },
  }));
  assert.equal(grant.status, 201, grant.text);
  const shared = (await readJson(await t.call('/api/shared-with-me?limit=50', { headers: t.as(t.bob) }))).json;
  assert.equal(shared.total, 1);
  const text = JSON.stringify(shared.items);
  assert.ok(!/online|usable|liveness|heartbeat/i.test(text), 'no liveness display fields: ' + text);
});

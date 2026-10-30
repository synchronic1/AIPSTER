/* Built with Meta Muse. */
// Node capability reports (Phase 1): heartbeat-key auth mirroring the
// heartbeat intake, strict schema-v1 bodies, 25s cost guard, owner/grant
// read access. Reports are worker-declared evidence; evaluators treat
// missing/stale snapshots as unknown (AC07).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { fixtureSnapshot } from '../src/lib/catalog/fixtures.mjs';

const fx = () => createTestEnv({ CATALOG_FIXTURES: '1' });

async function register(t, user, name) {
  const res = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: { ...t.as(user), ...t.csrf }, body: { name, kind: 'local' },
  }));
  assert.equal(res.status, 201, res.text);
  return res.json;
}

async function mintHeartbeat(t, user, resourceId, extra = {}) {
  const res = await readJson(await t.call('/api/keys', {
    method: 'POST', headers: { ...t.as(user), ...t.csrf }, body: { name: 'hb', scope: 'heartbeat', resourceId, ...extra },
  }));
  assert.equal(res.status, 201, res.text);
  return res.json;
}

function validBody() {
  const s = fixtureSnapshot();
  return { schema_version: 1, os: s.os, arch: s.arch, runtimes: s.runtimes, mem: s.mem, disk: s.disk, workload: s.workload };
}

async function post(t, resourceId, secret, body) {
  return readJson(await t.call(`/api/resources/${resourceId}/capabilities`, {
    method: 'POST',
    headers: secret ? { Authorization: 'Bearer ' + secret } : {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

test('valid report stores a snapshot and refreshes liveness', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'box');
  const key = await mintHeartbeat(t, t.alice, node.id);
  const res = await post(t, node.id, key.secret, validBody());
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.nodeId, node.id);
  assert.equal(res.json.schemaVersion, 1);
  const row = await t.DB.prepare('SELECT * FROM node_capabilities WHERE node_id = ?').bind(node.id).first();
  assert.equal(row.os, 'linux');
  assert.deepEqual(JSON.parse(row.mem_json).gpu.length, 1);
  const r = await t.DB.prepare('SELECT online, heartbeat_at FROM resources WHERE id = ?').bind(node.id).first();
  assert.equal(r.online, 1, 'a capability report proves liveness like a heartbeat');
  assert.ok(r.heartbeat_at);
});

test('capability auth mirrors the heartbeat intake', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'box');
  const other = await register(t, t.alice, 'other');
  const key = await mintHeartbeat(t, t.alice, node.id);
  const body = validBody();
  const none = await post(t, node.id, null, body);
  assert.equal(none.status, 401);
  const session = await readJson(await t.call(`/api/resources/${node.id}/capabilities`, { method: 'POST', headers: t.as(t.alice), body }));
  assert.equal(session.status, 403);
  assert.equal(session.json.code, 'KEY_REQUIRED');
  const read = await readJson(await t.call('/api/keys', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'r', scope: 'read' } }));
  const wrongScope = await post(t, node.id, read.json.secret, body);
  assert.equal(wrongScope.status, 403);
  assert.equal(wrongScope.json.code, 'KEY_SCOPE');
  const wrongNode = await post(t, other.id, key.secret, body);
  assert.equal(wrongNode.status, 404, 'key bound to another resource');
  const ghost = await post(t, 'r_nope', key.secret, body);
  assert.equal(ghost.status, 404);
  await t.DB.prepare('UPDATE key_verifiers SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), key.id).run();
  const revoked = await post(t, node.id, key.secret, body);
  assert.equal(revoked.status, 401);
  assert.equal(revoked.json.code, 'KEY_REVOKED');
  const key2 = await mintHeartbeat(t, t.alice, node.id);
  await t.DB.prepare('UPDATE key_verifiers SET expires_at = ? WHERE id = ?').bind('2000-01-01T00:00:00Z', key2.id).run();
  const expired = await post(t, node.id, key2.secret, body);
  assert.equal(expired.status, 401);
  assert.equal(expired.json.code, 'KEY_EXPIRED');
});

test('strict body: unknown fields, bad shapes, and oversize fail closed', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'box');
  const key = await mintHeartbeat(t, t.alice, node.id);
  const bads = [
    [{ ...validBody(), injected: true }, 'unknown top-level field'],
    [{ ...validBody(), schema_version: 2 }, 'wrong schema version'],
    [{ ...validBody(), mem: null }, 'missing mem'],
    [{ ...validBody(), mem: { ramTotalBytes: 8, ramAvailBytes: 9 } }, 'avail exceeds total'],
    [{ ...validBody(), runtimes: 'llama' }, 'runtimes not an array'],
    [{ ...validBody(), disk: { totalBytes: 1, availBytes: 2 } }, 'disk avail exceeds total'],
    ['not-json{{{', 'unparseable body'],
  ];
  for (const [payload, why] of bads) {
    const res = await post(t, node.id, key.secret, payload);
    assert.ok([400, 413].includes(res.status), `${why}: ${res.status}`);
  }
  const big = await post(t, node.id, key.secret, { ...validBody(), os: 'x'.repeat(9000) });
  assert.ok([400, 413].includes(big.status), `oversize body: ${big.status}`);
  const stored = await t.DB.prepare('SELECT COUNT(*) n FROM node_capabilities').bind().first();
  assert.equal(stored.n, 0, 'no rejected report persists');
});

test('reports are rate-limited to one per 25s window', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'box');
  const key = await mintHeartbeat(t, t.alice, node.id);
  const first = await post(t, node.id, key.secret, validBody());
  assert.equal(first.status, 200, first.text);
  const second = await post(t, node.id, key.secret, validBody());
  assert.equal(second.status, 429);
  assert.equal(second.json.code, 'CAPABILITIES_TOO_SOON');
});

test('capability reads follow owner/grant access; missing rows are explicit', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'box');
  const key = await mintHeartbeat(t, t.alice, node.id);
  const get = async (user) => readJson(await t.call(`/api/resources/${node.id}/capabilities`, { headers: t.as(user) }));
  const anon = await readJson(await t.call(`/api/resources/${node.id}/capabilities`));
  assert.equal(anon.status, 401);
  const bobDenied = await get(t.bob);
  assert.equal(bobDenied.status, 404);
  const empty = await get(t.alice);
  assert.equal(empty.status, 200);
  assert.equal(empty.json.snapshot, null);
  assert.equal(empty.json.fresh, false);
  assert.equal(empty.json.ageMs, null);
  await post(t, node.id, key.secret, validBody());
  const full = await get(t.alice);
  assert.equal(full.status, 200);
  assert.equal(full.json.snapshot.os, 'linux');
  assert.equal(full.json.fresh, true);
  assert.ok(full.json.ageMs >= 0 && full.json.ageMs < 60000);
  const g = await readJson(await t.call('/api/grants', {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf },
    body: { resourceId: node.id, grantee: 'bob@example.com', maxJobs: 5, maxTokens: 1000 },
  }));
  assert.equal(g.status, 201, g.text);
  const bobOk = await get(t.bob);
  assert.equal(bobOk.status, 200, 'live grant permits reads');
});

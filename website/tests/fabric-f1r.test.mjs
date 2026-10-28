/* Built with Meta Muse. F1R owner regressions for the R1-R10 repair pass.
 * The verbatim independent probes live in qa-independent.test.mjs and
 * qa-ui.test.mjs; these pin the repair-side behaviors those probes imply
 * but do not assert directly (migration column, replay redaction shape,
 * processing-lease steal, consent denial code). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fabricEnv, connectPair, commitFlow, S, freshKey, readJson } from './qa-helpers.mjs';
import { digestJson } from '../src/fabric/canonical.mjs';

test('F1R: migration 0006 records the suspending side for consent', async () => {
  const t = await fabricEnv();
  const cols = t.sqlite.prepare('SELECT * FROM pragma_table_info(?)').all('connections').map((c) => c.name);
  assert.ok(cols.includes('suspended_by'));
  const { conn, nodeA } = await connectPair(t);
  const susp = await readJson(await t.call(`/v1/fabric/connections/${conn.id}/suspend`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 1 } }));
  assert.equal(susp.status, 200);
  const row = t.sqlite.prepare('SELECT suspended_by FROM connections WHERE id = ?').get(conn.id);
  assert.equal(row.suspended_by, nodeA.id);
  const resumed = await readJson(await t.call(`/v1/fabric/connections/${conn.id}/resume`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 2, nodeKey: nodeA.nodeSecret } }));
  assert.equal(resumed.status, 200);
  const row2 = t.sqlite.prepare('SELECT suspended_by FROM connections WHERE id = ?').get(conn.id);
  assert.equal(row2.suspended_by, null);
});

test('F1R3: a side with no veto cannot withdraw, by code', async () => {
  const t = await fabricEnv();
  const { conn, nodeB } = await connectPair(t);
  await readJson(await t.call(`/v1/fabric/connections/${conn.id}/suspend`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 1 } }));
  const peer = await readJson(await t.call(`/v1/fabric/connections/${conn.id}/resume`, { method: 'POST', headers: S(t, t.bob, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 2, nodeKey: nodeB.nodeSecret } }));
  assert.equal(peer.status, 409);
  assert.equal(peer.json.code, 'NO_OWN_VETO');
});

test('F1R: replay of secret issuance returns metadata without the secret', async () => {
  const t = await fabricEnv();
  const key = freshKey();
  const first = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': key }), body: { label: 'r' } }));
  assert.equal(first.status, 201);
  assert.ok(first.json.nodeSecret);
  const replay = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': key }), body: { label: 'r' } }));
  assert.equal(replay.status, 201);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.id, first.json.id);
  assert.ok(!('nodeSecret' in replay.json));
  assert.ok(replay.json.replayNote);
  const stored = t.sqlite.prepare('SELECT response_body FROM idempotency_records WHERE idem_key = ?').get(key);
  assert.ok(!stored.response_body.includes(first.json.nodeSecret));
});

test('F1R: crashed processing lease can be stolen after expiry', async () => {
  const t = await fabricEnv();
  const key = freshKey();
  const body = { label: 'leased' };
  const hash = await digestJson(body);
  const old = new Date(Date.now() - 20 * 60e3).toISOString();
  t.sqlite.prepare('INSERT INTO idempotency_records (idem_key, actor, method, path, request_hash, status, response_code, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)')
    .run(key, 'session:u_alice', 'POST', '/v1/fabric/nodes', hash, 'processing', old);
  const r = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': key }), body }));
  assert.equal(r.status, 201);
});

test('F1R2: migration 0007 adds veto, exporter and approval-recency columns', async () => {
  const t = await fabricEnv();
  const cols = (tbl) => t.sqlite.prepare('SELECT * FROM pragma_table_info(?)').all(tbl).map((c) => c.name);
  assert.ok(cols('connections').includes('vetoed_by'));
  assert.ok(cols('fabric_grants').includes('exporter_id'));
  assert.ok(cols('fabric_grants').includes('last_approval_id'));
});

test('F1R3: commit records exporter and approval; each side withdraws only its own veto', async () => {
  const t = await fabricEnv();
  const { conn, nodeA, nodeB } = await connectPair(t);
  const { grant, appr } = await commitFlow(t, conn.id);
  const row = t.sqlite.prepare('SELECT exporter_id, last_approval_id FROM fabric_grants WHERE id = ?').get(grant.id);
  assert.equal(row.exporter_id, 'u_alice');
  assert.equal(row.last_approval_id, appr.id);
  await readJson(await t.call(`/v1/fabric/connections/${conn.id}/suspend`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 1 } }));
  await readJson(await t.call(`/v1/fabric/connections/${conn.id}/disconnect`, { method: 'POST', headers: S(t, t.bob, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 2 } }));
  const veto = JSON.parse(t.sqlite.prepare('SELECT vetoed_by AS v FROM connections WHERE id = ?').get(conn.id).v);
  assert.deepEqual([...veto].sort(), [nodeA.id, nodeB.id].sort());
  const rows = t.sqlite.prepare('SELECT side_node AS s FROM connection_vetoes WHERE connection_id = ?').all(conn.id).map((r) => r.s);
  assert.deepEqual([...rows].sort(), [nodeA.id, nodeB.id].sort());
  // Bob withdraws his own side only; Alice's veto survives with its proof.
  const partial = await readJson(await t.call(`/v1/fabric/connections/${conn.id}/resume`, { method: 'POST', headers: S(t, t.bob, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 3, nodeKeys: [nodeB.nodeSecret] } }));
  assert.equal(partial.status, 200);
  assert.deepEqual(partial.json.remainingVetoes, [nodeA.id]);
  assert.notEqual(partial.json.state, 'active');
  // A peer secret in Bob's hands withdraws nothing once his own veto is gone.
  const foreign = await readJson(await t.call(`/v1/fabric/connections/${conn.id}/resume`, { method: 'POST', headers: S(t, t.bob, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 4, nodeKeys: [nodeB.nodeSecret, nodeA.nodeSecret] } }));
  assert.equal(foreign.status, 409);
  assert.equal(foreign.json.code, 'NO_OWN_VETO');
  // Alice withdraws her own side; the connection reactivates.
  const full = await readJson(await t.call(`/v1/fabric/connections/${conn.id}/resume`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 4, nodeKey: nodeA.nodeSecret } }));
  assert.equal(full.status, 200);
  assert.equal(full.json.state, 'active');
  assert.deepEqual(full.json.remainingVetoes, []);
});

test('F1R2: same-key retry after a lost response reconciles instead of duplicating', async () => {
  const t = await fabricEnv();
  const key = freshKey();
  const body = { label: 'lost-response' };
  const first = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': key }), body }));
  assert.equal(first.status, 201);
  // Simulate a 5xx that released the record after the write committed.
  t.sqlite.prepare('DELETE FROM idempotency_records WHERE idem_key = ?').run(key);
  const retry = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': key }), body }));
  assert.equal(retry.status, 200);
  assert.equal(retry.json.reconciled, true);
  assert.equal(retry.json.id, first.json.id);
  assert.ok(!('nodeSecret' in retry.json));
  assert.equal(t.sqlite.prepare('SELECT count(*) AS n FROM fabric_nodes').get().n, 1);
});

test('F1R2: migration purge statement strips persisted secrets in place', async () => {
  const t = await fabricEnv();
  t.sqlite.prepare("INSERT INTO idempotency_records (idem_key, actor, method, path, request_hash, status, response_code, response_body, created_at) VALUES ('legacy-k', 'session:u_alice', 'POST', '/v1/fabric/nodes', 'h', 'completed', 201, ?, '2000-01-01')")
    .run(JSON.stringify({ id: 'n', nodeSecret: 'SYNTHETIC' }));
  // Same statement as migrations/0007_repair2.sql (already applied at setup).
  t.sqlite.exec("UPDATE idempotency_records SET response_body = json_set(json_remove(response_body, '$.nodeSecret', '$.token', '$.secret'), '$.replayNote', 'Secret fields are shown once and are not stored for replay.') WHERE status = 'completed' AND (json_extract(response_body, '$.nodeSecret') IS NOT NULL OR json_extract(response_body, '$.token') IS NOT NULL OR json_extract(response_body, '$.secret') IS NOT NULL)");
  const row = t.sqlite.prepare('SELECT response_body AS b FROM idempotency_records WHERE idem_key = ?').get('legacy-k');
  assert.ok(!row.b.includes('SYNTHETIC'));
  assert.ok(JSON.parse(row.b).replayNote);
});

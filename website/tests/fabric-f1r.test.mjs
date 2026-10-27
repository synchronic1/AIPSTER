/* Built with Meta Muse. F1R owner regressions for the R1-R10 repair pass.
 * The verbatim independent probes live in qa-independent.test.mjs and
 * qa-ui.test.mjs; these pin the repair-side behaviors those probes imply
 * but do not assert directly (migration column, replay redaction shape,
 * processing-lease steal, consent denial code). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fabricEnv, connectPair, S, freshKey, readJson } from './qa-helpers.mjs';
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

test('F1R: only the suspending side may resume, by code', async () => {
  const t = await fabricEnv();
  const { conn, nodeB } = await connectPair(t);
  await readJson(await t.call(`/v1/fabric/connections/${conn.id}/suspend`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 1 } }));
  const peer = await readJson(await t.call(`/v1/fabric/connections/${conn.id}/resume`, { method: 'POST', headers: S(t, t.bob, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 2, nodeKey: nodeB.nodeSecret } }));
  assert.equal(peer.status, 403);
  assert.equal(peer.json.code, 'FORBIDDEN');
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fabricEnv, connectPair, commitFlow, S, freshKey, readJson } from './qa-helpers.mjs';
import { faultOnce, assertComplete } from './revision-fixtures.mjs';
import * as core from '../src/fabric/store.mjs';
const post = (t, path, body, key = freshKey()) => t.call('/v1/fabric/' + path,
  { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': key }), body }).then(readJson);

for (const [boundary, pattern] of [
  ['ledger claim', /INSERT INTO idempotency_records/],
  ['ledger finalize', /UPDATE idempotency_records SET status = \?, response_code/],
]) for (const phase of ['before', 'after']) test(`HTTP revision ${phase} ${boundary} failure/lost response`, async context => {
  const t = await fabricEnv(); context.after(() => t.sqlite.close());
  const { conn } = await connectPair(t), { grant } = await commitFlow(t, conn.id);
  const before = t.sqlite.prepare('SELECT * FROM fabric_grants WHERE id = ?').get(grant.id);
  const p = await post(t, 'previews', { connectionId: conn.id, resourceIds: ['r_gpu1'], consumers: ['bob-op'], models: ['llama'], maxTokens: 50, maxRequests: 10 });
  const a = await post(t, 'approvals', { action: 'grant.revise', targetId: grant.id, previewId: p.json.id });
  assert.equal((await post(t, `approvals/${a.json.id}/decide`, { decision: 'approve' })).status, 200);
  const input = { approvalId: a.json.id, previewHash: p.json.digest }, key = freshKey(), path = `grants/${grant.id}/revise`;
  t.env.DB = faultOnce(t.DB, pattern, phase);
  const interrupted = await post(t, path, input, key);
  assert.ok([409, 500].includes(interrupted.status), interrupted.text);
  t.env.DB = t.DB;
  // Lease expiry only affects processing records, never a completed result.
  t.sqlite.prepare("UPDATE idempotency_records SET created_at = '2000-01-01T00:00:00.000Z' WHERE idem_key = ? AND status = 'processing'").run(key);
  const completed = await post(t, path, input, key);
  assert.equal(completed.status, 200); assert.equal(completed.json.version, 2);
  const state = () => ({ grant: t.sqlite.prepare('SELECT * FROM fabric_grants WHERE id = ?').get(grant.id),
    history: t.sqlite.prepare('SELECT * FROM fabric_grant_revisions').all(),
    receipts: t.sqlite.prepare('SELECT * FROM fabric_revision_receipts').all(),
    audits: t.sqlite.prepare("SELECT * FROM audit WHERE action = 'fabric.grant.revise'").all() });
  const saved = state(); assertComplete(saved, before, input);
  for (let i = 0; i < 3; i++) {
    const replay = await post(t, path, input, key);
    assert.equal(replay.status, 200); assert.equal(replay.json.version, 2); assert.equal(replay.json.replayed, true);
  }
  assert.deepEqual(state(), saved);
  assert.equal((await post(t, path, { ...input, previewHash: 'changed' }, key)).status, 409);
  assert.deepEqual(state(), saved);
});

test('HTTP lost finalization of zero-row revision CAS replays original 412', async context => {
  const t = await fabricEnv(); context.after(() => t.sqlite.close());
  const { conn } = await connectPair(t), { grant } = await commitFlow(t, conn.id);
  const p = await post(t, 'previews', { connectionId: conn.id, resourceIds: ['r_gpu1'], consumers: ['bob-op'], models: ['llama'], maxTokens: 50, maxRequests: 10 });
  const a = await post(t, 'approvals', { action: 'grant.revise', targetId: grant.id, previewId: p.json.id });
  await post(t, `approvals/${a.json.id}/decide`, { decision: 'approve' });
  const body = { approvalId: a.json.id, previewHash: p.json.digest }, key = freshKey(), path = `grants/${grant.id}/revise`;
  const racing = faultOnce(t.DB, /UPDATE fabric_grants SET consumers/, 'before', true, async () => {
    await core.pauseGrant(t.DB, { kind: 'session', user: { id: t.alice.id } }, grant.id, { expectedVersion: 1 });
  });
  t.env.DB = faultOnce(racing, /UPDATE idempotency_records SET status = \?, response_code/, 'before');
  assert.equal((await post(t, path, body, key)).status, 500);
  t.env.DB = t.DB;
  t.sqlite.prepare("UPDATE idempotency_records SET created_at = '2000-01-01T00:00:00.000Z' WHERE idem_key = ?").run(key);
  const fence = t.sqlite.prepare('SELECT * FROM fabric_revision_failures').get();
  assert.equal(fence.response_code, 412);
  for (let i = 0; i < 3; i++) {
    const replay = await post(t, path, body, key);
    assert.equal(replay.status, 412); assert.deepEqual(replay.json, { ...JSON.parse(fence.response_body), ...(i ? { replayed: true } : {}) });
  }
  assert.equal(t.sqlite.prepare('SELECT status FROM idempotency_records WHERE idem_key = ?').get(key).status, 'completed');
  assert.equal(t.sqlite.prepare('SELECT count(*) n FROM fabric_grant_revisions').get().n, 0);
  assert.equal(t.sqlite.prepare('SELECT count(*) n FROM fabric_revision_receipts').get().n, 0);
  assert.equal(t.sqlite.prepare('SELECT status FROM fabric_grants WHERE id = ?').get(grant.id).status, 'paused');
});

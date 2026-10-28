/* Built with Meta Muse. F1R3 migration tests: 0008 upgrade behavior
 * over populated pre-0008 fixtures (intact, drifted, broken, legacy). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fabricEnv, connectPair, commitFlow, S, freshKey, readJson } from './qa-helpers.mjs';

const post = (t, u, p, b = {}, key = freshKey()) => t.call('/v1/fabric/' + p, { method: 'POST', headers: S(t, u, { 'Idempotency-Key': key }), body: b }).then(readJson);
const MIGRATE_DOWN = 'ALTER TABLE connections DROP COLUMN grant_gen; ALTER TABLE approvals DROP COLUMN decided_at; ALTER TABLE approvals DROP COLUMN issued_connection; ALTER TABLE approvals DROP COLUMN issued_version; ALTER TABLE approvals DROP COLUMN issued_grant_gen; ALTER TABLE approvals DROP COLUMN bound_grant_id; ALTER TABLE approvals DROP COLUMN bound_grant_version; ALTER TABLE approvals DROP COLUMN consumed_by_op; ALTER TABLE approvals DROP COLUMN consumed_action; ALTER TABLE approvals DROP COLUMN consumed_target; ALTER TABLE idempotency_records DROP COLUMN attempt; ALTER TABLE fabric_grants DROP COLUMN quarantine_reason; DROP TABLE connection_vetoes;';
async function apply0008(t) {
  t.sqlite.exec(await readFile(new URL('../migrations/0008_state_layer.sql', import.meta.url), 'utf8'));
}

test('F1R3 MIGRATE: fresh install carries all 0008 tables and columns', async () => {
  const t = await fabricEnv();
  const cols = (tbl) => t.sqlite.prepare('SELECT * FROM pragma_table_info(?)').all(tbl).map((c) => c.name);
  assert.ok(cols('connection_vetoes').includes('side_node'));
  assert.ok(cols('connections').includes('grant_gen'));
  for (const c of ['decided_at', 'issued_connection', 'issued_version', 'issued_grant_gen', 'bound_grant_id', 'bound_grant_version', 'consumed_by_op', 'consumed_action', 'consumed_target']) {
    assert.ok(cols('approvals').includes(c), `approvals.${c}`);
  }
  assert.ok(cols('idempotency_records').includes('attempt'));
  assert.ok(cols('fabric_grants').includes('quarantine_reason'));
});

test('F1R3 MIGRATE: intact fixture backfills vetoes, keeps exporter, no quarantine', async () => {
  const t = await fabricEnv();
  const { conn } = await connectPair(t);
  const { grant } = await commitFlow(t, conn.id);
  await post(t, t.alice, `connections/${conn.id}/suspend`, { expectedVersion: 1 });
  t.sqlite.exec(MIGRATE_DOWN);
  await apply0008(t);
  const vetoes = t.sqlite.prepare('SELECT side_node s FROM connection_vetoes WHERE connection_id = ?').all(conn.id).map((r) => r.s);
  assert.equal(vetoes.length, 1);
  const g = t.sqlite.prepare('SELECT exporter_id, quarantine_reason FROM fabric_grants WHERE id = ?').get(grant.id);
  assert.equal(g.exporter_id, 'u_alice');
  assert.equal(g.quarantine_reason, null);
});

test('F1R3 MIGRATE: drifted owner quarantines the grant but preserves evidence issuer', async () => {
  const t = await fabricEnv();
  const { conn, nodeB } = await connectPair(t);
  const { grant } = await commitFlow(t, conn.id);
  const now = new Date().toISOString();
  t.sqlite.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').run('u_third', 'Third', 'third@example.com', 1, now, now);
  t.sqlite.exec("UPDATE resources SET owner_id = 'u_third' WHERE id = 'r_gpu1'");
  t.sqlite.exec(MIGRATE_DOWN);
  await apply0008(t);
  const g = t.sqlite.prepare('SELECT exporter_id, quarantine_reason FROM fabric_grants WHERE id = ?').get(grant.id);
  assert.equal(g.exporter_id, 'u_alice');
  assert.equal(g.quarantine_reason, 'issuer-ambiguous');
  const auth = await post(t, t.bob, 'authorization/preview', { nodeId: nodeB.id, resourceId: 'r_gpu1', incarnation: 'gen1', consumer: 'bob-op', model: 'llama', maxTokens: 1 });
  assert.equal(auth.json.decision, 'deny');
  assert.equal((await post(t, t.alice, `grants/${grant.id}/revoke`, { expectedVersion: 1 })).status, 409);
});

test('F1R3 MIGRATE: broken approval chain quarantines as unprovable', async () => {
  const t = await fabricEnv();
  const { conn } = await connectPair(t);
  const { grant } = await commitFlow(t, conn.id);
  // Simulate legacy inconsistency (foreign keys did not always bind this):
  // the recorded creation approval is gone.
  t.sqlite.exec('PRAGMA foreign_keys = OFF');
  t.sqlite.prepare('UPDATE fabric_grants SET approval_id = ? WHERE id = ?').run('appr_missing', grant.id);
  t.sqlite.exec('PRAGMA foreign_keys = ON');
  t.sqlite.exec(MIGRATE_DOWN);
  await apply0008(t);
  const g = t.sqlite.prepare('SELECT exporter_id, quarantine_reason FROM fabric_grants WHERE id = ?').get(grant.id);
  assert.equal(g.exporter_id, null);
  assert.equal(g.quarantine_reason, 'issuer-unprovable');
});

test('F1R3 MIGRATE: nested-secret replay rows quarantine and never replay', async () => {
  const t = await fabricEnv();
  const key = freshKey();
  const r = await post(t, t.alice, 'nodes', { label: 'nested' }, key);
  assert.equal(r.status, 201);
  // Simulate a legacy nested-secret row (write path would never store this now).
  t.sqlite.prepare('UPDATE idempotency_records SET response_body = ? WHERE idem_key = ?')
    .run(JSON.stringify({ id: 'n', nested: { token: 'SYNTHETIC-SECRET' } }), key);
  t.sqlite.exec(MIGRATE_DOWN);
  await apply0008(t);
  assert.equal(t.sqlite.prepare('SELECT status FROM idempotency_records WHERE idem_key = ?').get(key).status, 'quarantined');
  const replay = await post(t, t.alice, 'nodes', { label: 'nested' }, key);
  assert.equal(replay.status, 409);
  assert.equal(replay.json.code, 'IDEMPOTENCY_QUARANTINED');
});

test('F1R3 MIGRATE: veto-less restrictive conns get both sides; versions and in-flight rows survive', async () => {
  const t = await fabricEnv();
  const { conn, nodeA, nodeB } = await connectPair(t);
  const { grant } = await commitFlow(t, conn.id);
  const key = freshKey();
  await post(t, t.alice, 'nodes', { label: 'x' }, key);
  t.sqlite.prepare("UPDATE idempotency_records SET status = 'processing' WHERE idem_key = ?").run(key);
  t.sqlite.exec(MIGRATE_DOWN);
  // Strip the mirror so the row looks like a legacy restrictive row with no vetoer.
  // (version columns are NOT NULL by schema, so NULL-version legacy rows cannot
  // exist; the 0008 backfill is defense-in-depth and versions pass through.)
  t.sqlite.prepare("UPDATE connections SET state = 'suspended', suspended_by = ?, vetoed_by = NULL WHERE id = ?").run(nodeA.id, conn.id);
  await apply0008(t);
  assert.equal(t.sqlite.prepare('SELECT version FROM connections WHERE id = ?').get(conn.id).version, 1);
  assert.equal(t.sqlite.prepare('SELECT version FROM fabric_grants WHERE id = ?').get(grant.id).version, 1);
  const vetoes = t.sqlite.prepare('SELECT side_node s FROM connection_vetoes WHERE connection_id = ?').all(conn.id).map((x) => x.s).sort();
  assert.deepEqual(vetoes, [nodeA.id, nodeB.id].sort());
  // A both-sides legacy veto survives migration: Alice holds a real veto
  // but cannot prove it with a wrong proof.
  const w = await post(t, t.alice, `connections/${conn.id}/resume`, { expectedVersion: 1, nodeKey: 'anything' });
  assert.equal(w.status, 403);
  const inflight = t.sqlite.prepare('SELECT status, attempt FROM idempotency_records WHERE idem_key = ?').get(key);
  assert.equal(inflight.status, 'processing');
  assert.equal(inflight.attempt, null);
});

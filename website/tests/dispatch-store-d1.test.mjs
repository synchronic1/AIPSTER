// Real, outbound-blocked local D1 (miniflare) subset for the dispatch store.
// The node:sqlite shim in dispatch-store.test.mjs runs batches inside explicit
// SAVEPOINTs; this file proves the same guarded-batch SQL behaves on the real
// D1 engine: a zero-row conditional CAS must commit nothing, changes() must
// gate the later statements, and accounting must stay inside the ceiling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { MIGRATION_FILES } from './d1-shim.mjs';
import { createD1DispatchStore } from '../src/inference/dispatch-store.mjs';
import {
  T0, RES_1, alice, bob, createClock, bindingFor, envelopeFor, nextOpKey,
  admittedOperation, dispatchedOperation, workerResult,
} from './fixtures/dispatch-store-fixture.mjs';

async function applyFile(db, file) {
  const sql = (await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'))
    .split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  for (const stmt of sql.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
    await db.exec(stmt);
  }
}

async function realD1Fixture(c, { ownerDaily = '10000' } = {}) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: 'export default {fetch(){return new Response("synthetic")}}',
    compatibilityDate: '2026-10-01', d1Databases: { DB: 'dispatch-store' },
    outboundService: () => { throw new Error('Unexpected outbound request'); },
  }));
  c.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of MIGRATION_FILES) await applyFile(db, file);

  const at = new Date(T0).toISOString();
  const created = new Date(T0 - 60 * 60 * 1000).toISOString();
  for (const [id, name, email] of [['user-alice', 'Alice', 'alice@example.com'],
    ['user-bob', 'Bob', 'bob@example.com']]) {
    await db.prepare(`INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt, demo)
      VALUES (?, ?, ?, 1, NULL, ?, ?, 0)`).bind(id, name, email, created, created).run();
  }
  for (const [id, nodeId, incarnation] of [['res-1', 'node-cpu-1', 'inc-1'], ['res-2', 'node-cpu-2', 'inc-2']]) {
    await db.prepare(`INSERT INTO resources
      (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated,
       online, usable, heartbeat_at, limits_json, scope, verification_json, created_at, node_id, incarnation)
      VALUES (?, 'user-alice', ?, 'local', 'synthetic', 'x86', 'none', '[]', 1, 1, 1, 1, ?, '{}',
        'owner only', '{}', ?, ?, ?)`).bind(id, id, at, created, nodeId, incarnation).run();
  }
  await db.prepare(`INSERT INTO grants
    (id, resource_id, owner_id, grantee_id, max_jobs, max_tokens, used_jobs, used_tokens, inference_only, created_at)
    VALUES ('grant-1', 'res-1', 'user-alice', 'user-bob', 10, 1000, 0, 0, 1, ?)`).bind(created).run();

  const clock = createClock(T0);
  const store = createD1DispatchStore(db, {
    now: clock.now, env: { INFERENCE_OWNER_DAILY_TOKENS: ownerDaily },
  });
  return { db, clock, store, harness: { store } };
}

const grantUsed = (db) => db.prepare('SELECT used_tokens, used_jobs FROM grants WHERE id = ?').bind('grant-1').first();

test('real D1: full admitted-dispatch lifecycle charges once and settles once', async (c) => {
  const { db, store } = await realD1Fixture(c);
  const flow = await dispatchedOperation({ store }, { principal: bob, grant: 'grant-1' });

  assert.deepEqual(await grantUsed(db), { used_tokens: 128, used_jobs: 1 });
  const jobs = await db.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').first();
  assert.equal(jobs.n, 1);

  const frame = await store.leaseNextJob({ resource_id: RES_1 });
  assert.equal(frame.job_id, flow.job_id);
  assert.deepEqual(frame.envelope, flow.envelope);
  assert.equal(await store.leaseNextJob({ resource_id: RES_1 }), null);

  assert.deepEqual(await store.completeJob({
    job_id: frame.job_id, lease_id: frame.lease_id, resource_id: RES_1,
    status: 'succeeded', result: workerResult(frame),
  }), { accepted: true });

  assert.deepEqual(await store.settle({
    op_id: flow.op.op_id, generation: 1, job_id: frame.job_id, outcome: 'succeeded', result_digest: 'sha256:d1',
  }), { settled: true });
  assert.deepEqual(await store.settle({
    op_id: flow.op.op_id, generation: 1, job_id: frame.job_id, outcome: 'succeeded', result_digest: 'sha256:d1',
  }), { settled: false, reason: 'already_settled' });

  assert.deepEqual(await grantUsed(db), { used_tokens: 128, used_jobs: 1 });
  const settlements = await db.prepare('SELECT COUNT(*) AS n FROM dispatch_settlements').first();
  assert.equal(settlements.n, 1);
  const holds = await db.prepare('SELECT state FROM dispatch_holds WHERE op_id = ?').bind(flow.op.op_id).all();
  assert.deepEqual(holds.results.map((r) => r.state), ['charged']);
});

test('real D1: a zero-row admission CAS commits no hold state and leaves counters untouched', async (c) => {
  const { db, store } = await realD1Fixture(c);
  const admission = await store.issueAdmission({
    principal: bob, resource_id: RES_1, model_id: 'model-x', max_tokens: 128, grant: 'grant-1',
  });
  const rec = await store.resolveAdmission({ principal: bob, admission_ref: admission.admission_ref });
  const binding = bindingFor(rec, { principal: bob });
  const claim = await store.claimOperation({
    op_key: nextOpKey('d1-revoke'), request_digest: 'sha256:revoke', principal_id: bob.principal_id,
    tenant_id: bob.tenant_id, binding,
  });
  const hold = await store.acquireHold({
    op_id: claim.op.op_id, generation: 1, pool_id: binding.pools[0].pool_id, amount: 128,
  });
  assert.equal(hold.held, true);
  assert.deepEqual(await grantUsed(db), { used_tokens: 128, used_jobs: 1 });

  await db.prepare('UPDATE grants SET revoked_at = ? WHERE id = ?').bind(new Date(T0 + 1000).toISOString(), 'grant-1').run();
  const rejected = await store.admit({
    op_id: claim.op.op_id, generation: 1, holds: [hold.hold_id],
    authority: { grant_id: binding.grant_id, grant_revision: binding.grant_revision, incarnation: binding.incarnation },
  });
  assert.deepEqual(rejected, { outcome: 'rejected', reason: 'revoked' });

  const op = await store.getOperation({ op_key: claim.op.op_key });
  assert.equal(op.phase, 'holding', 'the CAS did not advance the phase');
  const states = await db.prepare('SELECT state FROM dispatch_holds WHERE op_id = ?').bind(claim.op.op_id).all();
  assert.deepEqual(states.results.map((r) => r.state), ['held'], 'the guarded commit statement did not run');
  assert.deepEqual(await grantUsed(db), { used_tokens: 128, used_jobs: 1 });

  assert.deepEqual(await store.releaseHolds({ op_id: claim.op.op_id, generation: 1 }), { released: 1 });
  assert.deepEqual(await grantUsed(db), { used_tokens: 0, used_jobs: 0 });
});

test('real D1: concurrent holds cannot exceed the grant ceiling or drive it negative', async (c) => {
  const { db, store } = await realD1Fixture(c);
  await db.prepare('UPDATE grants SET max_jobs = 5, max_tokens = 200 WHERE id = ?').bind('grant-1').run();

  const flows = await Promise.all(Array.from({ length: 3 }, (_, i) => admittedOperation({ store }, {
    principal: bob, grant: 'grant-1', max_tokens: 128, op_key: `d1-race-${i}`,
  })));
  const admitted = flows.filter((f) => f.admitted && f.admitted.outcome === 'admitted');
  assert.equal(admitted.length, 1);
  assert.deepEqual(await grantUsed(db), { used_tokens: 128, used_jobs: 1 });

  const winner = admitted[0];
  await store.fenceStart({ op_id: winner.op.op_id, generation: 1 });
  assert.deepEqual(await store.releaseHolds({ op_id: winner.op.op_id, generation: 1 }), { released: 1 });
  assert.deepEqual(await grantUsed(db), { used_tokens: 0, used_jobs: 0 });
});

test('real D1: owner daily pool fails closed without a valid ceiling', async (c) => {
  const { db, store } = await realD1Fixture(c, { ownerDaily: 'not-a-number' });
  const flow = await admittedOperation({ store }, { principal: alice, max_tokens: 128 });
  assert.equal(flow.admitted.held, false);
  const pools = await db.prepare('SELECT * FROM dispatch_pool_usage').all();
  for (const row of pools.results) assert.equal(row.used_tokens, 0);
  const jobs = await db.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').first();
  assert.equal(jobs.n, 0);
});

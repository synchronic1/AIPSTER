// PR63 security finding 4437419399 (P2, Codex security review): the
// per-principal operation cap counted only non-terminal phases. A tenant whose
// owner/grant budget is exhausted gets a claimed operation, a refused hold and
// an immediate `released` row; that row stopped counting, so unique keys could
// be submitted forever and every one of them stayed in `dispatch_operations`.
// A real-store repro with a cap of 2 produced 25 retained released rows.
//
// The store now counts every retained operation against the same cap and
// prunes, inside the claim batch itself, only state that cannot be replayed:
//   * `released` rows never executed (releaseHolds requires that no start was
//     redeemed and that any admitted operation is fenced), so they carry no
//     result and are evictable as soon as the principal is at the cap;
//   * `settled` rows are the durable replay/receipt record, so they are kept
//     for INFERENCE_DISPATCH_RETENTION_MS (default 7 days) and pruned after it;
//   * an operation with `uncertain_phase`, a held/committed hold, or a
//     queued/leased job is never pruned, at any age.
// Pruning is per principal and runs in the same D1 batch as the guarded insert,
// so a replayed key that is still retained reconciles unchanged and another
// principal's rows are untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RES_1, alice, bob, createStoreHarness, bindingFor, admittedOperation,
  dispatchedOperation, workerResult,
} from './fixtures/dispatch-store-fixture.mjs';
import { createD1DispatchStore } from '../src/inference/dispatch-store.mjs';
import * as storeModule from '../src/inference/dispatch-store.mjs';

// The retention constant is part of the fix; keep the repro runnable before it
// exists so the first failure is the unbounded-row assertion, not a module load.
const RETENTION_MS = storeModule.DEFAULT_DISPATCH_RETENTION_MS ?? 7 * 24 * 60 * 60 * 1000;

const retained = (sqlite, principal = alice.principal_id) => sqlite.prepare(
  'SELECT COUNT(*) AS n FROM dispatch_operations WHERE principal_id = ?').get(principal).n;

// Every durable table a pruned operation can leave rows in. The cap has to
// bound all of them, not just dispatch_operations: the follow-up finding is a
// hold row that outlived its operation because only the operation was pruned.
const DURABLE = ['dispatch_operations', 'dispatch_holds', 'dispatch_settlements',
  'dispatch_jobs', 'dispatch_start_redemptions', 'dispatch_fences'];
const durableCounts = (sqlite) => Object.fromEntries(DURABLE.map(
  (table) => [table, sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));

const phases = (sqlite, principal = alice.principal_id) => Object.fromEntries(sqlite.prepare(
  'SELECT phase, COUNT(*) AS n FROM dispatch_operations WHERE principal_id = ? GROUP BY phase')
  .all(principal).map((r) => [r.phase, r.n]));

function claim(h, binding, key, principal = alice) {
  return h.store.claimOperation({
    op_key: key, request_digest: `sha256:${key}`, principal_id: principal.principal_id,
    tenant_id: principal.tenant_id, binding,
  });
}

async function admissionBinding(h, { principal = alice, max_tokens = 64 } = {}) {
  const a = await h.store.issueAdmission({ principal, resource_id: RES_1, model_id: 'model-x', max_tokens });
  const rec = await h.store.resolveAdmission({ principal, admission_ref: a.admission_ref });
  return bindingFor(rec, { principal });
}

// Claim -> refused hold -> release is exactly what an exhausted principal does.
// releaseHolds reports the holds it released (zero here); the operation itself
// still flips to `released` when it holds no budget, which is the retained row
// this finding is about.
async function exhaustedSubmission(h, binding, key) {
  const c = await claim(h, binding, key);
  if (!c.claimed) return { claimed: false };
  const hold = await h.store.acquireHold({
    op_id: c.op.op_id, generation: 1, pool_id: binding.pools[0].pool_id, amount: binding.pools[0].amount,
  });
  assert.equal(hold.held, false, 'the exhausted pool must refuse the hold');
  await h.store.releaseHolds({ op_id: c.op.op_id, generation: 1, reason: 'budget_exhausted' });
  const after = await h.store.getOperation({ op_key: key });
  assert.equal(after.phase, 'released');
  return { claimed: true, op: c.op };
}

async function settledOperation(h, key) {
  const flow = await dispatchedOperation(h, { op_key: key, principal: alice });
  const frame = await h.store.leaseNextJob({ resource_id: RES_1 });
  await h.store.completeJob({
    job_id: frame.job_id, lease_id: frame.lease_id, resource_id: RES_1, status: 'succeeded',
    result: workerResult(frame),
  });
  const settled = await h.store.settle({
    op_id: flow.op.op_id, generation: 1, job_id: frame.job_id, outcome: 'succeeded',
    result_digest: 'sha256:settled',
  });
  assert.equal(settled.settled, true);
  return flow;
}

test('retention: exhausted-budget submissions cannot retain unbounded released rows', async () => {
  const h = createStoreHarness({
    ownerDaily: '0',
    env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '2', INFERENCE_DISPATCH_MAX_ADMISSIONS: '64' },
  });
  const binding = await admissionBinding(h);
  let released = 0;
  for (let i = 0; i < 25; i += 1) {
    const r = await exhaustedSubmission(h, binding, `exhaust-key-${i}`);
    if (r.claimed) released += 1;
  }

  assert.equal(released, 25, 'every submission reaches claim/hold/release');
  assert.ok(
    retained(h.sqlite) <= 2,
    `retained ${retained(h.sqlite)} operations for one principal exceeds the cap of 2`,
  );
  // Nothing is retained that could still be executed or settled.
  assert.deepEqual(phases(h.sqlite), { released: retained(h.sqlite) });
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_holds').get().n, 0);

  // The cap is per principal: another tenant's rows are not touched by eviction.
  const bobAdmission = await h.store.issueAdmission({
    principal: bob, resource_id: RES_1, model_id: 'model-x', max_tokens: 64, grant: 'grant-1',
  });
  const bobBinding = bindingFor(
    await h.store.resolveAdmission({ principal: bob, admission_ref: bobAdmission.admission_ref }),
    { principal: bob },
  );
  const bobClaim = await claim(h, bobBinding, 'bob-exhaust-key-0', bob);
  assert.equal(bobClaim.claimed, true);
  await h.store.releaseHolds({ op_id: bobClaim.op.op_id, generation: 1, reason: 'noop' });
  assert.equal(retained(h.sqlite, bob.principal_id), 1);
  assert.ok(retained(h.sqlite) <= 2);
});

test('retention: a replayed released key reconciles while its row is retained', async () => {
  const h = createStoreHarness({
    ownerDaily: '0',
    env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '4', INFERENCE_DISPATCH_MAX_ADMISSIONS: '64' },
  });
  const binding = await admissionBinding(h);
  const first = await exhaustedSubmission(h, binding, 'replay-key-1');
  const replay = await claim(h, binding, 'replay-key-1');
  assert.equal(replay.claimed, false);
  assert.equal(replay.op.op_id, first.op.op_id);
  assert.equal(replay.op.phase, 'released');
  // Under the cap the row is not evicted at all, so reconcile stays exact.
  assert.equal(retained(h.sqlite), 1);
});

test('retention: settled rows count against the cap and expire only past the replay window', async () => {
  const h = createStoreHarness({ env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '2' } });
  await settledOperation(h, 'settled-key-1');
  await settledOperation(h, 'settled-key-2');
  assert.deepEqual(phases(h.sqlite), { settled: 2 });

  const binding = await admissionBinding(h);
  // Fresh settlement receipts are the replay record: the cap refuses new work
  // instead of evicting them.
  await assert.rejects(claim(h, binding, 'settled-key-3'),
    (e) => e.status === 429 && e.code === 'DISPATCH_LIMIT');
  assert.equal(retained(h.sqlite), 2);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_settlements').get().n, 2);

  // Past the retention window the terminal rows, their queue rows and their
  // settlement receipts are pruned in the same batch as the new claim.
  h.clock.advance(RETENTION_MS + 1);
  const c3 = await claim(h, binding, 'settled-key-3');
  assert.equal(c3.claimed, true);
  assert.deepEqual(phases(h.sqlite), { claimed: 1 });
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_settlements').get().n, 0);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').get().n, 0);
});

test('retention: uncertain, held or queued work is never pruned even at the cap', async () => {
  const h = createStoreHarness({
    env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '2', INFERENCE_DISPATCH_MAX_ADMISSIONS: '64' },
  });
  // Two admitted-then-fenced operations: released, but with an uncertain
  // outcome recorded, so they are retained indefinitely.
  for (const key of ['uncertain-key-1', 'uncertain-key-2']) {
    const flow = await admittedOperation(h, { op_key: key, principal: alice });
    assert.equal(flow.admitted.outcome, 'admitted');
    await h.store.markUncertain({ op_id: flow.op.op_id, generation: 1, phase: 'dispatch', detail: 'socket lost' });
    const fenced = await h.store.fenceStart({ op_id: flow.op.op_id, generation: 1 });
    assert.equal(fenced.outcome, 'fenced');
    const released = await h.store.releaseHolds({ op_id: flow.op.op_id, generation: 1, reason: 'fenced' });
    assert.equal(released.released, 1);
  }
  assert.deepEqual(phases(h.sqlite), { released: 2 });
  assert.equal(h.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM dispatch_operations WHERE uncertain_phase IS NOT NULL").get().n, 2);

  const binding = await admissionBinding(h);
  await assert.rejects(claim(h, binding, 'uncertain-key-3'),
    (e) => e.status === 429 && e.code === 'DISPATCH_LIMIT');
  // The uncertain rows survive the refusal.
  assert.deepEqual(phases(h.sqlite), { released: 2 });
});

test('retention: repeated reserve/release cycles leave no hold rows behind', async () => {
  const h = createStoreHarness({
    env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '2', INFERENCE_DISPATCH_MAX_ADMISSIONS: '64' },
  });
  const binding = await admissionBinding(h);
  const poolId = binding.pools[0].pool_id;
  for (let i = 0; i < 25; i += 1) {
    const c = await claim(h, binding, `cycle-key-${i}`);
    assert.equal(c.claimed, true, `cycle ${i} could not claim`);
    const hold = await h.store.acquireHold({
      op_id: c.op.op_id, generation: 1, pool_id: poolId, amount: binding.pools[0].amount,
    });
    assert.equal(hold.held, true, `cycle ${i} could not reserve`);
    const released = await h.store.releaseHolds({ op_id: c.op.op_id, generation: 1, reason: 'cancelled' });
    assert.equal(released.released, 1, `cycle ${i} did not release its hold`);
  }

  const counts = durableCounts(h.sqlite);
  assert.ok(counts.dispatch_operations <= 2,
    `retained ${counts.dispatch_operations} operations for one principal exceeds the cap of 2`);
  assert.ok(counts.dispatch_holds <= 2,
    `retained ${counts.dispatch_holds} hold rows for one principal exceeds the cap of 2`);
  // A released hold refunded its reservation: the pool counter is back to zero
  // and pruning must not touch it a second time.
  assert.equal(h.sqlite.prepare('SELECT used_tokens FROM dispatch_pool_usage WHERE pool_id = ?')
    .get(poolId).used_tokens, 0);
});

test('retention: settled expiry prunes charged holds and receipts but never refunds the charge', async () => {
  const h = createStoreHarness({ env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '2' } });
  const poolId = 'owner:user-alice:2026-03-01';
  await settledOperation(h, 'settled-hold-1');
  await settledOperation(h, 'settled-hold-2');
  assert.equal(h.sqlite.prepare('SELECT used_tokens FROM dispatch_pool_usage WHERE pool_id = ?')
    .get(poolId).used_tokens, 256);

  // Resolve the admission before time moves: the resource heartbeat is only
  // fresh at T0, and claimOperation itself does not re-check admission expiry.
  const binding = await admissionBinding(h);
  h.clock.advance(RETENTION_MS + 1);
  const c3 = await claim(h, binding, 'settled-hold-3');
  assert.equal(c3.claimed, true);

  const counts = durableCounts(h.sqlite);
  assert.equal(counts.dispatch_holds, 0, 'charged hold rows outlived their pruned operations');
  assert.equal(counts.dispatch_settlements, 0);
  assert.equal(counts.dispatch_jobs, 0);
  // Settlement already charged the pool; deleting the receipt rows must not
  // decrement the counters as a release would.
  assert.equal(h.sqlite.prepare('SELECT used_tokens FROM dispatch_pool_usage WHERE pool_id = ?')
    .get(poolId).used_tokens, 256);
});

test('retention: a held hold protects its operation from eviction', async () => {
  const h = createStoreHarness({
    env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '2', INFERENCE_DISPATCH_MAX_ADMISSIONS: '64' },
  });
  const binding = await admissionBinding(h);
  const poolId = binding.pools[0].pool_id;

  // op1 reserves and keeps its hold; op2 reserves, releases and is terminal.
  const c1 = await claim(h, binding, 'protect-key-1');
  const held = await h.store.acquireHold({
    op_id: c1.op.op_id, generation: 1, pool_id: poolId, amount: binding.pools[0].amount,
  });
  assert.equal(held.held, true);
  const c2 = await claim(h, binding, 'protect-key-2');
  assert.equal(c2.claimed, true);
  assert.equal((await h.store.acquireHold({
    op_id: c2.op.op_id, generation: 1, pool_id: poolId, amount: binding.pools[0].amount,
  })).held, true);
  assert.equal((await h.store.releaseHolds({ op_id: c2.op.op_id, generation: 1 })).released, 1);

  // At the cap, the released operation makes room; the holding one does not.
  const c3 = await claim(h, binding, 'protect-key-3');
  assert.equal(c3.claimed, true);
  const live = h.sqlite.prepare("SELECT op_id, phase FROM dispatch_operations WHERE phase <> 'released'")
    .all().map((r) => r.op_id).sort();
  assert.deepEqual(live, [c1.op.op_id, c3.op.op_id].sort());
  assert.deepEqual(
    h.sqlite.prepare("SELECT op_id, state FROM dispatch_holds WHERE state IN ('held', 'committed')").all()
      .map((r) => r.op_id),
    [c1.op.op_id],
  );
  assert.equal(durableCounts(h.sqlite).dispatch_holds, 1);
});

test('retention: evicting a released operation is safe to cancel again and never replays its charge', async () => {
  const h = createStoreHarness({
    env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '1', INFERENCE_DISPATCH_MAX_ADMISSIONS: '64' },
  });
  const binding = await admissionBinding(h);
  const poolId = binding.pools[0].pool_id;
  const reserveAndRelease = async (key) => {
    const c = await claim(h, binding, key);
    assert.equal(c.claimed, true, `${key} could not claim`);
    assert.equal((await h.store.acquireHold({
      op_id: c.op.op_id, generation: 1, pool_id: poolId, amount: binding.pools[0].amount,
    })).held, true);
    assert.equal((await h.store.releaseHolds({ op_id: c.op.op_id, generation: 1 })).released, 1);
    return c.op;
  };

  const first = await reserveAndRelease('evict-key-a');
  await reserveAndRelease('evict-key-b'); // evicts the released A at the cap
  assert.equal(await h.store.getOperation({ op_key: 'evict-key-a' }), null);

  // Cancelling or redeeming an already-evicted operation is a harmless no-op:
  // no throw, no charge, nothing released twice.
  assert.deepEqual(await h.store.releaseHolds({ op_id: first.op_id, generation: 1 }),
    { released: 0 });
  assert.equal((await h.store.redeemStart({ op_id: first.op_id, generation: 1 })).outcome, 'refused');
  assert.equal(h.sqlite.prepare('SELECT used_tokens FROM dispatch_pool_usage WHERE pool_id = ?')
    .get(poolId).used_tokens, 0);

  // Past eviction the same key is a new operation (the documented replay
  // bound). It starts clean: no inherited hold, no inherited charge.
  const replayed = await reserveAndRelease('evict-key-a');
  assert.notEqual(replayed.op_id, first.op_id);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_holds WHERE op_id = ?')
    .get(first.op_id).n, 0);
  assert.equal(h.sqlite.prepare('SELECT used_tokens FROM dispatch_pool_usage WHERE pool_id = ?')
    .get(poolId).used_tokens, 0);
  assert.equal(durableCounts(h.sqlite).dispatch_operations, 1);
});

test('retention: the cap applies at the store instance boundary, not per store object', async () => {
  const h = createStoreHarness({ env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '1' } });
  await settledOperation(h, 'boundary-key-1');
  const other = createD1DispatchStore(h.db, {
    now: h.clock.now,
    env: { INFERENCE_OWNER_DAILY_TOKENS: '10000', INFERENCE_DISPATCH_MAX_OPERATIONS: '1' },
  });
  const binding = await admissionBinding(h);
  await assert.rejects(other.claimOperation({
    op_key: 'boundary-key-2', request_digest: 'sha256:boundary', principal_id: alice.principal_id,
    tenant_id: alice.tenant_id, binding,
  }), (e) => e.status === 429 && e.code === 'DISPATCH_LIMIT');
  assert.equal(retained(h.sqlite), 1);
});

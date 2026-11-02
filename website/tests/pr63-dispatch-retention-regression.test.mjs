// PR63 retention regressions, round 2 contract.
//
// Round 1 (findings 4437419399 / 4437303806 and the two follow-ups) proved:
//   * a refused hold left an unbounded `released` row per unique key;
//   * pruning deleted an operation but left its `dispatch_holds` rows behind;
//   * a stale coordinator cancel could recreate an orphan fence tombstone.
// Those proofs are kept below. What changed in round 2 is the *cap semantics*,
// because one "retained operations" number could not express all three limits:
//   * active work (`INFERENCE_DISPATCH_MAX_OPERATIONS`) counts non-terminal
//     phases only — settled receipts are history, not concurrency;
//   * a rolling claim quota bounds new operations per principal, and a spent
//     window refuses a fresh key with zero row changes;
//   * terminal history is the replay record, kept for the retention window,
//     with capacity derived from quota x retention so the quota itself can
//     never fill it.
// Pruning is per principal, bounded per claim, and never touches an operation
// with `uncertain_phase`, a held/committed hold, or a queued/leased job.
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
const CLAIM_QUOTA = storeModule.DEFAULT_DISPATCH_CLAIMS_PER_WINDOW ?? 100;

// Pressure environment: one claim per simulated minute, 1 h of retention, so
// 70 claims advance the clock past retention and aged terminal state becomes
// prunable. Retained size is bounded by the quota, not by a deletion trigger.
// The owner pool is left funded here: these tests need real reservations, so
// churn claims and releases instead of exhausting the pool.
const PRESSURE_ENV = Object.freeze({
  INFERENCE_DISPATCH_MAX_OPERATIONS: '20',
  INFERENCE_DISPATCH_MAX_ADMISSIONS: '512',
  INFERENCE_DISPATCH_RETENTION_MS: '3600000',
});
const retainedLimitFor = (env) => (typeof storeModule.retainedOperationLimit === 'function'
  ? storeModule.retainedOperationLimit(env)
  : 16_924);
const PRESSURE_LIMIT = retainedLimitFor(PRESSURE_ENV);
// 1 h of retention / 60 s per claim, plus slack: enough for the oldest rows to
// age out and be pruned within the churn.
const PRESSURE_CHURN = 70;

const retained = (sqlite, principal = alice.principal_id) => sqlite.prepare(
  'SELECT COUNT(*) AS n FROM dispatch_operations WHERE principal_id = ?').get(principal).n;

// Every durable table a pruned operation can leave rows in. The bound has to
// hold for all of them, not just dispatch_operations: the follow-up finding is
// a hold row that outlived its operation because only the operation was pruned.
const DURABLE = ['dispatch_operations', 'dispatch_holds', 'dispatch_settlements',
  'dispatch_jobs', 'dispatch_start_redemptions', 'dispatch_fences'];
const durableCounts = (sqlite) => Object.fromEntries(DURABLE.map(
  (table) => [table, sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));

const phases = (sqlite, principal = alice.principal_id) => Object.fromEntries(sqlite.prepare(
  'SELECT phase, COUNT(*) AS n FROM dispatch_operations WHERE principal_id = ? GROUP BY phase')
  .all(principal).map((r) => [r.phase, r.n]));

// A quota refusal is a thrown 429, which is the coordinator's contract. Tests
// that deliberately run past the window capture it instead of aborting.
async function claim(h, binding, key, principal = alice) {
  try {
    return await h.store.claimOperation({
      op_key: key, request_digest: `sha256:${key}`, principal_id: principal.principal_id,
      tenant_id: principal.tenant_id, binding,
    });
  } catch (e) {
    if (e && e.code === 'DISPATCH_LIMIT') return { claimed: false, denied: true, status: e.status, code: e.code };
    throw e;
  }
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
  if (c.denied || !c.claimed) return { claimed: false, denied: !!c.denied };
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
  const flow = await dispatchedOperation(h, {
    op_key: key, principal: alice, deadline_at: h.clock.now() + 60000,
  });
  const frame = await h.store.leaseNextJob({ resource_id: RES_1 });
  assert.ok(frame, 'a queued job must be leasable');
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

// Age pressure: one released operation per simulated minute. Enough of them
// move the clock past retention, which is the only path that prunes terminal
// state now. A claim with no hold still becomes `released` through the
// releaseHolds gate, so this needs no budget and no refused hold.
async function churn(h, binding, prefix, count) {
  for (let i = 0; i < count; i += 1) {
    h.clock.advance(60001);
    const r = await claim(h, binding, `${prefix}-${i}`);
    assert.equal(r.claimed, true, `${prefix}-${i} could not claim`);
    await h.store.releaseHolds({ op_id: r.op.op_id, generation: 1, reason: 'churn' });
  }
}

test('retention: exhausted-budget submissions cannot retain or write without bound', async () => {
  const h = createStoreHarness({
    ownerDaily: '0',
    env: {
      INFERENCE_DISPATCH_MAX_OPERATIONS: '2',
      INFERENCE_DISPATCH_MAX_ADMISSIONS: '64',
      INFERENCE_DISPATCH_CLAIMS_PER_WINDOW: '5',
    },
  });
  const binding = await admissionBinding(h);
  const before = h.sqlite.prepare('SELECT total_changes() AS n').get().n;
  let released = 0;
  let denied = 0;
  for (let i = 0; i < 25; i += 1) {
    const r = await exhaustedSubmission(h, binding, `exhaust-key-${i}`);
    if (r.claimed) released += 1;
    if (r.denied) denied += 1;
  }

  assert.equal(released, 5, 'only the rolling window may create operations');
  assert.equal(denied, 20, 'the rest are refused by the quota');
  assert.equal(retained(h.sqlite), 5, 'retained rows are bounded by the quota, not by attempts');
  // Every retained row is terminal safe state, and no hold row survived.
  assert.deepEqual(phases(h.sqlite), { released: 5 });
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_holds').get().n, 0);
  // 25 attempts cost a bounded number of writes; the 20 denials wrote nothing.
  const wrote = h.sqlite.prepare('SELECT total_changes() AS n').get().n - before;
  assert.ok(wrote <= 10 * 5, `25 attempts wrote ${wrote} row changes against a quota of 5`);

  // The quota is per principal: another tenant's rows are not touched.
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
  assert.equal(retained(h.sqlite), 5);
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
  assert.equal(retained(h.sqlite), 1);
});

test('retention: settled receipts are history, not concurrency, and expire past retention', async () => {
  const h = createStoreHarness({ env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '2' } });
  await settledOperation(h, 'settled-key-1');
  await settledOperation(h, 'settled-key-2');
  assert.deepEqual(phases(h.sqlite), { settled: 2 });

  const binding = await admissionBinding(h);
  // Unlike round 1, settled receipts no longer occupy the active cap: a third
  // claim succeeds, and the two receipts stay for the replay window.
  const c3 = await claim(h, binding, 'settled-key-3');
  assert.equal(c3.claimed, true, 'settled receipts must not lock the principal out');
  assert.equal(retained(h.sqlite), 3);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_settlements').get().n, 2);

  // Past the retention window the terminal rows, their queue rows and their
  // settlement receipts are pruned in the same batch as the next claim.
  h.clock.advance(RETENTION_MS + 1);
  const c4 = await claim(h, binding, 'settled-key-4');
  assert.equal(c4.claimed, true);
  assert.deepEqual(phases(h.sqlite), { claimed: 2 });
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_settlements').get().n, 0);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').get().n, 0);
});

test('retention: uncertain, held or queued work is never pruned under capacity pressure', async () => {
  const h = createStoreHarness({ env: PRESSURE_ENV });
  const binding = await admissionBinding(h);
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
  assert.equal(h.sqlite.prepare(
    'SELECT COUNT(*) AS n FROM dispatch_operations WHERE uncertain_phase IS NOT NULL').get().n, 2);

  // History older than retention is pruned as the claims continue; the
  // uncertain rows stay.
  await churn(h, binding, 'uncertain-churn', PRESSURE_CHURN);
  assert.equal(h.sqlite.prepare(
    'SELECT COUNT(*) AS n FROM dispatch_operations WHERE uncertain_phase IS NOT NULL').get().n, 2,
  'the uncertain operations were pruned by capacity pressure');
  assert.equal(retained(h.sqlite) <= PRESSURE_LIMIT + 2, true);
});

test('retention: repeated reserve/release cycles leave no orphan hold rows', async () => {
  const h = createStoreHarness({ env: PRESSURE_ENV });
  const binding = await admissionBinding(h);
  const poolId = binding.pools[0].pool_id;
  for (let i = 0; i < PRESSURE_CHURN + 20; i += 1) {
    h.clock.advance(60001);
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
  assert.ok(counts.dispatch_operations <= PRESSURE_CHURN + 20,
    `retained ${counts.dispatch_operations} operations exceeds the derived retained bound`);
  // Every hold row belongs to a retained operation: pruning removed the hold
  // with its operation, which is the round-1 follow-up regression.
  assert.equal(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM dispatch_holds h
    WHERE NOT EXISTS (SELECT 1 FROM dispatch_operations o WHERE o.op_id = h.op_id)`).get().n, 0,
  'a pruned operation left a hold row behind');
  assert.equal(counts.dispatch_holds, counts.dispatch_operations);
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

test('retention: a held hold protects its operation from capacity eviction', async () => {
  const h = createStoreHarness({ env: PRESSURE_ENV });
  const binding = await admissionBinding(h);
  const poolId = binding.pools[0].pool_id;

  // op1 reserves and keeps its hold.
  const c1 = await claim(h, binding, 'protect-key-1');
  assert.equal(c1.claimed, true);
  const held = await h.store.acquireHold({
    op_id: c1.op.op_id, generation: 1, pool_id: poolId, amount: binding.pools[0].amount,
  });
  assert.equal(held.held, true);

  // History far past retention; none of it may evict the live reservation.
  await churn(h, binding, 'protect-churn', PRESSURE_CHURN);

  const live = await h.store.getOperation({ op_key: 'protect-key-1' });
  assert.ok(live, 'the held operation was evicted');
  assert.equal(live.phase, 'holding');
  assert.deepEqual(
    h.sqlite.prepare("SELECT op_id FROM dispatch_holds WHERE state IN ('held', 'committed')").all()
      .map((r) => r.op_id),
    [c1.op.op_id],
  );
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_holds').get().n, 1);
});

// The prune candidate is read before the batch. If another isolate resolves one
// of those candidates as uncertain in that gap, a batch that deletes children by
// the stale id list strips the settlement/job/hold/redemption/fence rows while
// the protected operation survives — silent history loss for an operation that
// is supposed to be untouchable. Every prune statement must therefore re-derive
// the set from the same inline predicate.
test('retention: a stale prune read cannot strip children of an operation that became uncertain', async () => {
  const env = {
    INFERENCE_DISPATCH_MAX_OPERATIONS: '20',
    INFERENCE_DISPATCH_MAX_ADMISSIONS: '512',
    INFERENCE_OWNER_DAILY_TOKENS: '100000',
    INFERENCE_DISPATCH_RETENTION_MS: '3600000',
  };
  const h = createStoreHarness({ env });

  // A settled operation (holds, settlement, terminal job, start redemption) ...
  const settled = await settledOperation(h, 'stale-prune-settled');
  // ... and a fenced then released one, so a fence tombstone is in scope too.
  const binding = await admissionBinding(h);
  const fenced = await claim(h, binding, 'stale-prune-fenced');
  assert.equal(fenced.claimed, true);
  assert.deepEqual(await h.store.fenceStart({ op_id: fenced.op.op_id, generation: 1 }),
    { outcome: 'fenced' });
  assert.deepEqual(await h.store.releaseHolds({ op_id: fenced.op.op_id, generation: 1 }),
    { released: 0 });

  const victimIds = [settled.op.op_id, fenced.op.op_id];
  const childTables = ['dispatch_holds', 'dispatch_settlements', 'dispatch_jobs',
    'dispatch_start_redemptions', 'dispatch_fences'];
  const childCount = (table, opId) => h.sqlite.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE op_id = ?`).get(opId).n;
  const before = victimIds.map((opId) => Object.fromEntries(
    childTables.map((table) => [table, childCount(table, opId)])));
  assert.ok(before[0].dispatch_settlements === 1 && before[0].dispatch_jobs === 1
    && before[0].dispatch_holds === 1 && before[0].dispatch_start_redemptions === 1,
  'the settled victim must have children to lose');
  assert.equal(before[1].dispatch_fences, 1);

  // Both are past retention, so both are prune candidates at the next claim.
  h.clock.advance(3_600_001);

  // Another store resolves both as uncertain after the candidate read and before
  // the first child delete. No uncertain flag existed when the list was read.
  let fired = false;
  const db = {
    ...h.db,
    prepare(sql) {
      const stmt = h.db.prepare(sql);
      const wrap = (s) => ({
        raw: s, sql,
        bind: (...p) => wrap(s.bind(...p)),
        all: (...p) => s.all(...p),
        first: (...p) => s.first(...p),
        run: async (...p) => {
          if (!fired && /^DELETE FROM dispatch_start_redemptions/.test(sql)) {
            fired = true;
            h.sqlite.prepare(`UPDATE dispatch_operations
              SET uncertain_phase = 'dispatch', updated_at = ?
              WHERE op_id IN (?, ?)`).run(new Date(h.clock.now()).toISOString(), ...victimIds);
          }
          return s.run(...p);
        },
      });
      return wrap(stmt);
    },
  };
  const watcher = createD1DispatchStore(db, { now: h.clock.now, env });
  const c = await watcher.claimOperation({
    op_key: 'stale-prune-winner', request_digest: 'sha256:stale-prune-winner',
    principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
  });
  assert.equal(c.claimed, true);
  assert.equal(fired, true, 'the claim did not reach the prune batch');

  // Nothing of either protected operation was deleted.
  victimIds.forEach((opId, i) => {
    for (const table of childTables) {
      assert.equal(childCount(table, opId), before[i][table],
        `${table} rows of the protected operation ${opId} were deleted`);
    }
    const row = h.sqlite.prepare('SELECT uncertain_phase FROM dispatch_operations WHERE op_id = ?').get(opId);
    assert.ok(row, `the protected operation ${opId} was pruned`);
    assert.equal(row.uncertain_phase, 'dispatch');
  });
});

// releaseHolds commits the phase flip in one batch and flips/refunds the holds
// in the next. A crash in between leaves released work that still owns reserved
// budget and carries no uncertain flag; a queued/leased job on a terminal row is
// the same shape. Both are live work and must consume the active cap, or
// protected rows accumulate without any bound.
test('retention: live holds and queued jobs count as active whatever the phase', async () => {
  const h = createStoreHarness({
    env: {
      INFERENCE_DISPATCH_MAX_OPERATIONS: '3',
      INFERENCE_DISPATCH_MAX_ADMISSIONS: '512',
      INFERENCE_OWNER_DAILY_TOKENS: '100000',
    },
  });
  const binding = await admissionBinding(h);
  const poolId = binding.pools[0].pool_id;
  const setReleased = (opId) => h.sqlite.prepare(
    "UPDATE dispatch_operations SET phase = 'released' WHERE op_id = ?").run(opId);
  const holdState = (opId) => h.sqlite.prepare(
    "SELECT state FROM dispatch_holds WHERE op_id = ?).get(opId)");

  // A: held hold, phase flipped to released, refund batch never ran.
  const a = await claim(h, binding, 'crash-held');
  assert.equal(a.claimed, true);
  assert.equal((await h.store.acquireHold({
    op_id: a.op.op_id, generation: 1, pool_id: poolId, amount: binding.pools[0].amount,
  })).held, true);
  setReleased(a.op.op_id);

  // B: same crash window after admit, so the hold is `committed`.
  const b = await admittedOperation(h, { op_key: 'crash-committed', principal: alice });
  assert.equal(b.admitted.outcome, 'admitted');
  setReleased(b.op.op_id);

  // C: a dispatched operation whose only live protection is its queued job.
  const c = await dispatchedOperation(h, {
    op_key: 'crash-queued', principal: alice, deadline_at: h.clock.now() + 60000,
  });
  h.sqlite.prepare("UPDATE dispatch_holds SET state = 'released' WHERE op_id = ? AND state IN ('held', 'committed')")
    .run(c.op.op_id);
  setReleased(c.op.op_id);

  // None of the three wears the uncertain flag; the protection is the live hold
  // or job itself.
  assert.equal(h.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM dispatch_operations WHERE uncertain_phase IS NOT NULL").get().n, 0);
  assert.deepEqual(h.sqlite.prepare(
    "SELECT op_id || ':' || state AS id FROM dispatch_holds WHERE state IN ('held', 'committed') ORDER BY op_id")
    .all().map((r) => r.id).sort(),
  [`${a.op.op_id}:held`, `${b.op.op_id}:committed`].sort());
  assert.equal(h.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM dispatch_jobs WHERE op_id = ? AND status IN ('queued', 'leased')")
    .get(c.op.op_id).n, 1);

  // The cap is full: a fourth claim is refused and writes nothing.
  const before = h.sqlite.prepare('SELECT total_changes() AS n').get().n;
  const denied = await claim(h, binding, 'crash-fourth');
  assert.equal(denied.denied, true, 'live protected work must consume the active cap');
  assert.equal(denied.status, 429);
  assert.equal(h.sqlite.prepare('SELECT total_changes() AS n').get().n - before, 0,
    'the denial must not write');

  // The protected rows are still there — a refusal never prunes.
  for (const opId of [a.op.op_id, b.op.op_id, c.op.op_id]) {
    assert.ok(h.sqlite.prepare('SELECT 1 FROM dispatch_operations WHERE op_id = ?').get(opId));
  }
});

test('retention: evicting a released operation is safe to cancel again and never replays its charge', async () => {
  const h = createStoreHarness({ env: PRESSURE_ENV });
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
  // Age pressure evicts the released A, hold rows included.
  await churn(h, binding, 'evict-churn', PRESSURE_CHURN);
  assert.equal(await h.store.getOperation({ op_key: 'evict-key-a' }), null);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_holds WHERE op_id = ?')
    .get(first.op_id).n, 0);

  // Cancelling or redeeming an already-evicted operation is a harmless no-op:
  // no throw, no charge, nothing released twice.
  assert.deepEqual(await h.store.releaseHolds({ op_id: first.op_id, generation: 1 }),
    { released: 0 });
  assert.equal((await h.store.redeemStart({ op_id: first.op_id, generation: 1 })).outcome, 'refused');
  assert.equal(h.sqlite.prepare('SELECT used_tokens FROM dispatch_pool_usage WHERE pool_id = ?')
    .get(poolId).used_tokens, 0);

  // Past eviction the same key is a new operation (the documented replay
  // bound). It starts clean: no inherited hold, no inherited charge.
  h.clock.advance(60001);
  const replayed = await reserveAndRelease('evict-key-a');
  assert.notEqual(replayed.op_id, first.op_id);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_holds WHERE op_id = ?')
    .get(first.op_id).n, 0);
  assert.equal(h.sqlite.prepare('SELECT used_tokens FROM dispatch_pool_usage WHERE pool_id = ?')
    .get(poolId).used_tokens, 0);
});

const fenceCount = (sqlite, opId) => sqlite.prepare(
  'SELECT COUNT(*) AS n FROM dispatch_fences WHERE op_id = ?').get(opId).n;

test('retention: a stale coordinator cancel cannot recreate a fence for a pruned operation', async () => {
  // The coordinator's cancel() reads the operation with lookup() and only then
  // calls fenceAndRelease(op) -> fenceStart(op_id, op.generation). If another
  // store fences and releases the operation, and capacity pressure later prunes
  // the released row, the resumed cancel still calls fenceStart with the stale
  // op_id. Without an existence guard that call re-inserts a tombstone whose
  // operation is gone: one orphan dispatch_fences row per unique op_id, which no
  // prune can ever reach because it is keyed only by the dead op_id.
  const h = createStoreHarness({ ownerDaily: '0', env: PRESSURE_ENV });
  const binding = await admissionBinding(h);
  const first = await claim(h, binding, 'stale-cancel-key-1');
  const stale = await h.store.getOperation({ op_key: 'stale-cancel-key-1' }); // the lookup()
  assert.equal(stale.phase, 'claimed');
  assert.equal(stale.op_id, first.op.op_id);

  // The request that wins the race fences and releases it.
  assert.deepEqual(await h.store.fenceStart({ op_id: stale.op_id, generation: stale.generation }),
    { outcome: 'fenced' });
  assert.equal(fenceCount(h.sqlite, stale.op_id), 1);
  assert.deepEqual(await h.store.releaseHolds({ op_id: stale.op_id, generation: stale.generation }),
    { released: 0 });
  assert.equal((await h.store.getOperation({ op_key: 'stale-cancel-key-1' })).phase, 'released');

  // Age pressure evicts the released operation together with its tombstone.
  await churn(h, binding, 'stale-cancel-churn', PRESSURE_CHURN);
  assert.equal(await h.store.getOperation({ op_key: 'stale-cancel-key-1' }), null);
  assert.equal(fenceCount(h.sqlite, stale.op_id), 0);

  // The paused cancel resumes with the stale op_id. Under the existing contract
  // that is a safe no-op that still reports 'fenced' — and it must not write a
  // tombstone for an operation that no longer exists.
  assert.deepEqual(await h.store.fenceStart({ op_id: stale.op_id, generation: stale.generation }),
    { outcome: 'fenced' });
  assert.equal(fenceCount(h.sqlite, stale.op_id), 0,
    'the resumed stale cancel recreated an orphan fence tombstone');
  assert.deepEqual(await h.store.releaseHolds({ op_id: stale.op_id, generation: stale.generation }),
    { released: 0 });

  // Direct guard boundary: a never-existing op_id is the same no-op.
  assert.deepEqual(await h.store.fenceStart({ op_id: 'dispatch-op-unknown', generation: 1 }),
    { outcome: 'fenced' });
  assert.equal(fenceCount(h.sqlite, 'dispatch-op-unknown'), 0);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_fences').get().n, 0);
});

test('fence: the existence guard keeps redeemed, wrong-generation and live behavior', async () => {
  const h = createStoreHarness();
  // A start that already happened is still reported as such and writes nothing.
  const done = await dispatchedOperation(h, { principal: alice, max_tokens: 32, op_key: 'fence-guard-done' });
  assert.deepEqual(await h.store.fenceStart({ op_id: done.op.op_id, generation: 1 }),
    { outcome: 'already_redeemed' });
  assert.equal(fenceCount(h.sqlite, done.op.op_id), 0);

  // A fence naming a generation the operation does not have is a no-op: it
  // never minted a tombstone that could outlive the operation, and it must not
  // block the operation's real generation.
  const live = await admittedOperation(h, { principal: alice, max_tokens: 32, op_key: 'fence-guard-live' });
  assert.deepEqual(await h.store.fenceStart({ op_id: live.op.op_id, generation: 2 }), { outcome: 'fenced' });
  assert.equal(fenceCount(h.sqlite, live.op.op_id), 0);
  const worker = { node_id: live.binding.node_id, runtime_instance: live.binding.runtime_instance };
  assert.deepEqual(await h.store.redeemStart({ op_id: live.op.op_id, generation: 2, worker }),
    { outcome: 'refused', reason: 'fenced' });

  // The real generation still fences exactly once, and the fence still blocks
  // the start (the cancellation contract).
  const other = await admittedOperation(h, { principal: alice, max_tokens: 32, op_key: 'fence-guard-other' });
  assert.deepEqual(await h.store.fenceStart({ op_id: other.op.op_id, generation: 1 }), { outcome: 'fenced' });
  assert.deepEqual(await h.store.fenceStart({ op_id: other.op.op_id, generation: 1 }), { outcome: 'fenced' });
  assert.equal(fenceCount(h.sqlite, other.op.op_id), 1);
  assert.deepEqual(await h.store.redeemStart({
    op_id: other.op.op_id, generation: 1,
    worker: { node_id: other.binding.node_id, runtime_instance: other.binding.runtime_instance },
  }), { outcome: 'refused', reason: 'fenced' });
});

test('retention: the active cap applies at the store instance boundary, not per store object', async () => {
  const h = createStoreHarness({ env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '1' } });
  const first = await claim(h, await admissionBinding(h), 'boundary-key-1');
  assert.equal(first.claimed, true);
  const other = createD1DispatchStore(h.db, {
    now: h.clock.now,
    env: { INFERENCE_OWNER_DAILY_TOKENS: '10000', INFERENCE_DISPATCH_MAX_OPERATIONS: '1' },
  });
  const binding = await admissionBinding(h);
  // One active operation exists, written by the first store object. A second
  // store object over the same database must see it in the same batch.
  await assert.rejects(other.claimOperation({
    op_key: 'boundary-key-2', request_digest: 'sha256:boundary', principal_id: alice.principal_id,
    tenant_id: alice.tenant_id, binding,
  }), (e) => e.status === 429 && e.code === 'DISPATCH_LIMIT');
  assert.equal(retained(h.sqlite), 1);

  // Releasing the first operation frees the slot for the other instance.
  await h.store.releaseHolds({ op_id: first.op.op_id, generation: 1, reason: 'cancelled' });
  const second = await other.claimOperation({
    op_key: 'boundary-key-2', request_digest: 'sha256:boundary', principal_id: alice.principal_id,
    tenant_id: alice.tenant_id, binding,
  });
  assert.equal(second.claimed, true);
});

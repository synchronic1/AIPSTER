// PR63 round 2 — write-budget finding PRRT_kwDOVYKI0c6ye8ko (comment 4437565771).
//
// The retention cap bounded *rows* but not *writes*: with an exhausted budget,
// 500 unique claims produced ~1499 SQLite row changes while retaining only two
// operations. Every denied submission still evicted a released row (or pruned
// history) and inserted a fresh one, so an authenticated principal could drive
// D1 write volume without bound while the row cap held steady.
//
// A second, independent defect surfaced with the same fix: counting every
// retained operation against one cap meant 20 settled operations locked the
// principal out for the whole 7-day replay window (429 on the 21st legitimate
// job), because a settlement receipt is deliberately kept for replay.
//
// The store separates three limits:
//   * active work — non-terminal operations plus any operation whose outcome is
//     unresolved, whatever its phase;
//   * a true trailing claim window — a per-principal event ledger allows at most
//     `quota` *new* operations in any window-length interval. It is not a
//     counter with an anchored reset: 100 claims just before a reset and 100
//     just after must not add up to 200 inside one hour. A spent window refuses
//     a fresh key before it writes anything; a replay of a retained key never
//     costs quota;
//   * terminal history — settled/released receipts kept for the replay window
//     and pruned by age only. Fresh receipts are never deleted to make room,
//     because that would break the replay promise and could redispatch an old
//     idempotency key as a new operation.
//
// These tests run against the real store (node:sqlite D1 shim) and count actual
// SQLite row changes, so they fail on writes, not on intent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RES_1, alice, createStoreHarness, bindingFor, admittedOperation, dispatchedOperation, workerResult,
} from './fixtures/dispatch-store-fixture.mjs';
import * as storeModule from '../src/inference/dispatch-store.mjs';

// Pre-fix the constants do not exist; the fallbacks keep the repro runnable so
// the first failure is the measured write volume, not a module-load error.
const CLAIM_QUOTA = storeModule.DEFAULT_DISPATCH_CLAIMS_PER_WINDOW ?? 100;
const CLAIM_WINDOW_MS = storeModule.DEFAULT_DISPATCH_CLAIM_WINDOW_MS ?? 60 * 60 * 1000;
const RETAINED_LIMIT = storeModule.DEFAULT_DISPATCH_MAX_RETAINED_OPERATIONS ?? 16_924;
const retainedLimitFor = (env) => (typeof storeModule.retainedOperationLimit === 'function'
  ? storeModule.retainedOperationLimit(env)
  : RETAINED_LIMIT);

const rowChanges = (sqlite) => sqlite.prepare('SELECT total_changes() AS n').get().n;
const rows = (sqlite, sql, ...params) => sqlite.prepare(sql).get(...params).n;
const opRows = (sqlite, principal = alice.principal_id) => rows(
  sqlite, 'SELECT COUNT(*) AS n FROM dispatch_operations WHERE principal_id = ?', principal);
const settledRows = (sqlite, principal = alice.principal_id) => rows(sqlite,
  "SELECT COUNT(*) AS n FROM dispatch_operations WHERE principal_id = ? AND phase = 'settled'", principal);
const eventRows = (sqlite, principal = alice.principal_id) => rows(sqlite,
  'SELECT COUNT(*) AS n FROM dispatch_claim_events WHERE principal_id = ?', principal);

// A quota refusal is a thrown 429, which is the contract the coordinator maps;
// helpers that expect to run past the quota capture it instead of aborting.
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

async function admissionBinding(h, { max_tokens = 64 } = {}) {
  const a = await h.store.issueAdmission({ principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens });
  const rec = await h.store.resolveAdmission({ principal: alice, admission_ref: a.admission_ref });
  return bindingFor(rec, { principal: alice });
}

// An exhausted principal's submission: claim, refused hold, release. Every step
// that can write is counted by the test above it.
async function exhaustedSubmission(h, binding, key) {
  const c = await claim(h, binding, key);
  if (c.denied || !c.claimed) return { claimed: false, denied: !!c.denied, op: c.op };
  const hold = await h.store.acquireHold({
    op_id: c.op.op_id, generation: 1, pool_id: binding.pools[0].pool_id, amount: binding.pools[0].amount,
  });
  assert.equal(hold.held, false, 'the exhausted pool must refuse the hold');
  await h.store.releaseHolds({ op_id: c.op.op_id, generation: 1, reason: 'budget_exhausted' });
  return { claimed: true, op: c.op };
}

async function settledOperation(h, key) {
  // The deadline is relative to the injected clock, which these tests move.
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

// The seeded resources carry a heartbeat at T0; tests that move the injected
// clock must refresh it before the next admission liveness check.
const refreshResources = (h) => {
  h.sqlite.prepare('UPDATE resources SET heartbeat_at = ?').run(new Date(h.clock.now()).toISOString());
};

test('budget: 500 denied unique claims cannot write unbounded rows', async (t) => {
  const h = createStoreHarness({
    ownerDaily: '0',
    env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '2', INFERENCE_DISPATCH_MAX_ADMISSIONS: '64' },
  });
  const binding = await admissionBinding(h);
  const before = rowChanges(h.sqlite);
  let admitted = 0;
  for (let i = 0; i < 500; i += 1) {
    const r = await exhaustedSubmission(h, binding, `write-key-${i}`);
    if (r.claimed) admitted += 1;
  }
  const wrote = rowChanges(h.sqlite) - before;
  t.diagnostic(`500 denied unique claims: ${wrote} row changes, ${opRows(h.sqlite)} retained operations, ${admitted} admitted`);

  // Only new operations inside the trailing window may be claimed at all.
  assert.ok(admitted <= CLAIM_QUOTA,
    `500 denied submissions created ${admitted} operations; the quota is ${CLAIM_QUOTA}`);
  // Denied claims are refused before any prune or insert, so the write volume
  // is a small multiple of the quota rather than of the attempt count.
  assert.ok(wrote <= 10 * CLAIM_QUOTA,
    `500 denied submissions wrote ${wrote} row changes; a quota of ${CLAIM_QUOTA} allows at most ${10 * CLAIM_QUOTA}`);
  // Storage stays inside the documented bound.
  assert.ok(opRows(h.sqlite) <= CLAIM_QUOTA + 2, `retained ${opRows(h.sqlite)} operation rows`);
  assert.ok(eventRows(h.sqlite) <= CLAIM_QUOTA, 'the ledger must not grow past the window');
});

test('budget: the window trails; it is not a counter with an anchored reset', async () => {
  const h = createStoreHarness({
    ownerDaily: '0',
    env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '2', INFERENCE_DISPATCH_MAX_ADMISSIONS: '256' },
  });
  const binding = await admissionBinding(h);
  // One claim at T0, then 99 more just before the hour mark: 100 inside the
  // trailing hour.
  assert.equal((await exhaustedSubmission(h, binding, 'anchor-0')).claimed, true);
  h.clock.advance(CLAIM_WINDOW_MS - 60 * 1000);
  for (let i = 0; i < CLAIM_QUOTA - 1; i += 1) {
    const r = await exhaustedSubmission(h, binding, `late-${i}`);
    assert.equal(r.claimed, true, `claim ${i} of the first window must fit`);
  }
  // The window is full, and it does not reset on a clock boundary.
  assert.equal((await exhaustedSubmission(h, binding, 'late-over')).denied, true);

  // 61 s later a *tumbling* counter anchored at T0 would have reset and allowed
  // 100 more (200 inside about an hour). The trailing ledger allows exactly the
  // one slot the T0 event freed, because the 99 late events are still inside
  // the hour.
  h.clock.advance(61 * 1000);
  let allowed = 0;
  for (let i = 0; i < 10; i += 1) {
    if ((await exhaustedSubmission(h, binding, `after-reset-${i}`)).claimed) allowed += 1;
  }
  assert.equal(allowed, 1,
    `a retry burst just after the old reset point admitted ${allowed} claims; a trailing window admits 1`);
});

test('budget: a spent window refuses a new key with zero writes and replays for free', async () => {
  const h = createStoreHarness({
    ownerDaily: '0',
    env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '2', INFERENCE_DISPATCH_MAX_ADMISSIONS: '64' },
  });
  const binding = await admissionBinding(h);
  for (let i = 0; i < CLAIM_QUOTA; i += 1) {
    const r = await exhaustedSubmission(h, binding, `quota-key-${i}`);
    assert.equal(r.claimed, true, `claim ${i} must fit the window`);
  }
  // The window is spent: a brand-new key is refused with the same 429 the
  // coordinator already maps, and it writes nothing at all.
  const beforeDenied = rowChanges(h.sqlite);
  const denied = await claim(h, binding, 'quota-key-over');
  assert.equal(denied.denied, true);
  assert.equal(denied.status, 429);
  assert.equal(denied.code, 'DISPATCH_LIMIT');
  assert.equal(rowChanges(h.sqlite) - beforeDenied, 0, 'a denied new claim must not write rows');
  assert.equal(await h.store.getOperation({ op_key: 'quota-key-over' }), null);

  // Replays of retained keys are free even while the quota is exhausted.
  const before = rowChanges(h.sqlite);
  const replayed = await claim(h, binding, 'quota-key-0');
  assert.equal(replayed.claimed, false);
  assert.ok(replayed.op && replayed.op.op_id, 'retained key still reconciles');
  for (let i = 0; i < 100; i += 1) await claim(h, binding, 'quota-key-0');
  assert.equal(rowChanges(h.sqlite) - before, 0, 'replays must not write rows');

  // Time restores the quota, without touching the retained operation rows.
  const kept = opRows(h.sqlite);
  h.clock.advance(CLAIM_WINDOW_MS + 1);
  const fresh = await claim(h, binding, 'quota-key-after-window');
  assert.equal(fresh.claimed, true, 'a new claim must succeed after events leave the window');
  assert.ok(opRows(h.sqlite) >= kept);
});

test('budget: 20 settled operations do not lock out the 21st legitimate job', async () => {
  const h = createStoreHarness({
    env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '20', INFERENCE_DISPATCH_MAX_ADMISSIONS: '128' },
  });
  for (let i = 0; i < 20; i += 1) {
    h.clock.advance(1000);
    refreshResources(h);
    await settledOperation(h, `settled-lockout-${i}`);
  }
  assert.equal(settledRows(h.sqlite), 20);
  // Active work is zero: the settled receipts are history, not concurrency.
  const binding = await admissionBinding(h);
  const c = await claim(h, binding, 'settled-lockout-21');
  assert.equal(c.claimed, true, 'the 21st job must not be refused for 7 days');
  assert.equal(opRows(h.sqlite), 21);
  // The settled receipts are still there for replay until the retention bound.
  assert.equal(settledRows(h.sqlite), 20);
});

test('budget: a spent first window of settled receipts does not block later work', async () => {
  const h = createStoreHarness({
    env: {
      INFERENCE_DISPATCH_MAX_OPERATIONS: '20',
      INFERENCE_DISPATCH_MAX_ADMISSIONS: '256',
      INFERENCE_OWNER_DAILY_TOKENS: '1000000',
    },
  });
  // Saturate the trailing window entirely with legitimate, settled work.
  for (let i = 0; i < CLAIM_QUOTA; i += 1) {
    h.clock.advance(1000);
    refreshResources(h);
    await settledOperation(h, `hour1-${i}`);
  }
  assert.equal(settledRows(h.sqlite), CLAIM_QUOTA);
  const binding = await admissionBinding(h);

  // A receipt from the spent window still replays for free.
  const before = rowChanges(h.sqlite);
  const replay = await claim(h, binding, 'hour1-0');
  assert.equal(replay.claimed, false);
  assert.equal(replay.op.phase, 'settled');
  assert.equal(rowChanges(h.sqlite) - before, 0);

  // Once the first events leave the trailing hour the principal can work again,
  // although every receipt is fresh (age ≪ 7 days) and inside the replay
  // horizon.
  h.clock.advance(CLAIM_WINDOW_MS + 1);
  refreshResources(h);
  const later = await claim(h, binding, 'hour2-0');
  assert.equal(later.claimed, true, 'later work must not be locked out by retained receipts');
  assert.equal(settledRows(h.sqlite), CLAIM_QUOTA, 'no fresh settled receipt may be deleted to make room');
  const replayAgain = await claim(h, binding, 'hour1-0');
  assert.equal(replayAgain.claimed, false);
  assert.equal(replayAgain.op.op_id, replay.op.op_id);
});

test('budget: only age prunes terminal history; fresh receipts are never evicted', async () => {
  const env = {
    INFERENCE_DISPATCH_MAX_OPERATIONS: '20',
    INFERENCE_DISPATCH_MAX_ADMISSIONS: '512',
    INFERENCE_OWNER_DAILY_TOKENS: '1000000',
    INFERENCE_DISPATCH_CLAIMS_PER_WINDOW: '5',
    INFERENCE_DISPATCH_CLAIM_WINDOW_MS: '60000',
    INFERENCE_DISPATCH_RETENTION_MS: '3600000',
  };
  const limit = retainedLimitFor(env);
  assert.ok(limit >= 5 * 61 + 20, `documented retained bound ${limit} is too small`);
  const h = createStoreHarness({ env });

  // One uncertain operation that must never be pruned, whatever the pressure.
  const uncertain = await admittedOperation(h, { op_key: 'budget-uncertain', principal: alice, max_tokens: 32 });
  await h.store.markUncertain({ op_id: uncertain.op.op_id, generation: 1, phase: 'admit', detail: 'lost' });

  // 60 fresh settled receipts over 12 minutes: far past a fixed history cap,
  // and still inside the replay window.
  for (let i = 0; i < 60; i += 1) {
    if (i % 5 === 0) h.clock.advance(60001);
    h.clock.advance(1000);
    refreshResources(h);
    await settledOperation(h, `history-${i}`);
  }
  assert.equal(settledRows(h.sqlite), 60, 'fresh receipts must not be count-pruned');
  assert.ok(opRows(h.sqlite) <= limit, `retained ${opRows(h.sqlite)} operations exceeds the documented bound ${limit}`);
  // The oldest receipt is still replayable while it is inside retention.
  const binding = await admissionBinding(h);
  const early = await claim(h, binding, 'history-0');
  assert.equal(early.claimed, false);
  assert.equal(early.op.phase, 'settled');

  h.clock.advance(3600000 + 1);
  refreshResources(h);
  for (let i = 0; i < 3; i += 1) assert.equal((await claim(h, binding, `after-age-${i}`)).claimed, true);
  assert.ok(settledRows(h.sqlite) < 60, 'aged receipts must be pruned by age');
  assert.equal(await h.store.getOperation({ op_key: 'history-0' }), null);
  assert.ok(settledRows(h.sqlite) >= 45, 'fresh receipts must survive the aged prune');

  // The uncertain operation and its hold are untouched at any age.
  const still = await h.store.getOperation({ op_key: 'budget-uncertain' });
  assert.ok(still && still.uncertain, 'the uncertain operation must survive history pruning');
  assert.equal(rows(h.sqlite, `SELECT COUNT(*) AS n FROM dispatch_holds
    WHERE op_id = ? AND state IN ('held', 'committed')`, still.op_id), 1);
});

test('budget: two store instances share one trailing quota', async () => {
  const h = createStoreHarness({
    ownerDaily: '0',
    env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '2', INFERENCE_DISPATCH_MAX_ADMISSIONS: '256' },
  });
  const other = storeModule.createD1DispatchStore(h.db, {
    now: h.clock.now,
    env: {
      INFERENCE_OWNER_DAILY_TOKENS: '0',
      INFERENCE_DISPATCH_MAX_OPERATIONS: '2',
      INFERENCE_DISPATCH_MAX_ADMISSIONS: '256',
    },
  });
  const binding = await admissionBinding(h);
  const stores = [h.store, other];
  const attempts = CLAIM_QUOTA + 40;
  let admitted = 0;
  let denied = 0;
  for (let i = 0; i < attempts; i += 1) {
    const store = stores[i % 2];
    const key = `race-quota-${i}`;
    let c;
    try {
      c = await store.claimOperation({
        op_key: key, request_digest: `sha256:${key}`, principal_id: alice.principal_id,
        tenant_id: alice.tenant_id, binding,
      });
    } catch (e) {
      assert.equal(e.code, 'DISPATCH_LIMIT');
      denied += 1;
      continue;
    }
    if (c.claimed) {
      admitted += 1;
      await store.acquireHold({
        op_id: c.op.op_id, generation: 1, pool_id: binding.pools[0].pool_id,
        amount: binding.pools[0].amount,
      });
      await store.releaseHolds({ op_id: c.op.op_id, generation: 1, reason: 'budget_exhausted' });
    }
  }
  assert.equal(denied, attempts - admitted);
  assert.equal(admitted, CLAIM_QUOTA,
    `two instances admitted ${admitted} operations against a shared quota of ${CLAIM_QUOTA}`);
  assert.ok(eventRows(h.sqlite) <= CLAIM_QUOTA);
});

// The ledger needs its own table. Prove the migration is additive and
// re-appliable on an empty database, in isolation from every other file.
test('schema: the claim-ledger migration is additive and idempotent', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readFileSync } = await import('node:fs');
  const sqlite = new DatabaseSync(':memory:');
  const sql = readFileSync(new URL('../migrations/0025_inference_dispatch_claim_ledger.sql', import.meta.url), 'utf8');
  sqlite.exec(sql);
  sqlite.exec(sql); // IF NOT EXISTS: a second application must not throw
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.deepEqual(tables, ['dispatch_claim_events']);
  const cols = sqlite.prepare('SELECT * FROM pragma_table_info(?)').all('dispatch_claim_events').map((c) => c.name);
  assert.deepEqual(cols, ['principal_id', 'claimed_at']);
  const indexes = sqlite.prepare('SELECT * FROM pragma_index_list(?)').all('dispatch_claim_events');
  assert.ok(indexes.some((i) => i.name === 'idx_dispatch_claim_events_window'));
  const statements = sql.trim().split('\n').filter((l) => l && !l.startsWith('--')).join(' ').toUpperCase();
  assert.ok(!/\b(ALTER|DROP|TRIGGER|FOREIGN)\b/.test(statements), 'migration must stay additive');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_claim_events').get().n, 0);
});

// The pre-batch lookup is a fast path, not authority. Two isolates can both see
// no row for the same key; the loser's `INSERT OR IGNORE` already refuses to
// duplicate it, but a claim path that prunes before the insert would still have
// deleted up to PRUNE_BATCH aged families on the way to losing. A losing claim
// must be a pure replay: zero writes, one ledger event, no cleanup.
test('budget: a lookup that lost the same-key race is a pure replay and prunes nothing', async () => {
  const env = {
    INFERENCE_DISPATCH_MAX_OPERATIONS: '20',
    INFERENCE_DISPATCH_MAX_ADMISSIONS: '512',
    INFERENCE_OWNER_DAILY_TOKENS: '1000000',
    INFERENCE_DISPATCH_RETENTION_MS: '3600000',
  };
  const h = createStoreHarness({ env });
  const binding = await admissionBinding(h);
  const poolId = binding.pools[0].pool_id;
  // More than one PRUNE_BATCH of aged, eligible families: each is a released
  // operation with a released hold, so the loser would have work to do.
  for (let i = 0; i < 6; i += 1) {
    h.clock.advance(1000);
    const c = await claim(h, binding, `race-victim-${i}`);
    assert.equal(c.claimed, true);
    assert.equal((await h.store.acquireHold({
      op_id: c.op.op_id, generation: 1, pool_id: poolId, amount: binding.pools[0].amount,
    })).held, true);
    assert.equal((await h.store.releaseHolds({ op_id: c.op.op_id, generation: 1 })).released, 1);
  }
  h.clock.advance(3_600_001);

  // The loser pauses after its lookup returned null. The winner claims the
  // identical key and prunes the aged families meanwhile.
  let fired = false;
  let won = null;
  let afterWinner = null;
  const db = {
    ...h.db,
    prepare(sql) {
      const stmt = h.db.prepare(sql);
      const wrap = (s) => ({
        raw: s, sql,
        bind: (...p) => wrap(s.bind(...p)),
        all: (...p) => s.all(...p),
        run: (...p) => s.run(...p),
        async first(...p) {
          const row = await s.first(...p);
          if (!fired && /^SELECT \* FROM dispatch_operations WHERE op_key = \?$/.test(sql)) {
            fired = true;
            won = await h.store.claimOperation({
              op_key: 'race-loser', request_digest: 'sha256:race-loser',
              principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
            });
            afterWinner = rowChanges(h.sqlite);
          }
          return row;
        },
      });
      return wrap(stmt);
    },
  };
  const loser = storeModule.createD1DispatchStore(db, { now: h.clock.now, env });
  const result = await loser.claimOperation({
    op_key: 'race-loser', request_digest: 'sha256:race-loser',
    principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
  });
  assert.equal(fired, true, 'the loser never reached its pre-batch lookup');
  assert.equal(won.claimed, true, 'the winner must claim the key');
  assert.equal(result.claimed, false, 'the loser is a replay, not a second claim');
  assert.equal(result.op.op_id, won.op.op_id);

  // After the winner completed, the loser wrote nothing at all.
  assert.equal(rowChanges(h.sqlite) - afterWinner, 0,
    'the losing claim pruned history or wrote rows on its way to a replay');
  assert.equal(eventRows(h.sqlite), 1, 'only the winning claim may consume quota');
  // The winner pruned exactly one batch; the rest of the eligible history is
  // still there, which is what makes the zero-change assertion meaningful.
  assert.equal(rows(h.sqlite, `SELECT COUNT(*) AS n FROM dispatch_operations
    WHERE principal_id = ? AND op_key LIKE 'race-victim-%'`, alice.principal_id), 2);
});

test('budget: a replay of an aged-out key is a new claim and costs quota, never a second dispatch', async () => {
  const env = {
    INFERENCE_DISPATCH_MAX_OPERATIONS: '4',
    INFERENCE_DISPATCH_MAX_ADMISSIONS: '512',
    INFERENCE_DISPATCH_CLAIMS_PER_WINDOW: '5',
    INFERENCE_DISPATCH_CLAIM_WINDOW_MS: '60000',
    INFERENCE_DISPATCH_RETENTION_MS: '3600000',
  };
  const h = createStoreHarness({ ownerDaily: '0', env });
  const binding = await admissionBinding(h);
  // Spend the first window on a released key and fill it.
  await exhaustedSubmission(h, binding, 'pruned-replay');
  for (let i = 1; i < 5; i += 1) await exhaustedSubmission(h, binding, `pruned-fill-${i}`);
  // Past retention the aged released rows are pruned by the next claims.
  h.clock.advance(3600000 + 1);
  assert.equal((await claim(h, binding, 'after-age-1')).claimed, true);
  assert.equal((await claim(h, binding, 'after-age-2')).claimed, true);
  const gone = await h.store.getOperation({ op_key: 'pruned-replay' });
  assert.equal(gone, null, 'the aged key must be pruned once it is past retention');
  const before = rowChanges(h.sqlite);
  const again = await claim(h, binding, 'pruned-replay');
  assert.equal(again.claimed, true, 'after pruning, the same key is a new operation');
  assert.ok(rowChanges(h.sqlite) > before, 'a new operation is a write, and it costs quota');
});

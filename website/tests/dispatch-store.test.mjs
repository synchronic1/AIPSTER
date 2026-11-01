// Real D1 dispatch store (lane L1) against the node:sqlite D1 shim.
// Failing-first coverage for the contract in
// docs/eif-atomic-admission-contract.md and docs/dispatch-coordinator.md:
// admission issuance/lookup/expiry/visibility, idempotent claims, conservative
// holds, the admission CAS (revoked grant, changed revision/incarnation, missing
// hold, fence), one-time start redemption serialized with revoke, fences,
// lease/complete/read job semantics, settlement exactly once, release only of
// uncharged holds, and accounting that cannot oversubscribe under concurrency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  T0, RES_1, RES_2, alice, bob, createStoreHarness, bindingFor, envelopeFor,
  nextOpKey, admittedOperation, dispatchedOperation, workerResult, coordinatorOverStore, submitBody,
} from './fixtures/dispatch-store-fixture.mjs';
import { ADMISSION_TTL_MS, createD1DispatchStore } from '../src/inference/dispatch-store.mjs';
import { CONTENT_MAX } from '../src/inference/worker-transport.mjs';
import { createDispatchCoordinator } from '../src/inference/dispatch-coordinator.mjs';

const used = (sqlite, id = 'grant-1') => sqlite.prepare(
  'SELECT used_jobs, used_tokens, max_jobs, max_tokens, revoked_at FROM grants WHERE id = ?').get(id);
const ownerPool = (sqlite, poolId) => sqlite.prepare(
  'SELECT * FROM dispatch_pool_usage WHERE pool_id = ?').get(poolId);
const holdRows = (sqlite, opId) => sqlite.prepare(
  'SELECT * FROM dispatch_holds WHERE op_id = ? ORDER BY pool_id').all(opId);

// ---------------------------------------------------------------- admissions

test('issue/lookup: an owner admission is principal-scoped and fully bound', async () => {
  const h = createStoreHarness();
  const a = await h.store.issueAdmission({ principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 128 });
  assert.deepEqual(Object.keys(a).sort(), ['admission_ref', 'expires_at', 'max_tokens', 'model_id']);
  assert.match(a.admission_ref, /^adm_[0-9a-f]{32}$/);
  assert.equal(a.model_id, 'model-x');
  assert.equal(a.max_tokens, 128);
  assert.equal(a.expires_at, T0 + ADMISSION_TTL_MS);

  const rec = await h.store.resolveAdmission({ principal: alice, admission_ref: a.admission_ref });
  assert.equal(rec.principal_id, 'user-alice');
  assert.equal(rec.tenant_id, 'tenant-a');
  assert.equal(rec.grant_id, `owner:${RES_1}`);
  assert.equal(rec.grant_revision, 1);
  assert.equal(rec.resource_id, RES_1);
  assert.equal(rec.incarnation, 'inc-1');
  assert.equal(rec.peer_node, 'node-cpu-1');
  assert.equal(rec.peer_workspace, 'user-alice');
  assert.equal(rec.route, 'internal');
  assert.equal(rec.node_id, RES_1);
  assert.equal(rec.runtime_id, 'ganglion');
  assert.equal(rec.runtime_instance, 'ganglion');
  assert.equal(rec.model_fingerprint, 'model-x');
  assert.deepEqual(rec.pools, [{ pool_id: 'owner:user-alice:2026-03-01', amount: 128 }]);

  // Foreign principals cannot see the admission, and get no admission at all.
  assert.equal(await h.store.resolveAdmission({ principal: bob, admission_ref: a.admission_ref }), null);
  assert.equal(await h.store.resolveAdmission({ principal: { ...alice, tenant_id: 'tenant-z' }, admission_ref: a.admission_ref }), null);
});

test('issue: grant admissions re-derive from live grant terms and refuse non-owners', async () => {
  const h = createStoreHarness();
  const a = await h.store.issueAdmission({
    principal: bob, resource_id: RES_1, model_id: 'model-x', max_tokens: 128, grant: 'grant-1',
  });
  const rec = await h.store.resolveAdmission({ principal: bob, admission_ref: a.admission_ref });
  assert.equal(rec.grant_id, 'grant-1');
  assert.equal(rec.grant_revision, 10 * 10000001 + 1000);
  assert.deepEqual(rec.pools, [{ pool_id: 'grant:grant-1', amount: 128 }]);

  await assert.rejects(
    h.store.issueAdmission({ principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 128, grant: 'grant-1' }),
    (e) => e.status === 403 && e.code === 'NO_MATCHING_GRANT');
  await assert.rejects(
    h.store.issueAdmission({ principal: bob, resource_id: RES_2, model_id: 'model-x', max_tokens: 128 }),
    (e) => e.status === 403 && e.code === 'OWNER_MISMATCH');
  await assert.rejects(
    h.store.issueAdmission({ principal: bob, resource_id: RES_1, model_id: 'model-x', max_tokens: 1001, grant: 'grant-1' }),
    (e) => e.status === 403 && e.code === 'NO_MATCHING_GRANT');
  await assert.rejects(
    h.store.issueAdmission({ principal: bob, resource_id: RES_1, model_id: 'model-x', max_tokens: 0 }),
    (e) => e.status === 400 && e.code === 'INVALID_MAX_TOKENS');
});

test('issue: runtime_id is allowlisted and stored as the instance identity', async () => {
  const h = createStoreHarness();
  const a = await h.store.issueAdmission({
    principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 64, runtime_id: 'llama-server',
  });
  const rec = await h.store.resolveAdmission({ principal: alice, admission_ref: a.admission_ref });
  assert.equal(rec.runtime_id, 'llama-server');
  assert.equal(rec.runtime_instance, 'llama-server');
  assert.equal(rec.model_fingerprint, 'model-x');
  for (const bad of ['llama.cpp', 'GANGLION', 'http://127.0.0.1:8471', '']) {
    await assert.rejects(
      h.store.issueAdmission({ principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 64, runtime_id: bad }),
      (e) => e.status === 400 && e.code === 'BAD_RUNTIME', `accepted runtime ${bad}`);
  }
});

test('issue: refuses a resource that is offline or whose heartbeat is stale', async () => {
  const h = createStoreHarness();
  h.clock.advance(5 * 60 * 1000 + 1);
  await assert.rejects(
    h.store.issueAdmission({ principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 64 }),
    (e) => e.status === 403 && e.code === 'RESOURCE_UNAVAILABLE');
  h.sqlite.prepare('UPDATE resources SET online = 0 WHERE id = ?').run(RES_1);
  await assert.rejects(
    h.store.issueAdmission({ principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 64 }),
    (e) => e.status === 403 && e.code === 'RESOURCE_UNAVAILABLE');
});

// -------------------------------------------------------------------- claims

test('claim: idempotent per principal-scoped key, digest conflict keeps the original op', async () => {
  const h = createStoreHarness();
  const a = await h.store.issueAdmission({ principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 64 });
  const rec = await h.store.resolveAdmission({ principal: alice, admission_ref: a.admission_ref });
  const binding = bindingFor(rec, { principal: alice });
  const key = nextOpKey('claim');
  const first = await h.store.claimOperation({
    op_key: key, request_digest: 'sha256:first', principal_id: alice.principal_id,
    tenant_id: alice.tenant_id, binding,
  });
  assert.equal(first.claimed, true);
  assert.equal(first.op.phase, 'claimed');
  assert.equal(first.op.generation, 1);

  const same = await h.store.claimOperation({
    op_key: key, request_digest: 'sha256:first', principal_id: alice.principal_id,
    tenant_id: alice.tenant_id, binding,
  });
  assert.equal(same.claimed, false);
  assert.equal(same.op.op_id, first.op.op_id);

  const conflict = await h.store.claimOperation({
    op_key: key, request_digest: 'sha256:changed', principal_id: alice.principal_id,
    tenant_id: alice.tenant_id, binding,
  });
  assert.equal(conflict.claimed, false);
  assert.equal(conflict.op.request_digest, 'sha256:first', 'a changed digest does not rewrite the op');

  const found = await h.store.getOperation({ op_key: key });
  assert.equal(found.op_id, first.op.op_id);
  assert.equal(await h.store.getOperation({ op_key: 'missing-key-0000' }), null);
});

test('claim: concurrent claims create exactly one operation', async () => {
  const h = createStoreHarness();
  const a = await h.store.issueAdmission({ principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 64 });
  const rec = await h.store.resolveAdmission({ principal: alice, admission_ref: a.admission_ref });
  const key = nextOpKey('race');
  const calls = await Promise.all(Array.from({ length: 5 }, () => h.store.claimOperation({
    op_key: key, request_digest: 'sha256:race', principal_id: alice.principal_id,
    tenant_id: alice.tenant_id, binding: bindingFor(rec, { principal: alice }),
  })));
  assert.equal(calls.filter((c) => c.claimed).length, 1);
  assert.equal(new Set(calls.map((c) => c.op.op_id)).size, 1);
});

test('claim: rejects a binding that does not belong to the claiming principal', async () => {
  const h = createStoreHarness();
  const a = await h.store.issueAdmission({ principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 64 });
  const rec = await h.store.resolveAdmission({ principal: alice, admission_ref: a.admission_ref });
  await assert.rejects(h.store.claimOperation({
    op_key: nextOpKey('bad'), request_digest: 'sha256:x', principal_id: bob.principal_id,
    tenant_id: bob.tenant_id, binding: bindingFor(rec, { principal: alice }),
  }), (e) => e.status === 400 && e.code === 'INVALID_BINDING');
});

// --------------------------------------------------------------------- holds

test('holds: charge at hold, idempotent per pool, release refunds exactly once', async () => {
  const h = createStoreHarness();
  const flow = await admittedOperation(h, { principal: bob, grant: 'grant-1' });
  assert.equal(flow.admitted.outcome, 'admitted');
  assert.equal(used(h.sqlite).used_tokens, 128);
  assert.equal(used(h.sqlite).used_jobs, 1);
  assert.equal(holdRows(h.sqlite, flow.op.op_id)[0].state, 'committed');

  // Acquiring the same (op, pool) again is idempotent and never re-charges.
  const again = await h.store.acquireHold({
    op_id: flow.op.op_id, generation: 1, pool_id: 'grant:grant-1', amount: 128,
  });
  assert.equal(again.held, true);
  assert.equal(again.hold_id, flow.holdIds[0]);
  assert.equal(used(h.sqlite).used_tokens, 128);

  const released = await h.store.releaseHolds({ op_id: flow.op.op_id, generation: 1 });
  assert.equal(released.released, 0, 'an admitted, unfenced start is still redeemable');
  assert.equal(used(h.sqlite).used_tokens, 128);
});

test('holds: a claimed operation releases its hold and the counters return to zero', async () => {
  const h = createStoreHarness();
  const a = await h.store.issueAdmission({ principal: bob, resource_id: RES_1, model_id: 'model-x', max_tokens: 128, grant: 'grant-1' });
  const rec = await h.store.resolveAdmission({ principal: bob, admission_ref: a.admission_ref });
  const claim = await h.store.claimOperation({
    op_key: nextOpKey('rel'), request_digest: 'sha256:r', principal_id: bob.principal_id,
    tenant_id: bob.tenant_id, binding: bindingFor(rec, { principal: bob }),
  });
  const hold = await h.store.acquireHold({ op_id: claim.op.op_id, generation: 1, pool_id: 'grant:grant-1', amount: 128 });
  assert.equal(hold.held, true);
  assert.equal(used(h.sqlite).used_tokens, 128);

  assert.deepEqual(await h.store.releaseHolds({ op_id: claim.op.op_id, generation: 1 }), { released: 1 });
  assert.equal(used(h.sqlite).used_tokens, 0);
  assert.equal(used(h.sqlite).used_jobs, 0);
  assert.equal(holdRows(h.sqlite, claim.op.op_id)[0].state, 'released');
  // A second release must not refund again or drive the counter negative.
  assert.deepEqual(await h.store.releaseHolds({ op_id: claim.op.op_id, generation: 1 }), { released: 0 });
  assert.equal(used(h.sqlite).used_tokens, 0);
});

test('holds: insufficient grant budget compensates and never oversubscribes', async () => {
  const h = createStoreHarness();
  h.sqlite.prepare('UPDATE grants SET max_jobs = 2, max_tokens = 200 WHERE id = ?').run('grant-1');
  const first = await admittedOperation(h, { principal: bob, grant: 'grant-1' });
  assert.equal(first.admitted.outcome, 'admitted');
  assert.equal(used(h.sqlite).used_tokens, 128);

  const admissions = [];
  for (let i = 0; i < 2; i += 1) {
    admissions.push(await h.store.issueAdmission({
      principal: bob, resource_id: RES_1, model_id: 'model-x', max_tokens: 128, grant: 'grant-1',
    }));
  }
  for (const a of admissions) {
    const rec = await h.store.resolveAdmission({ principal: bob, admission_ref: a.admission_ref });
    const claim = await h.store.claimOperation({
      op_key: nextOpKey('budget'), request_digest: 'sha256:b', principal_id: bob.principal_id,
      tenant_id: bob.tenant_id, binding: bindingFor(rec, { principal: bob }),
    });
    const hold = await h.store.acquireHold({ op_id: claim.op.op_id, generation: 1, pool_id: 'grant:grant-1', amount: 128 });
    assert.equal(hold.held, false);
    assert.equal(used(h.sqlite).used_tokens, 128);
    assert.equal(used(h.sqlite).used_jobs, 1);
    // The compensation path the coordinator takes after a failed hold.
    await h.store.releaseHolds({ op_id: claim.op.op_id, generation: 1, reason: 'budget_exhausted' });
    assert.equal(used(h.sqlite).used_tokens, 128);
  }
});

test('holds: the grant job ceiling is enforced independently of tokens', async () => {
  const h = createStoreHarness();
  h.sqlite.prepare('UPDATE grants SET max_jobs = 1, max_tokens = 1000 WHERE id = ?').run('grant-1');
  const one = await admittedOperation(h, { principal: bob, grant: 'grant-1' });
  assert.equal(one.admitted.outcome, 'admitted');
  const a = await h.store.issueAdmission({ principal: bob, resource_id: RES_1, model_id: 'model-x', max_tokens: 64, grant: 'grant-1' });
  const rec = await h.store.resolveAdmission({ principal: bob, admission_ref: a.admission_ref });
  const claim = await h.store.claimOperation({
    op_key: nextOpKey('jobs'), request_digest: 'sha256:j', principal_id: bob.principal_id,
    tenant_id: bob.tenant_id, binding: bindingFor(rec, { principal: bob }),
  });
  const hold = await h.store.acquireHold({ op_id: claim.op.op_id, generation: 1, pool_id: 'grant:grant-1', amount: 64 });
  assert.equal(hold.held, false, 'the one-job ceiling is already charged');
  assert.equal(used(h.sqlite).used_tokens, 128);
});

test('holds: owner daily pool uses INFERENCE_OWNER_DAILY_TOKENS and fails closed', async () => {
  for (const ownerDaily of [null, 'not-a-number', '-1', '0', '100']) {
    const h = createStoreHarness({ ownerDaily });
    const flow = await admittedOperation(h, { principal: alice, max_tokens: 128 });
    assert.equal(flow.admitted.held, false, `ownerDaily=${ownerDaily} must not admit`);
    const pool = ownerPool(h.sqlite, 'owner:user-alice:2026-03-01');
    if (pool) assert.equal(pool.used_tokens, 0);
    await h.store.releaseHolds({ op_id: flow.op.op_id, generation: 1 });
    if (pool) assert.equal(ownerPool(h.sqlite, 'owner:user-alice:2026-03-01').used_tokens, 0);
  }
  const ok = createStoreHarness({ ownerDaily: '256' });
  const flow = await admittedOperation(ok, { principal: alice, max_tokens: 128 });
  assert.equal(flow.admitted.outcome, 'admitted');
  assert.equal(ownerPool(ok.sqlite, 'owner:user-alice:2026-03-01').used_tokens, 128);
});

test('holds: concurrent callers cannot exceed a grant ceiling', async () => {
  const h = createStoreHarness();
  h.sqlite.prepare('UPDATE grants SET max_jobs = 5, max_tokens = 200 WHERE id = ?').run('grant-1');
  const flows = await Promise.all(Array.from({ length: 3 }, (_, i) => admittedOperation(h, {
    principal: bob, grant: 'grant-1', max_tokens: 128, op_key: `concurrent-${i}-key`,
  })));
  const admitted = flows.filter((f) => f.admitted && f.admitted.outcome === 'admitted');
  assert.equal(admitted.length, 1);
  assert.equal(used(h.sqlite).used_tokens, 128);
  assert.equal(used(h.sqlite).used_jobs, 1);
  const winner = admitted[0];
  for (const f of flows.filter((x) => x !== winner)) {
    await h.store.releaseHolds({ op_id: f.op.op_id, generation: 1 });
  }
  assert.equal(used(h.sqlite).used_tokens, 128, 'an admitted start is still redeemable and keeps its charge');
  await h.store.fenceStart({ op_id: winner.op.op_id, generation: 1 });
  assert.deepEqual(await h.store.releaseHolds({ op_id: winner.op.op_id, generation: 1 }), { released: 1 });
  assert.equal(used(h.sqlite).used_tokens, 0);
  assert.equal(used(h.sqlite).used_jobs, 0);
});

test('holds: concurrent callers cannot exceed the owner daily ceiling', async () => {
  const h = createStoreHarness({ ownerDaily: '200' });
  const flows = await Promise.all(Array.from({ length: 3 }, (_, i) => admittedOperation(h, {
    principal: alice, max_tokens: 128, op_key: `owner-race-${i}-key`,
  })));
  const admitted = flows.filter((f) => f.admitted && f.admitted.outcome === 'admitted');
  assert.equal(admitted.length, 1);
  const pool = ownerPool(h.sqlite, 'owner:user-alice:2026-03-01');
  assert.equal(pool.used_tokens, 128);
  assert.ok(pool.used_tokens <= pool.ceiling_tokens);
  const winner = admitted[0];
  for (const f of flows.filter((x) => x !== winner)) {
    await h.store.releaseHolds({ op_id: f.op.op_id, generation: 1 });
  }
  assert.equal(ownerPool(h.sqlite, 'owner:user-alice:2026-03-01').used_tokens, 128);
  await h.store.fenceStart({ op_id: winner.op.op_id, generation: 1 });
  await h.store.releaseHolds({ op_id: winner.op.op_id, generation: 1 });
  assert.equal(ownerPool(h.sqlite, 'owner:user-alice:2026-03-01').used_tokens, 0);
});

// Finding 4437293864 (P1): acquireHold reads the operation, then writes. A
// cancellation that fences and releases in that window must not let the hold
// insert (or its budget charge) land. Two store instances over one database
// model the two HTTP requests; the racing batch runs the cancel first.
async function claimForCancelledRace(h, { principal = bob, grant = 'grant-1' } = {}) {
  const a = await h.store.issueAdmission({
    principal, resource_id: RES_1, model_id: 'model-x', max_tokens: 128, ...(grant ? { grant } : {}),
  });
  const rec = await h.store.resolveAdmission({ principal, admission_ref: a.admission_ref });
  const claim = await h.store.claimOperation({
    op_key: nextOpKey('cancel-race'), request_digest: 'sha256:cancel-race',
    principal_id: principal.principal_id, tenant_id: principal.tenant_id,
    binding: bindingFor(rec, { principal }),
  });
  return { admission: a, rec, claim };
}

function racingStore(h, cancel) {
  const other = createD1DispatchStore(h.db, {
    now: h.clock.now, env: { INFERENCE_OWNER_DAILY_TOKENS: '10000' },
  });
  let injected = false;
  const racingDb = {
    prepare: (...args) => h.db.prepare(...args),
    batch: async (stmts) => {
      if (!injected) {
        injected = true;
        await cancel(other);
      }
      return h.db.batch(stmts);
    },
  };
  return createD1DispatchStore(racingDb, {
    now: h.clock.now, env: { INFERENCE_OWNER_DAILY_TOKENS: '10000' },
  });
}

test('holds: a cancel racing a grant hold cannot charge or leave an orphan hold', async () => {
  const h = createStoreHarness();
  const { claim } = await claimForCancelledRace(h);
  const store = racingStore(h, async (other) => {
    assert.deepEqual(await other.fenceStart({ op_id: claim.op.op_id, generation: 1, reason: 'cancel' }),
      { outcome: 'fenced' });
    assert.deepEqual(await other.releaseHolds({ op_id: claim.op.op_id, generation: 1, reason: 'cancel' }),
      { released: 0 });
  });

  const hold = await store.acquireHold({
    op_id: claim.op.op_id, generation: 1, pool_id: 'grant:grant-1', amount: 128,
  });
  assert.deepEqual(hold, { held: false, reason: 'fenced' });
  const states = holdRows(h.sqlite, claim.op.op_id);
  assert.deepEqual(states, [], 'no orphaned hold row');
  assert.equal(used(h.sqlite).used_tokens, 0, 'no orphaned token charge');
  assert.equal(used(h.sqlite).used_jobs, 0, 'no orphaned job charge');
  assert.equal(h.sqlite.prepare('SELECT phase FROM dispatch_operations WHERE op_id = ?')
    .get(claim.op.op_id).phase, 'released');
});

test('holds: a cancel racing an owner hold cannot charge or leave an orphan hold', async () => {
  const h = createStoreHarness({ ownerDaily: '10000' });
  const { claim } = await claimForCancelledRace(h, { principal: alice, grant: null });
  const poolId = 'owner:user-alice:2026-03-01';
  const store = racingStore(h, async (other) => {
    assert.deepEqual(await other.fenceStart({ op_id: claim.op.op_id, generation: 1, reason: 'cancel' }),
      { outcome: 'fenced' });
    assert.deepEqual(await other.releaseHolds({ op_id: claim.op.op_id, generation: 1, reason: 'cancel' }),
      { released: 0 });
  });

  const hold = await store.acquireHold({ op_id: claim.op.op_id, generation: 1, pool_id: poolId, amount: 128 });
  assert.deepEqual(hold, { held: false, reason: 'fenced' });
  assert.deepEqual(holdRows(h.sqlite, claim.op.op_id), [], 'no orphaned hold row');
  const pool = ownerPool(h.sqlite, poolId);
  if (pool) assert.equal(pool.used_tokens, 0, 'no orphaned token charge');
  assert.ok(!pool || pool.used_tokens <= pool.ceiling_tokens, 'accounting stays inside the ceiling');
  assert.equal(h.sqlite.prepare('SELECT phase FROM dispatch_operations WHERE op_id = ?')
    .get(claim.op.op_id).phase, 'released');
});

// ----------------------------------------------------------- admission CAS

test('admit: refuses after the grant is revoked and leaves holds/counters untouched', async () => {
  const h = createStoreHarness();
  const a = await h.store.issueAdmission({ principal: bob, resource_id: RES_1, model_id: 'model-x', max_tokens: 128, grant: 'grant-1' });
  const rec = await h.store.resolveAdmission({ principal: bob, admission_ref: a.admission_ref });
  const binding = bindingFor(rec, { principal: bob });
  const claim = await h.store.claimOperation({
    op_key: nextOpKey('revoke'), request_digest: 'sha256:v', principal_id: bob.principal_id,
    tenant_id: bob.tenant_id, binding,
  });
  const hold = await h.store.acquireHold({ op_id: claim.op.op_id, generation: 1, pool_id: 'grant:grant-1', amount: 128 });
  h.sqlite.prepare('UPDATE grants SET revoked_at = ? WHERE id = ?').run(new Date(T0 + 1000).toISOString(), 'grant-1');

  const out = await h.store.admit({
    op_id: claim.op.op_id, generation: 1, holds: [hold.hold_id],
    authority: { grant_id: binding.grant_id, grant_revision: binding.grant_revision, incarnation: binding.incarnation },
  });
  assert.deepEqual(out, { outcome: 'rejected', reason: 'revoked' });
  assert.equal((await h.store.getOperation({ op_key: claim.op.op_key })).phase, 'holding');
  assert.equal(holdRows(h.sqlite, claim.op.op_id)[0].state, 'held');
  assert.equal(used(h.sqlite).used_tokens, 128);

  assert.equal((await h.store.releaseHolds({ op_id: claim.op.op_id, generation: 1 })).released, 1);
  assert.equal(used(h.sqlite).used_tokens, 0);
});

test('admit: refuses when the granted terms change after issuance', async () => {
  const h = createStoreHarness();
  const a = await h.store.issueAdmission({ principal: bob, resource_id: RES_1, model_id: 'model-x', max_tokens: 128, grant: 'grant-1' });
  const rec = await h.store.resolveAdmission({ principal: bob, admission_ref: a.admission_ref });
  const binding = bindingFor(rec, { principal: bob });
  const claim = await h.store.claimOperation({
    op_key: nextOpKey('terms'), request_digest: 'sha256:t', principal_id: bob.principal_id,
    tenant_id: bob.tenant_id, binding,
  });
  const hold = await h.store.acquireHold({ op_id: claim.op.op_id, generation: 1, pool_id: 'grant:grant-1', amount: 128 });
  h.sqlite.prepare('UPDATE grants SET max_tokens = max_tokens + 1 WHERE id = ?').run('grant-1');

  const out = await h.store.admit({
    op_id: claim.op.op_id, generation: 1, holds: [hold.hold_id],
    authority: { grant_id: binding.grant_id, grant_revision: binding.grant_revision, incarnation: binding.incarnation },
  });
  assert.equal(out.outcome, 'rejected');
  assert.equal(out.reason, 'authority_changed');
  assert.equal((await h.store.getOperation({ op_key: claim.op.op_key })).phase, 'holding');
  await h.store.releaseHolds({ op_id: claim.op.op_id, generation: 1 });
  assert.equal(used(h.sqlite).used_tokens, 0);
});

test('admit: refuses when the resource incarnation changes', async () => {
  const h = createStoreHarness();
  const a = await h.store.issueAdmission({ principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 128 });
  const rec = await h.store.resolveAdmission({ principal: alice, admission_ref: a.admission_ref });
  const binding = bindingFor(rec, { principal: alice });
  const claim = await h.store.claimOperation({
    op_key: nextOpKey('inc'), request_digest: 'sha256:i', principal_id: alice.principal_id,
    tenant_id: alice.tenant_id, binding,
  });
  const hold = await h.store.acquireHold({
    op_id: claim.op.op_id, generation: 1, pool_id: binding.pools[0].pool_id, amount: 128,
  });
  h.sqlite.prepare('UPDATE resources SET incarnation = ? WHERE id = ?').run('inc-2', RES_1);
  const out = await h.store.admit({
    op_id: claim.op.op_id, generation: 1, holds: [hold.hold_id],
    authority: { grant_id: binding.grant_id, grant_revision: binding.grant_revision, incarnation: binding.incarnation },
  });
  assert.deepEqual(out, { outcome: 'rejected', reason: 'authority_changed' });
});

test('admit: refuses a missing or foreign hold set and a fenced operation', async () => {
  const h = createStoreHarness();
  const flow = await admittedOperation(h, { principal: alice, max_tokens: 64 });
  assert.equal(flow.admitted.outcome, 'admitted');

  const second = await admittedOperation(h, { principal: alice, max_tokens: 64 });
  const op = await h.store.getOperation({ op_key: flow.op.op_key });
  assert.ok(op);

  // Missing holds: rejected before any write, the operation stays admitted.
  const missing = await h.store.admit({
    op_id: flow.op.op_id, generation: 1, holds: [],
    authority: { grant_id: flow.binding.grant_id, grant_revision: flow.binding.grant_revision, incarnation: flow.binding.incarnation },
  });
  assert.deepEqual(missing, { outcome: 'rejected', reason: 'holds_mismatch' });
  assert.equal((await h.store.getOperation({ op_key: flow.op.op_key })).phase, 'admitted');

  // Re-admitting an admitted operation is idempotent.
  const replay = await h.store.admit({
    op_id: flow.op.op_id, generation: 1, holds: flow.holdIds,
    authority: { grant_id: flow.binding.grant_id, grant_revision: flow.binding.grant_revision, incarnation: flow.binding.incarnation },
  });
  assert.deepEqual(replay, { outcome: 'admitted' });

  // A fenced admission candidate never commits.
  const a = await h.store.issueAdmission({ principal: alice, resource_id: RES_2, model_id: 'model-x', max_tokens: 64 });
  const rec = await h.store.resolveAdmission({ principal: alice, admission_ref: a.admission_ref });
  const binding = bindingFor(rec, { principal: alice });
  const claim = await h.store.claimOperation({
    op_key: nextOpKey('fence-admit'), request_digest: 'sha256:f', principal_id: alice.principal_id,
    tenant_id: alice.tenant_id, binding,
  });
  const hold = await h.store.acquireHold({ op_id: claim.op.op_id, generation: 1, pool_id: binding.pools[0].pool_id, amount: 64 });
  assert.equal(hold.held, true);
  assert.deepEqual(await h.store.fenceStart({ op_id: claim.op.op_id, generation: 1 }), { outcome: 'fenced' });
  const fenced = await h.store.admit({
    op_id: claim.op.op_id, generation: 1, holds: [hold.hold_id],
    authority: { grant_id: binding.grant_id, grant_revision: binding.grant_revision, incarnation: binding.incarnation },
  });
  assert.deepEqual(fenced, { outcome: 'rejected', reason: 'fenced' });
  assert.equal((await h.store.getOperation({ op_key: claim.op.op_key })).phase, 'holding');
  assert.equal((await h.store.acquireHold({ op_id: claim.op.op_id, generation: 1, pool_id: binding.pools[0].pool_id, amount: 64 })).held, false);
  assert.equal((await h.store.releaseHolds({ op_id: claim.op.op_id, generation: 1 })).released, 1);
  assert.equal(second.admitted.outcome, 'admitted');
});

// ------------------------------------------------------- start / redemption

test('redeem: one-time, idempotent, worker-bound, and serialized with revoke', async () => {
  const h = createStoreHarness();
  const flow = await admittedOperation(h, { principal: bob, grant: 'grant-1' });
  const worker = { node_id: flow.binding.node_id, runtime_instance: flow.binding.runtime_instance };

  const wrong = await h.store.redeemStart({ op_id: flow.op.op_id, generation: 1, worker: { ...worker, runtime_instance: 'llama-server' } });
  assert.deepEqual(wrong, { outcome: 'refused', reason: 'worker_mismatch' });
  assert.equal((await h.store.getOperation({ op_key: flow.op.op_key })).phase, 'admitted');

  assert.deepEqual(await h.store.redeemStart({ op_id: flow.op.op_id, generation: 1, worker }), { outcome: 'redeemed' });
  assert.deepEqual(await h.store.redeemStart({ op_id: flow.op.op_id, generation: 1, worker }), { outcome: 'redeemed' });
  const redemptions = h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_start_redemptions WHERE op_id = ?').get(flow.op.op_id);
  assert.equal(redemptions.n, 1, 'exactly one start permit');

  // Revoke before redemption refuses the start and keeps the holds intact.
  const blocked = await admittedOperation(h, { principal: bob, grant: 'grant-1' });
  h.sqlite.prepare('UPDATE grants SET revoked_at = ? WHERE id = ?').run(new Date(T0 + 1000).toISOString(), 'grant-1');
  const refused = await h.store.redeemStart({
    op_id: blocked.op.op_id, generation: 1,
    worker: { node_id: blocked.binding.node_id, runtime_instance: blocked.binding.runtime_instance },
  });
  assert.deepEqual(refused, { outcome: 'refused', reason: 'revoked' });
  assert.equal((await h.store.getOperation({ op_key: blocked.op.op_key })).phase, 'admitted');
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_start_redemptions WHERE op_id = ?').get(blocked.op.op_id).n, 0);

  // A fenced start is fenced, and the release path still works.
  const fenced = await admittedOperation(h, { principal: alice, max_tokens: 32 });
  await h.store.fenceStart({ op_id: fenced.op.op_id, generation: 1 });
  const fencedRedeem = await h.store.redeemStart({
    op_id: fenced.op.op_id, generation: 1,
    worker: { node_id: fenced.binding.node_id, runtime_instance: fenced.binding.runtime_instance },
  });
  assert.deepEqual(fencedRedeem, { outcome: 'refused', reason: 'fenced' });
  assert.equal((await h.store.releaseHolds({ op_id: fenced.op.op_id, generation: 1 })).released, 1);
});

test('fence: reports already_redeemed after a start and fenced before one', async () => {
  const h = createStoreHarness();
  const done = await dispatchedOperation(h, { principal: alice, max_tokens: 32 });
  assert.deepEqual(await h.store.fenceStart({ op_id: done.op.op_id, generation: 1 }), { outcome: 'already_redeemed' });
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_fences WHERE op_id = ?').get(done.op.op_id).n, 0);

  const admitted = await admittedOperation(h, { principal: alice, max_tokens: 32, op_key: nextOpKey('fence2') });
  assert.deepEqual(await h.store.fenceStart({ op_id: admitted.op.op_id, generation: 1 }), { outcome: 'fenced' });
  assert.deepEqual(await h.store.fenceStart({ op_id: admitted.op.op_id, generation: 1 }), { outcome: 'fenced' });
  assert.equal((await h.store.redeemStart({
    op_id: admitted.op.op_id, generation: 1,
    worker: { node_id: admitted.binding.node_id, runtime_instance: admitted.binding.runtime_instance },
  })).reason, 'fenced');
});

// --------------------------------------------------------------------- jobs

test('enqueue/lease: stores the nested envelope verbatim and leases one at a time for the right resource', async () => {
  const h = createStoreHarness();
  const job = await dispatchedOperation(h);
  const frame = await h.store.leaseNextJob({ resource_id: RES_1 });
  assert.equal(frame.job_id, job.job_id);
  assert.equal(typeof frame.lease_id, 'string');
  assert.ok(frame.lease_id.startsWith('lease_'));
  assert.equal(frame.deadline_at, job.binding.deadline_at);
  assert.deepEqual(frame.envelope, job.envelope, 'the envelope round-trips verbatim');
  assert.equal(frame.envelope.binding.op_id, job.op.op_id);
  assert.equal(frame.envelope.binding.generation, 1);
  assert.equal(frame.envelope.binding.deadline_at, frame.deadline_at);
  assert.equal(frame.envelope.task.placement.node_id, RES_1);

  assert.equal(await h.store.leaseNextJob({ resource_id: RES_1 }), null, 'a leased job is not leased twice');
  assert.equal(await h.store.leaseNextJob({ resource_id: RES_2 }), null, 'only the matching resource leases it');

  // A second queued job for the same resource leases separately.
  const job2 = await dispatchedOperation(h, { op_key: nextOpKey('second') });
  const frame2 = await h.store.leaseNextJob({ resource_id: RES_1 });
  assert.equal(frame2.job_id, job2.job_id);
  assert.notEqual(frame2.lease_id, frame.lease_id);

  // Complete once; a duplicate or foreign lease is refused.
  assert.deepEqual(await h.store.completeJob({
    job_id: frame.job_id, lease_id: frame.lease_id, resource_id: RES_1, status: 'succeeded',
    result: workerResult(frame),
  }), { accepted: true });
  assert.deepEqual(await h.store.completeJob({
    job_id: frame.job_id, lease_id: frame.lease_id, resource_id: RES_1, status: 'succeeded',
    result: workerResult(frame),
  }), { accepted: false, reason: 'already_completed' });
  assert.deepEqual(await h.store.completeJob({
    job_id: frame2.job_id, lease_id: 'lease_bogus', resource_id: RES_1, status: 'succeeded',
    result: workerResult(frame2),
  }), { accepted: false, reason: 'wrong_lease' });
  assert.deepEqual(await h.store.completeJob({
    job_id: frame2.job_id, lease_id: frame2.lease_id, resource_id: RES_2, status: 'succeeded',
    result: workerResult(frame2),
  }), { accepted: false, reason: 'wrong_resource' });
});

test('enqueue: idempotent per operation and refuses unredeemed or mismatched envelopes', async () => {
  const h = createStoreHarness();
  const flow = await admittedOperation(h);
  const unredeemed = envelopeFor(flow.resolved, flow.binding);
  assert.deepEqual(await h.store.enqueueJob(unredeemed), { accepted: false, reason: 'not_redeemed' });

  assert.equal((await h.store.redeemStart({
    op_id: flow.op.op_id, generation: 1,
    worker: { node_id: flow.binding.node_id, runtime_instance: flow.binding.runtime_instance },
  })).outcome, 'redeemed');

  const envelope = envelopeFor(flow.resolved, flow.binding);
  const one = await h.store.enqueueJob(envelope);
  assert.equal(one.accepted, true);
  const two = await h.store.enqueueJob(envelope);
  assert.deepEqual(two, one, 'a lost-response replay returns the same job id');
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs WHERE op_id = ?').get(flow.op.op_id).n, 1);

  const foreign = {
    ...envelope,
    binding: { ...envelope.binding, model_fingerprint: 'other-fingerprint' },
  };
  assert.deepEqual(await h.store.enqueueJob(foreign), { accepted: false, reason: 'binding_mismatch' });
  assert.deepEqual(await h.store.enqueueJob({ ...envelope, protocol: 'other/1' }), { accepted: false, reason: 'invalid_envelope' });
});

test('lease: requires a redeemed, unfenced, certain operation and an unexpired deadline', async () => {
  const h = createStoreHarness();

  // Manually queue a job for an operation that is only admitted: not leasable.
  const flow = await admittedOperation(h);
  await h.store.redeemStart({
    op_id: flow.op.op_id, generation: 1,
    worker: { node_id: flow.binding.node_id, runtime_instance: flow.binding.runtime_instance },
  });
  const envelope = envelopeFor(flow.resolved, flow.binding);
  const queued = await h.store.enqueueJob(envelope);
  assert.equal(queued.accepted, true);

  // Fence after enqueue (a tombstone can only be written before a start in the
  // coordinator, so write it directly here).
  h.sqlite.prepare('INSERT INTO dispatch_fences (op_id, generation, fenced_at, reason) VALUES (?, 1, ?, ?)')
    .run(flow.op.op_id, new Date(T0).toISOString(), 'synthetic');
  assert.equal(await h.store.leaseNextJob({ resource_id: RES_1 }), null, 'fenced work is not leased');
  h.sqlite.prepare('DELETE FROM dispatch_fences WHERE op_id = ?').run(flow.op.op_id);

  // Uncertain operations are not leased.
  await h.store.markUncertain({ op_id: flow.op.op_id, generation: 1, phase: 'result', detail: 'synthetic' });
  assert.equal(await h.store.leaseNextJob({ resource_id: RES_1 }), null, 'uncertain work is not leased');
  assert.equal((await h.store.completeJob({
    job_id: queued.job_id, lease_id: 'lease_none', resource_id: RES_1, status: 'failed', result: { reason: 'X' },
  })).accepted, false);

  // Deadline: the same job leases before it and not after it.
  const h2 = createStoreHarness();
  const job = await dispatchedOperation(h2);
  h2.clock.advance(job.binding.deadline_at - T0 - 1);
  assert.ok(await h2.store.leaseNextJob({ resource_id: RES_1 }), 'leases just before the deadline');
  const h3 = createStoreHarness();
  const job3 = await dispatchedOperation(h3);
  h3.clock.advance(job3.binding.deadline_at - T0 + 1);
  assert.equal(await h3.store.leaseNextJob({ resource_id: RES_1 }), null, 'expired work is not leased');
  assert.equal((await h3.store.completeJob({
    job_id: job3.job_id, lease_id: 'lease_none', resource_id: RES_1, status: 'failed', result: { reason: 'LATE' },
  })).reason, 'wrong_lease');
});

test('lease: concurrent leases hand out each queued job exactly once', async () => {
  const h = createStoreHarness({ ownerDaily: '100000' });
  const jobs = [];
  for (let i = 0; i < 3; i += 1) {
    jobs.push(await dispatchedOperation(h, { op_key: nextOpKey(`lease-race-${i}`) }));
  }
  const frames = (await Promise.all(Array.from({ length: 8 }, () => h.store.leaseNextJob({ resource_id: RES_1 }))))
    .filter(Boolean);
  assert.equal(frames.length, 3);
  assert.equal(new Set(frames.map((f) => f.job_id)).size, 3);
  assert.equal(new Set(frames.map((f) => f.lease_id)).size, 3);
  assert.deepEqual(new Set(frames.map((f) => f.job_id)), new Set(jobs.map((j) => j.job_id)));
  assert.equal(await h.store.leaseNextJob({ resource_id: RES_1 }), null);
});

test('complete: validates the exact result shape and the instance/fingerprint binding', async () => {
  const h = createStoreHarness();
  const job = await dispatchedOperation(h);
  const frame = await h.store.leaseNextJob({ resource_id: RES_1 });

  const base = {
    job_id: frame.job_id, lease_id: frame.lease_id, resource_id: RES_1, status: 'succeeded',
  };
  const bad = [
    { result: workerResult(frame, { simulated: true }) },
    { result: workerResult(frame, { content: '   ' }) },
    { result: workerResult(frame, { request_id: 'job_someone-else' }) },
    { result: workerResult(frame, { runtime_instance: 'llama-server' }) },
    { result: workerResult(frame, { model_fingerprint: 'other' }) },
    { result: workerResult(frame, { extra: 'not allowed' }) },
    { result: { ...workerResult(frame), content: undefined } },
    { result: null },
  ];
  for (const override of bad) {
    const out = await h.store.completeJob({ ...base, ...override });
    assert.equal(out.accepted, false, `accepted ${JSON.stringify(override)}`);
    assert.ok(['invalid_result', 'result_mismatch', 'simulated_result'].includes(out.reason), out.reason);
  }
  assert.equal((await h.store.completeJob({ ...base, status: 'unknown', result: workerResult(frame) })).reason, 'invalid_status');

  // A failed result uses the failed key set and carries no content.
  assert.deepEqual(await h.store.completeJob({ ...base, status: 'failed', result: { reason: 'MODEL_UNAVAILABLE', detail: 'no model' } }), { accepted: true });
  assert.deepEqual(await h.store.completeJob({ ...base, status: 'failed', result: { reason: 'AGAIN' } }), { accepted: false, reason: 'already_completed' });

  const read = await h.store.readJob({ job_id: job.job_id });
  assert.deepEqual(read, {
    id: job.job_id, node_id: RES_1, runtime_id: 'ganglion', model_id: 'model-x', status: 'failed',
    result: { reason: 'MODEL_UNAVAILABLE', detail: 'no model' },
  });
});

// Finding 4437293854 (P1): result content was validated with the default
// 256-char identifier limit, so ordinary completions were rejected as
// RESULT_REJECTED while the HTTP validator accepted them.
test('complete: accepts real completion content up to the shared transport limit', async () => {
  const h = createStoreHarness();
  const job = await dispatchedOperation(h);
  const frame = await h.store.leaseNextJob({ resource_id: RES_1 });
  const base = { job_id: frame.job_id, lease_id: frame.lease_id, resource_id: RES_1, status: 'succeeded' };

  const longer = `hello ${'world '.repeat(200)}`; // well past the 256-char default
  assert.ok(longer.length > 256 && longer.length <= CONTENT_MAX);
  assert.deepEqual(await h.store.completeJob({ ...base, result: workerResult(frame, { content: longer }) }),
    { accepted: true });
  assert.equal((await h.store.readJob({ job_id: job.job_id })).result.content, longer);

  // The cap is the transport's CONTENT_MAX, not an arbitrary larger body cap.
  const exact = 'x'.repeat(CONTENT_MAX);
  const h2 = createStoreHarness();
  const job2 = await dispatchedOperation(h2);
  const frame2 = await h2.store.leaseNextJob({ resource_id: RES_1 });
  const base2 = { job_id: frame2.job_id, lease_id: frame2.lease_id, resource_id: RES_1, status: 'succeeded' };
  assert.deepEqual(await h2.store.completeJob({ ...base2, result: workerResult(frame2, { content: exact }) }),
    { accepted: true });

  const h3 = createStoreHarness();
  const job3 = await dispatchedOperation(h3);
  const frame3 = await h3.store.leaseNextJob({ resource_id: RES_1 });
  const over = await h3.store.completeJob({
    job_id: frame3.job_id, lease_id: frame3.lease_id, resource_id: RES_1, status: 'succeeded',
    result: workerResult(frame3, { content: 'x'.repeat(CONTENT_MAX + 1) }),
  });
  assert.deepEqual(over, { accepted: false, reason: 'invalid_result' });
});

test('readJob: queued/leased are running; a completed job carries the worker result', async () => {
  const h = createStoreHarness();
  const job = await dispatchedOperation(h);
  assert.deepEqual(await h.store.readJob({ job_id: job.job_id }), {
    id: job.job_id, node_id: RES_1, runtime_id: 'ganglion', model_id: 'model-x', status: 'running', result: null,
  });
  const frame = await h.store.leaseNextJob({ resource_id: RES_1 });
  assert.equal((await h.store.readJob({ job_id: job.job_id })).status, 'running');
  const result = workerResult(frame);
  assert.deepEqual(await h.store.completeJob({
    job_id: frame.job_id, lease_id: frame.lease_id, resource_id: RES_1, status: 'succeeded', result,
  }), { accepted: true });
  const read = await h.store.readJob({ job_id: job.job_id });
  assert.equal(read.status, 'succeeded');
  assert.deepEqual(read.result, result);
  assert.equal(await h.store.readJob({ job_id: 'job_missing' }), null);
});

test('complete: a late result after the deadline changes nothing', async () => {
  const h = createStoreHarness();
  const job = await dispatchedOperation(h);
  const frame = await h.store.leaseNextJob({ resource_id: RES_1 });
  h.clock.advance(job.binding.deadline_at - T0 + 1);
  assert.deepEqual(await h.store.completeJob({
    job_id: frame.job_id, lease_id: frame.lease_id, resource_id: RES_1, status: 'succeeded',
    result: workerResult(frame),
  }), { accepted: false, reason: 'late' });
  const row = h.sqlite.prepare('SELECT status, result_json FROM dispatch_jobs WHERE job_id = ?').get(frame.job_id);
  assert.equal(row.status, 'leased');
  assert.equal(row.result_json, null);
});

// ------------------------------------------------------------------ settle

test('settle: exactly once, charges the committed envelope, and requires the dispatched job', async () => {
  const h = createStoreHarness();
  const early = await admittedOperation(h);
  assert.deepEqual(await h.store.settle({
    op_id: early.op.op_id, generation: 1, job_id: 'job-none', outcome: 'succeeded', result_digest: 'sha256:d',
  }), { settled: false, reason: 'job_mismatch' });

  const job = await dispatchedOperation(h, { principal: bob, grant: 'grant-1' });
  const frame = await h.store.leaseNextJob({ resource_id: RES_1 });
  await h.store.completeJob({
    job_id: frame.job_id, lease_id: frame.lease_id, resource_id: RES_1, status: 'succeeded',
    result: workerResult(frame),
  });
  const before = used(h.sqlite);
  assert.equal(before.used_tokens, 128);
  assert.equal(before.used_jobs, 1);

  const args = { op_id: job.op.op_id, generation: 1, job_id: frame.job_id, outcome: 'succeeded', result_digest: 'sha256:digest' };
  assert.deepEqual(await h.store.settle(args), { settled: true });
  assert.deepEqual(await h.store.settle(args), { settled: false, reason: 'already_settled' });
  assert.deepEqual(await h.store.settle({ ...args, generation: 2 }), { settled: false, reason: 'generation_mismatch' });
  assert.deepEqual(await h.store.settle({ ...args, op_id: 'dispatch-op-missing' }), { settled: false, reason: 'unknown_operation' });
  assert.deepEqual(await h.store.settle({ ...args, job_id: 'job-other' }), { settled: false, reason: 'job_mismatch' });

  const after = used(h.sqlite);
  assert.equal(after.used_tokens, 128, 'settlement keeps the hold charge and charges nothing again');
  assert.equal(after.used_jobs, 1);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_settlements WHERE op_id = ?').get(job.op.op_id).n, 1);
  const states = holdRows(h.sqlite, job.op.op_id).map((r) => r.state);
  assert.deepEqual(states, ['charged']);
  assert.equal((await h.store.getOperation({ op_key: job.op.op_key })).settled.outcome, 'succeeded');
  assert.equal((await h.store.releaseHolds({ op_id: job.op.op_id, generation: 1 })).released, 0);
  assert.equal(used(h.sqlite).used_tokens, 128);
});

test('recheckRelease: follows live authority and the exact binding', async () => {
  const h = createStoreHarness();
  const flow = await admittedOperation(h, { principal: bob, grant: 'grant-1' });
  assert.deepEqual(await h.store.recheckRelease({ op_id: flow.op.op_id, generation: 1 }), { ok: true });
  h.sqlite.prepare('UPDATE grants SET revoked_at = ? WHERE id = ?').run(new Date(T0 + 1).toISOString(), 'grant-1');
  assert.deepEqual(await h.store.recheckRelease({ op_id: flow.op.op_id, generation: 1 }),
    { ok: false, reason: 'authority_revoked_before_release' });
  assert.deepEqual(await h.store.recheckRelease({ op_id: flow.op.op_id, generation: 2 }),
    { ok: false, reason: 'generation_mismatch' });
});

test('release: only uncharged holds and only when no start can still be redeemed', async () => {
  const h = createStoreHarness({ ownerDaily: '100000' });

  // Admitted and unfenced: the start could still be redeemed, so no release.
  const admitted = await admittedOperation(h);
  assert.deepEqual(await h.store.releaseHolds({ op_id: admitted.op.op_id, generation: 1 }), { released: 0 });
  // Fencing makes the release legal.
  await h.store.fenceStart({ op_id: admitted.op.op_id, generation: 1 });
  assert.deepEqual(await h.store.releaseHolds({ op_id: admitted.op.op_id, generation: 1 }), { released: 1 });
  assert.deepEqual(await h.store.releaseHolds({ op_id: admitted.op.op_id, generation: 1 }), { released: 0 });

  // Redeemed: never released.
  const redeemed = await dispatchedOperation(h);
  assert.deepEqual(await h.store.releaseHolds({ op_id: redeemed.op.op_id, generation: 1 }), { released: 0 });
  assert.equal(ownerPool(h.sqlite, 'owner:user-alice:2026-03-01').used_tokens, 128);

  // Settled: never released.
  const frame = await h.store.leaseNextJob({ resource_id: RES_1 });
  await h.store.completeJob({
    job_id: frame.job_id, lease_id: frame.lease_id, resource_id: RES_1, status: 'succeeded', result: workerResult(frame),
  });
  await h.store.settle({ op_id: redeemed.op.op_id, generation: 1, job_id: frame.job_id, outcome: 'succeeded', result_digest: 'sha256:x' });
  assert.deepEqual(await h.store.releaseHolds({ op_id: redeemed.op.op_id, generation: 1 }), { released: 0 });
  assert.equal(ownerPool(h.sqlite, 'owner:user-alice:2026-03-01').used_tokens, 128);
});

// ------------------------------------------------ per-principal state caps

// Finding 4437303806 (P2 security): retained dispatch state is bounded per
// principal. Expired admissions do not count and are swept; one principal's
// cap never affects another.
test('limits: live admissions per principal are capped and expired rows are swept', async () => {
  const h = createStoreHarness({ env: { INFERENCE_DISPATCH_MAX_ADMISSIONS: '2' } });
  const a1 = await h.store.issueAdmission({ principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 64 });
  const a2 = await h.store.issueAdmission({ principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 64 });
  await assert.rejects(
    h.store.issueAdmission({ principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 64 }),
    (e) => e.status === 429 && e.code === 'DISPATCH_LIMIT',
  );
  // A different principal has its own allowance.
  const b1 = await h.store.issueAdmission({
    principal: bob, resource_id: RES_1, model_id: 'model-x', max_tokens: 64, grant: 'grant-1',
  });
  assert.ok(b1.admission_ref);

  // Expired admissions are dead: they stop counting and are deleted by the
  // next issuance's sweep.
  h.sqlite.prepare('UPDATE dispatch_admissions SET expires_at = 0 WHERE principal_id = ?').run(alice.principal_id);
  const a3 = await h.store.issueAdmission({ principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 64 });
  assert.ok(a3.admission_ref);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_admissions WHERE principal_id = ?')
    .get(alice.principal_id).n, 1);
  assert.equal(await h.store.resolveAdmission({ principal: alice, admission_ref: a1.admission_ref }), null);
  assert.equal(await h.store.resolveAdmission({ principal: alice, admission_ref: a2.admission_ref }), null);
});

test('limits: non-terminal operations per principal are capped; terminal ones free a slot', async () => {
  const h = createStoreHarness({ env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '2' } });
  const a = await h.store.issueAdmission({
    principal: bob, resource_id: RES_1, model_id: 'model-x', max_tokens: 64, grant: 'grant-1',
  });
  const rec = await h.store.resolveAdmission({ principal: bob, admission_ref: a.admission_ref });
  const binding = bindingFor(rec, { principal: bob });
  const claim = (key) => h.store.claimOperation({
    op_key: key, request_digest: 'sha256:cap', principal_id: bob.principal_id,
    tenant_id: bob.tenant_id, binding,
  });
  const c1 = await claim('cap-op-1');
  const c2 = await claim('cap-op-2');
  assert.equal(c1.claimed, true);
  assert.equal(c2.claimed, true);
  // A replay of an existing key still reconciles while the principal is full.
  const replay = await claim('cap-op-2');
  assert.equal(replay.claimed, false);
  assert.equal(replay.op.op_id, c2.op.op_id);
  await assert.rejects(claim('cap-op-3'), (e) => e.status === 429 && e.code === 'DISPATCH_LIMIT');
  // Released/settled operations are terminal and stop consuming the cap.
  h.sqlite.prepare("UPDATE dispatch_operations SET phase = 'released' WHERE op_id = ?").run(c1.op.op_id);
  const c3 = await claim('cap-op-3');
  assert.equal(c3.claimed, true);
});

test('limits: the queued-job cap is enforced atomically in the enqueue statement', async () => {
  const h = createStoreHarness();
  await dispatchedOperation(h, { principal: bob, grant: 'grant-1', op_key: 'qcap-key-1' });
  await dispatchedOperation(h, { principal: bob, grant: 'grant-1', op_key: 'qcap-key-2' });

  // A third redeemed operation that has not queued yet.
  const a3 = await h.store.issueAdmission({
    principal: bob, resource_id: RES_1, model_id: 'model-x', max_tokens: 128, grant: 'grant-1',
  });
  const rec3 = await h.store.resolveAdmission({ principal: bob, admission_ref: a3.admission_ref });
  const binding = bindingFor(rec3, { principal: bob });
  const c3 = await h.store.claimOperation({
    op_key: 'qcap-key-3', request_digest: 'sha256:qcap', principal_id: bob.principal_id,
    tenant_id: bob.tenant_id, binding,
  });
  const hold = await h.store.acquireHold({
    op_id: c3.op.op_id, generation: 1, pool_id: binding.pools[0].pool_id, amount: 128,
  });
  assert.equal(hold.held, true);
  assert.equal((await h.store.admit({
    op_id: c3.op.op_id, generation: 1, holds: [hold.hold_id],
    authority: { grant_id: binding.grant_id, grant_revision: binding.grant_revision, incarnation: binding.incarnation },
  })).outcome, 'admitted');
  assert.equal((await h.store.redeemStart({
    op_id: c3.op.op_id, generation: 1,
    worker: { node_id: binding.node_id, runtime_instance: binding.runtime_instance },
  })).outcome, 'redeemed');
  const envelope = envelopeFor(rec3, { ...binding, op_id: c3.op.op_id });

  const capped = createD1DispatchStore(h.db, {
    now: h.clock.now, env: { INFERENCE_OWNER_DAILY_TOKENS: '10000', INFERENCE_DISPATCH_MAX_OPERATIONS: '2' },
  });
  assert.deepEqual(await capped.enqueueJob(envelope), { accepted: false, reason: 'dispatch_limit' });
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM dispatch_jobs WHERE status = 'queued'").get().n, 2);
  // The same enqueue succeeds under the original allowance.
  assert.equal((await h.store.enqueueJob(envelope)).accepted, true);
});

// ------------------------------------------------- coordinator over the store

test('coordinator: full lifecycle over the real store settles once and releases content', async () => {
  const h = createStoreHarness();
  const { coordinator } = coordinatorOverStore(h);
  const admission = await h.store.issueAdmission({ principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 128 });
  const body = submitBody(admission);

  const submitted = await coordinator.submit('ctx-alice', body);
  assert.equal(submitted.status, 'dispatched');
  assert.equal(submitted.automatic_retry, false);
  assert.equal(submitted.remote_stopped, false);
  const op = await h.store.getOperation({ op_key: JSON.stringify([alice.principal_id, body.idempotency_key]) });
  assert.equal(op.phase, 'dispatched');
  assert.equal(op.job_id, submitted.job_id);

  const frame = await h.store.leaseNextJob({ resource_id: RES_1 });
  assert.equal(frame.job_id, submitted.job_id);
  assert.equal(frame.envelope.task.placement.runtime_id, 'ganglion');
  assert.equal(frame.envelope.binding.runtime_instance, 'ganglion');
  assert.deepEqual(await h.store.completeJob({
    job_id: frame.job_id, lease_id: frame.lease_id, resource_id: RES_1, status: 'succeeded',
    result: workerResult(frame),
  }), { accepted: true });

  const reconciled = await coordinator.reconcile('ctx-alice', body.idempotency_key);
  assert.equal(reconciled.status, 'settled');
  assert.equal(reconciled.outcome.finish, 'succeeded');
  assert.equal(reconciled.outcome.released, true);
  assert.equal(reconciled.outcome.content, 'hello from the worker');
  assert.equal(reconciled.outcome.provenance.runtime_instance, 'ganglion');
  assert.equal(reconciled.outcome.provenance.model_fingerprint, 'model-x');
  assert.equal(ownerPool(h.sqlite, 'owner:user-alice:2026-03-01').used_tokens, 128);

  const again = await coordinator.reconcile('ctx-alice', body.idempotency_key);
  assert.equal(again.status, 'settled');
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_settlements').get().n, 1);
});

test('coordinator: llama-server admissions flow through placement and binding', async () => {
  const h = createStoreHarness();
  const { coordinator } = coordinatorOverStore(h);
  const admission = await h.store.issueAdmission({
    principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 64, runtime_id: 'llama-server',
  });
  const body = submitBody(admission);
  const submitted = await coordinator.submit('ctx-alice', body);
  assert.equal(submitted.status, 'dispatched');
  const frame = await h.store.leaseNextJob({ resource_id: RES_1 });
  assert.equal(frame.envelope.task.placement.runtime_id, 'llama-server');
  assert.equal(frame.envelope.binding.runtime_instance, 'llama-server');
  assert.equal(frame.envelope.binding.model_fingerprint, 'model-x');
  await h.store.completeJob({
    job_id: frame.job_id, lease_id: frame.lease_id, resource_id: RES_1, status: 'succeeded',
    result: workerResult(frame),
  });
  const reconciled = await coordinator.reconcile('ctx-alice', body.idempotency_key);
  assert.equal(reconciled.status, 'settled');
  assert.equal(reconciled.outcome.released, true);
  assert.equal(reconciled.outcome.provenance.runtime_instance, 'llama-server');
  const op = h.sqlite.prepare('SELECT * FROM dispatch_operations WHERE op_id = ?').get(submitted.op_id);
  assert.equal(JSON.parse(op.binding_json).runtime_id, 'llama-server');
});

test('coordinator: replay, expiry, foreign principal and changed digest are rejected without redispatch', async () => {
  const h = createStoreHarness();
  const { coordinator } = coordinatorOverStore(h);
  const admission = await h.store.issueAdmission({ principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 64 });
  const body = submitBody(admission);
  const submitted = await coordinator.submit('ctx-alice', body);
  assert.equal(submitted.status, 'dispatched');

  const replay = await coordinator.submit('ctx-alice', body);
  assert.equal(replay.status, 'dispatched');
  assert.equal(replay.job_id, submitted.job_id, 'a replay reconciles, it does not redispatch');
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').get().n, 1);

  const changed = await coordinator.submit('ctx-alice', { ...body, prompt: 'different' });
  assert.equal(changed.status, 'rejected');
  assert.equal(changed.code, 'IDEMPOTENCY_CONFLICT');

  const foreign = await coordinator.submit('ctx-bob', body);
  assert.equal(foreign.code, 'ADMISSION_NOT_AVAILABLE');

  h.clock.advance(ADMISSION_TTL_MS);
  const expired = await coordinator.submit('ctx-alice', {
    ...submitBody(admission), deadline_at: h.clock.now() + 60000,
  });
  assert.equal(expired.code, 'ADMISSION_EXPIRED');
});

test('coordinator: revoke between admit and start refuses the start and releases', async () => {
  const h = createStoreHarness();
  const { coordinator } = coordinatorOverStore(h);
  const admission = await h.store.issueAdmission({
    principal: bob, resource_id: RES_1, model_id: 'model-x', max_tokens: 128, grant: 'grant-1',
  });
  const body = submitBody(admission);
  // Wrap redeemStart to revoke in the same store immediately before the start.
  const authority = Object.assign({}, h.store, {
    redeemStart: async (args) => {
      h.sqlite.prepare('UPDATE grants SET revoked_at = ? WHERE id = ?').run(new Date(h.clock.now()).toISOString(), 'grant-1');
      return h.store.redeemStart(args);
    },
  });
  const coordinator2 = createDispatchCoordinator({
    resolvePrincipal: async () => ({ ...bob }),
    authority,
    transport: {
      capabilities: { protocol: 'aipster-bound-cpu-internal/1', instance_pin: true, deadline: true },
      dispatch: (e) => h.store.enqueueJob(e),
      poll: ({ job_id }) => h.store.readJob({ job_id }),
    },
    now: h.clock.now,
  });
  const out = await coordinator2.submit('ctx-bob', body);
  assert.equal(out.status, 'rejected');
  assert.equal(out.code, 'START_REFUSED');
  assert.equal(out.reason, 'revoked');
  const op = await h.store.getOperation({ op_key: JSON.stringify([bob.principal_id, body.idempotency_key]) });
  assert.equal(op.phase, 'released');
  assert.equal(used(h.sqlite).used_tokens, 0, 'the fenced-and-refused start released its hold');
  assert.equal(coordinator.interface, 'aipster-dispatch-coordinator/1');
});

test('coordinator: deadline before start fences and releases without dispatching', async () => {
  const h = createStoreHarness();
  const admission = await h.store.issueAdmission({ principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 64 });
  const body = submitBody(admission, { deadline_at: T0 + 1000 });
  const authority = Object.assign({}, h.store, {
    admit: async (args) => {
      const out = await h.store.admit(args);
      h.clock.advance(2000); // cross the deadline before the start step
      return out;
    },
  });
  const coordinator2 = createDispatchCoordinator({
    resolvePrincipal: async () => ({ ...alice }),
    authority,
    transport: {
      capabilities: { protocol: 'aipster-bound-cpu-internal/1', instance_pin: true, deadline: true },
      dispatch: () => { throw new Error('must not dispatch'); },
      poll: () => null,
    },
    now: h.clock.now,
  });
  const out = await coordinator2.submit('ctx-alice', body);
  assert.equal(out.status, 'expired_before_start');
  assert.equal(out.code, 'DEADLINE_EXCEEDED');
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').get().n, 0);
  assert.equal(ownerPool(h.sqlite, 'owner:user-alice:2026-03-01').used_tokens, 0);
  assert.equal(coordinator2.interface, 'aipster-dispatch-coordinator/1');
});

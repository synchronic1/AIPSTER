/* PR63-INDEPENDENT-QA-20261101 — adversarial regression, independently authored.
 *
 * Scope: this file only. It asserts against the shipped store/routes; it never
 * patches, prunes, settles or releases state to make an assertion pass. Where a
 * finding is expected to be unresolved at the reviewed base, the assertion
 * describes the required invariant and is allowed to fail honestly.
 *
 * Finding map (REVIEW-FINDINGS.json):
 *   F1  4437293854  P1  >256-char completion accepted; max content; rejected
 *                       result must not release the reservation
 *   F2  4437293864  P1  hold vs cancel in two store instances, owner + grant,
 *                       exact generation and fence
 *   F3  4437293871  P2  resource deletion with admissions and queued/leased work
 *   F4  4437293876  P2  idle backoff overflow (Python; verified by the existing
 *                       worker tests, not representable here)
 *   F5  4437303806  P2  per-principal retained admissions/operations
 *   F6  4437415004  P2  macOS-only path guard (Python; not representable here)
 *   F7  4437419399  P2  terminal retained operations bypass the operation cap
 *
 * Evidence engines:
 *  - node:sqlite through the repo D1 shim (real SQL, real store, real worker
 *    routes). The shim runs batches as savepoints on one connection, so
 *    *concurrent* batches interleave savepoint names; that is a shim artifact,
 *    never evidence about D1. Concurrency claims are therefore made against
 *    real miniflare D1 (the same engine dispatch-store-d1.test.mjs uses).
 *  - real miniflare D1 for the cross-instance cap test, where D1 serializes
 *    batches as real transactions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { MIGRATION_FILES, applyMigrations, createD1Shim, createTestEnv, readJson, TEST_URL } from './d1-shim.mjs';
import { createD1DispatchStore } from '../src/inference/dispatch-store.mjs';
import { CONTENT_MAX, validateWorkerResultReport } from '../src/inference/worker-transport.mjs';
import {
  T0, RES_1, alice, bob, createClock, createStoreHarness, bindingFor, envelopeFor,
  admittedOperation, dispatchedOperation, workerResult,
} from './fixtures/dispatch-store-fixture.mjs';

const envFor = (extra = {}) => ({ INFERENCE_OWNER_DAILY_TOKENS: '10000', ...extra });
const count = (sqlite, sql, ...params) => sqlite.prepare(sql).get(...params).n;
const opRows = (sqlite, principalId) => sqlite.prepare(
  'SELECT phase FROM dispatch_operations WHERE principal_id = ? ORDER BY created_at, op_id').all(principalId);
const grantUsed = (sqlite) => ({ ...sqlite.prepare(
  'SELECT used_jobs, used_tokens FROM grants WHERE id = ?').get('grant-1') });
const ownerPoolUsed = (sqlite, poolId) => {
  const row = sqlite.prepare('SELECT used_tokens FROM dispatch_pool_usage WHERE pool_id = ?').get(poolId);
  return row ? row.used_tokens : 0;
};

// ---------------------------------------------------------------------------
// F1 — content limit on the durable path, and its settlement/release edges
// ---------------------------------------------------------------------------

test('F1: 257- and 1000-char completions are accepted, preserved and settled once', async () => {
  for (const length of [257, 1000]) {
    const h = createStoreHarness();
    const flow = await dispatchedOperation(h, { principal: bob, grant: 'grant-1' });
    const frame = await h.store.leaseNextJob({ resource_id: RES_1 });
    const content = 'a'.repeat(length - 6) + ' ending';

    const done = await h.store.completeJob({
      job_id: frame.job_id, lease_id: frame.lease_id, resource_id: RES_1,
      status: 'succeeded', result: workerResult(frame, { content }),
    });
    assert.deepEqual(done, { accepted: true }, `${length}-char completion must be accepted`);
    assert.equal((await h.store.readJob({ job_id: flow.job_id })).result.content, content,
      'the full completion survives the store');

    // The HTTP validator and the durable store must agree on the same body.
    const wire = validateWorkerResultReport({
      lease_id: frame.lease_id, status: 'succeeded', result: workerResult(frame, { content }),
    });
    assert.equal(wire.ok, true, 'the worker-result route validator accepts the same completion');

    assert.deepEqual(await h.store.settle({
      op_id: flow.op.op_id, generation: 1, job_id: frame.job_id,
      outcome: 'succeeded', result_digest: `sha256:${length}`,
    }), { settled: true });
    assert.deepEqual(grantUsed(h.sqlite), { used_jobs: 1, used_tokens: 128 },
      'settlement charges the committed hold exactly once');
    assert.deepEqual(await h.store.settle({
      op_id: flow.op.op_id, generation: 1, job_id: frame.job_id,
      outcome: 'succeeded', result_digest: `sha256:${length}`,
    }), { settled: false, reason: 'already_settled' });
    assert.deepEqual(grantUsed(h.sqlite), { used_jobs: 1, used_tokens: 128 });
    assert.deepEqual(h.sqlite.prepare('SELECT state FROM dispatch_holds WHERE op_id = ?')
      .all(flow.op.op_id).map((r) => r.state), ['charged']);
  }
});

test('F1: content beyond the shared maximum is refused without releasing budget or lease', async () => {
  const h = createStoreHarness();
  const flow = await dispatchedOperation(h, { principal: bob, grant: 'grant-1' });
  const frame = await h.store.leaseNextJob({ resource_id: RES_1 });

  const over = await h.store.completeJob({
    job_id: frame.job_id, lease_id: frame.lease_id, resource_id: RES_1,
    status: 'succeeded', result: workerResult(frame, { content: 'x'.repeat(CONTENT_MAX + 1) }),
  });
  assert.deepEqual(over, { accepted: false, reason: 'invalid_result' });
  assert.equal(validateWorkerResultReport({
    lease_id: frame.lease_id, status: 'succeeded',
    result: workerResult(frame, { content: 'x'.repeat(CONTENT_MAX + 1) }),
  }).ok, false, 'the route validator refuses the same oversize completion');

  // A refused report must not be compensated by releasing the hold, expiring
  // the job or settling: the reservation remains until the coordinator acts.
  const job = h.sqlite.prepare('SELECT status FROM dispatch_jobs WHERE job_id = ?').get(frame.job_id);
  assert.equal(job.status, 'leased');
  assert.deepEqual(grantUsed(h.sqlite), { used_jobs: 1, used_tokens: 128 });
  assert.deepEqual(await h.store.releaseHolds({ op_id: flow.op.op_id, generation: 1 }),
    { released: 0 }, 'a dispatched operation is not releasable');
  assert.deepEqual(grantUsed(h.sqlite), { used_jobs: 1, used_tokens: 128 },
    'the hold survives the refused result');
});

// ---------------------------------------------------------------------------
// F2 — two-store hold/cancel interleavings, owner and grant, exact generation
// ---------------------------------------------------------------------------

const FENCE_READ = /^SELECT 1 AS hit FROM dispatch_fences WHERE op_id = \?/;

function staleFenceStore(h, other, env = {}) {
  // The competing cancel commits AFTER acquireHold's own fence read returned
  // "not fenced" but BEFORE its atomic batch. The store therefore proceeds on
  // a stale view, and only the in-batch generation/fence predicates can stop
  // the charge. This is a different interleaving point from a batch-level race.
  let fired = false;
  const wrapBound = (bound) => ({
    ...bound,
    bind: (...params) => wrapBound(bound.bind(...params)),
    first: async (...args) => {
      const res = await bound.first(...args);
      if (!fired) {
        fired = true;
        await other();
      }
      return res;
    },
  });
  const wrapped = {
    prepare(sql) {
      const stmt = h.db.prepare(sql);
      return FENCE_READ.test(sql) ? wrapBound(stmt) : stmt;
    },
    batch: (stmts) => h.db.batch(stmts),
  };
  return { store: createD1DispatchStore(wrapped, { now: h.clock.now, env: envFor(env) }), fired: () => fired };
}

async function pendingGrantClaim(h) {
  const a = await h.store.issueAdmission({
    principal: bob, resource_id: RES_1, model_id: 'model-x', max_tokens: 128, grant: 'grant-1',
  });
  const rec = await h.store.resolveAdmission({ principal: bob, admission_ref: a.admission_ref });
  const binding = bindingFor(rec, { principal: bob });
  const claim = await h.store.claimOperation({
    op_key: `f2-grant-${randomBytes(3).toString('hex')}`, request_digest: 'sha256:f2-grant',
    principal_id: bob.principal_id, tenant_id: bob.tenant_id, binding,
  });
  return { claim, poolId: binding.pools[0].pool_id };
}

async function pendingOwnerClaim(h) {
  const a = await h.store.issueAdmission({
    principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 128,
  });
  const rec = await h.store.resolveAdmission({ principal: alice, admission_ref: a.admission_ref });
  const binding = bindingFor(rec, { principal: alice });
  const claim = await h.store.claimOperation({
    op_key: `f2-owner-${randomBytes(3).toString('hex')}`, request_digest: 'sha256:f2-owner',
    principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
  });
  return { claim, poolId: binding.pools[0].pool_id };
}

for (const [kind, makeClaim] of [['grant', pendingGrantClaim], ['owner', pendingOwnerClaim]]) {
  test(`F2: a ${kind} cancel after the fence read but before the hold batch cannot charge`, async () => {
    const h = createStoreHarness();
    const { claim, poolId } = await makeClaim(h);
    const other = createD1DispatchStore(h.db, { now: h.clock.now, env: envFor() });
    const racing = staleFenceStore(h, async () => {
      assert.deepEqual(await other.fenceStart({
        op_id: claim.op.op_id, generation: 1, reason: 'cancel',
      }), { outcome: 'fenced' });
      assert.deepEqual(await other.releaseHolds({
        op_id: claim.op.op_id, generation: 1, reason: 'cancel',
      }), { released: 0 });
    });
    const store = racing.store;

    const hold = await store.acquireHold({
      op_id: claim.op.op_id, generation: 1, pool_id: poolId, amount: 128,
    });
    assert.deepEqual(hold, { held: false, reason: 'fenced' });
    assert.equal(racing.fired(), true, 'the cancel really interleaved after the fence read');
    assert.equal(count(h.sqlite, 'SELECT COUNT(*) AS n FROM dispatch_holds WHERE op_id = ?', claim.op.op_id), 0,
      'no orphaned hold row');
    if (kind === 'grant') {
      assert.deepEqual(grantUsed(h.sqlite), { used_jobs: 0, used_tokens: 0 }, 'no grant charge landed');
    } else {
      assert.equal(ownerPoolUsed(h.sqlite, poolId), 0, 'no owner-pool charge landed');
    }
    assert.equal(h.sqlite.prepare('SELECT phase FROM dispatch_operations WHERE op_id = ?')
      .get(claim.op.op_id).phase, 'released');

    // A later replay of the same hold must not resurrect the operation.
    assert.deepEqual(await store.acquireHold({
      op_id: claim.op.op_id, generation: 1, pool_id: poolId, amount: 128,
    }), { held: false, reason: 'fenced' });
    assert.equal(count(h.sqlite, 'SELECT COUNT(*) AS n FROM dispatch_holds WHERE op_id = ?', claim.op.op_id), 0);
  });
}

test('F2: the fence is generation-exact and a foreign generation does not block the hold', async () => {
  const h = createStoreHarness();
  const { claim, poolId } = await pendingGrantClaim(h);
  h.sqlite.prepare('INSERT INTO dispatch_fences (op_id, generation, fenced_at, reason) VALUES (?, 2, ?, ?)')
    .run(claim.op.op_id, new Date(T0).toISOString(), 'future-generation');

  const hold = await h.store.acquireHold({
    op_id: claim.op.op_id, generation: 1, pool_id: poolId, amount: 128,
  });
  assert.equal(hold.held, true, 'generation 1 is unaffected by a generation-2 tombstone');
  assert.deepEqual(grantUsed(h.sqlite), { used_jobs: 1, used_tokens: 128 });
});

// ---------------------------------------------------------------------------
// F3 — DELETE /api/inventory with admissions and queued/leased work (route)
// ---------------------------------------------------------------------------

async function seedResource(t, name = 'pr63-box') {
  const reg = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name, kind: 'local' },
  }));
  assert.equal(reg.status, 201, reg.text);
  const id = reg.json.id;
  await t.DB.prepare(`UPDATE resources SET online = 1, usable = 1, heartbeat_at = ?
    WHERE id = ?`).bind(new Date().toISOString(), id).run();
  return id;
}

test('F3: deleting a resource removes admissions and expires queued/leased jobs; later submit and lease fail', async () => {
  const t = await createTestEnv();
  const id = await seedResource(t);
  const principal = { principal_id: 'u_alice', tenant_id: 'tenant-a' };
  const store = createD1DispatchStore(t.DB, { now: () => Date.now(), env: envFor() });
  const deadline_at = Date.now() + 60_000;

  // One leased job and one queued job for this resource.
  const first = await admittedOperation({ store }, {
    principal, resource_id: id, model_id: 'model-x', max_tokens: 64,
    deadline_at, op_key: 'f3-del-1',
  });
  assert.equal(first.admitted.outcome, 'admitted');
  assert.equal((await store.redeemStart({
    op_id: first.op.op_id, generation: 1,
    worker: { node_id: first.binding.node_id, runtime_instance: first.binding.runtime_instance },
  })).outcome, 'redeemed');
  const queuedOne = await store.enqueueJob(envelopeFor(first.resolved, first.binding));
  assert.equal(queuedOne.accepted, true);
  await store.recordDispatch({ op_id: first.op.op_id, generation: 1, job_id: queuedOne.job_id });
  assert.ok(await store.leaseNextJob({ resource_id: id }), 'the first job is leased');

  const second = await admittedOperation({ store }, {
    principal, resource_id: id, model_id: 'model-x', max_tokens: 64,
    deadline_at, op_key: 'f3-del-2',
  });
  assert.equal(second.admitted.outcome, 'admitted');
  assert.equal((await store.redeemStart({
    op_id: second.op.op_id, generation: 1,
    worker: { node_id: second.binding.node_id, runtime_instance: second.binding.runtime_instance },
  })).outcome, 'redeemed');
  const queuedTwo = await store.enqueueJob(envelopeFor(second.resolved, second.binding));
  assert.equal(queuedTwo.accepted, true);
  await store.recordDispatch({ op_id: second.op.op_id, generation: 1, job_id: queuedTwo.job_id });

  const del = await readJson(await t.call(`/api/inventory/${id}`, {
    method: 'DELETE', headers: { ...t.as(t.alice), ...t.csrf },
  }));
  assert.equal(del.status, 200, del.text);

  assert.equal(count(t.sqlite, 'SELECT COUNT(*) AS n FROM dispatch_admissions WHERE resource_id = ?', id), 0,
    'admissions no longer block the resource FK');
  assert.equal(count(t.sqlite, 'SELECT COUNT(*) AS n FROM resources WHERE id = ?', id), 0);
  const jobs = t.sqlite.prepare('SELECT status FROM dispatch_jobs WHERE resource_id = ? ORDER BY job_id').all(id);
  assert.deepEqual(jobs.map((j) => j.status), ['expired', 'expired'],
    'queued and leased work is revoked, not left pullable');

  // Nothing dangling: a later submit cannot resolve an admission, and a later
  // lease finds no work for the deleted resource.
  await assert.rejects(store.issueAdmission({
    principal, resource_id: id, model_id: 'model-x', max_tokens: 64,
  }), (e) => e.status === 404 && e.code === 'RESOURCE_NOT_FOUND');
  assert.equal(await store.leaseNextJob({ resource_id: id }), null);
});

// ---------------------------------------------------------------------------
// F5 — per-principal retained admissions and operations
// ---------------------------------------------------------------------------

test('F5: the live-admission cap is durable and principal-isolated across store instances', async () => {
  const h = createStoreHarness({ env: { INFERENCE_DISPATCH_MAX_ADMISSIONS: '1' } });
  const other = createD1DispatchStore(h.db, { now: h.clock.now, env: envFor({ INFERENCE_DISPATCH_MAX_ADMISSIONS: '1' }) });
  const attempt = (store) => store.issueAdmission({
    principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 64,
  }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, status: e.status, code: e.code }));

  // Sequential, alternating instances: the cap must live in durable SQL, not in
  // per-instance memory. (Concurrent batches are exercised on real D1 below;
  // the shim's savepoint-per-batch emulation cannot host concurrent batches.)
  const outcomes = [await attempt(h.store), await attempt(other), await attempt(h.store), await attempt(other)];
  assert.equal(outcomes.filter((o) => o.ok).length, 1, 'exactly one admission lands across two stores');
  for (const o of outcomes.filter((x) => !x.ok)) {
    assert.equal(o.status, 429);
    assert.equal(o.code, 'DISPATCH_LIMIT');
  }
  assert.equal(count(h.sqlite, 'SELECT COUNT(*) AS n FROM dispatch_admissions WHERE principal_id = ?', alice.principal_id), 1);

  const bobAdmission = await h.store.issueAdmission({
    principal: bob, resource_id: RES_1, model_id: 'model-x', max_tokens: 64, grant: 'grant-1',
  });
  assert.ok(bobAdmission.admission_ref, "one principal's cap never blocks another");

  // Expired rows do not count and are swept by the next issuance.
  h.clock.advance(10 * 60 * 1000 + 1);
  // Keep the resource live across the clock jump so this measures the cap, not
  // heartbeat staleness.
  h.sqlite.prepare('UPDATE resources SET heartbeat_at = ?').run(new Date(h.clock.now()).toISOString());
  const fresh = await h.store.issueAdmission({
    principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 64,
  });
  assert.ok(fresh.admission_ref);
  assert.equal(count(h.sqlite, 'SELECT COUNT(*) AS n FROM dispatch_admissions WHERE principal_id = ? AND expires_at > ?',
    alice.principal_id, h.clock.now()), 1, 'only the fresh admission is retained for this principal');
});

// Real D1 fixture: concurrent batches serialize as real transactions, which is
// what the cross-instance cap claim needs.
async function realD1(c) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: 'export default {fetch(){return new Response("synthetic")}}',
    compatibilityDate: '2026-10-01', d1Databases: { DB: 'pr63-adversarial' },
    outboundService: () => { throw new Error('Unexpected outbound request'); },
  }));
  c.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of MIGRATION_FILES) {
    const sql = (await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'))
      .split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    for (const stmt of sql.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) await db.exec(stmt);
  }
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
  return { db, clock };
}

test('F5: on real D1 concurrent admissions across two store instances cannot exceed the cap', async (c) => {
  const { db, clock } = await realD1(c);
  const env = envFor({ INFERENCE_DISPATCH_MAX_ADMISSIONS: '1' });
  const a = createD1DispatchStore(db, { now: clock.now, env });
  const b = createD1DispatchStore(db, { now: clock.now, env });
  const attempt = (store) => store.issueAdmission({
    principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 64,
  }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, status: e.status, code: e.code }));

  const outcomes = await Promise.all([attempt(a), attempt(b), attempt(a), attempt(b)]);
  assert.equal(outcomes.filter((o) => o.ok).length, 1, 'exactly one admission lands on real D1');
  for (const o of outcomes.filter((x) => !x.ok)) {
    assert.equal(o.status, 429, `refusals are cap refusals, got ${JSON.stringify(o)}`);
    assert.equal(o.code, 'DISPATCH_LIMIT');
  }
  const rows = await db.prepare('SELECT COUNT(*) AS n FROM dispatch_admissions WHERE principal_id = ?')
    .bind(alice.principal_id).first();
  assert.equal(rows.n, 1, 'one durable admission, never more than the cap');
});

test('F5: idempotent replay and unknown-outcome retention each consume the cap honestly', async () => {
  const h = createStoreHarness({ env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '1' } });
  const flow = await admittedOperation(h, { principal: bob, grant: 'grant-1', op_key: 'f5-replay-key' });
  const replay = await h.store.claimOperation({
    op_key: 'f5-replay-key', request_digest: `sha256:${'a'.repeat(64)}`,
    principal_id: bob.principal_id, tenant_id: bob.tenant_id, binding: flow.binding,
  });
  assert.equal(replay.claimed, false);
  assert.equal(replay.op.op_id, flow.op.op_id, 'a replay never creates a second retained row');
  await assert.rejects(h.store.claimOperation({
    op_key: 'f5-second-key', request_digest: 'sha256:second',
    principal_id: bob.principal_id, tenant_id: bob.tenant_id, binding: flow.binding,
  }), (e) => e.status === 429 && e.code === 'DISPATCH_LIMIT');

  // An uncertain (unknown-outcome) operation is not terminal: it keeps its slot.
  assert.equal((await h.store.markUncertain({
    op_id: flow.op.op_id, generation: 1, phase: 'dispatched', detail: 'transport_timeout',
  })).recorded, true);
  assert.equal(h.sqlite.prepare('SELECT phase FROM dispatch_operations WHERE op_id = ?')
    .get(flow.op.op_id).phase, 'admitted');
  assert.ok(h.sqlite.prepare('SELECT uncertain_phase FROM dispatch_operations WHERE op_id = ?')
    .get(flow.op.op_id).uncertain_phase, 'the uncertainty is retained, not resolved');
  await assert.rejects(h.store.claimOperation({
    op_key: 'f5-third-key', request_digest: 'sha256:third',
    principal_id: bob.principal_id, tenant_id: bob.tenant_id, binding: flow.binding,
  }), (e) => e.status === 429 && e.code === 'DISPATCH_LIMIT');
});

test('F7: repeated released budget failures cannot grow retained operations past the cap', async () => {
  const cap = 2;
  const h = createStoreHarness({
    ownerDaily: '0',
    env: { INFERENCE_DISPATCH_MAX_OPERATIONS: String(cap), INFERENCE_DISPATCH_MAX_ADMISSIONS: '100' },
  });
  const principal = alice; // owner admission; the 0-token ceiling refuses every hold

  for (let i = 0; i < 25; i += 1) {
    const a = await h.store.issueAdmission({
      principal, resource_id: RES_1, model_id: 'model-x', max_tokens: 64,
    });
    const rec = await h.store.resolveAdmission({ principal, admission_ref: a.admission_ref });
    const binding = bindingFor(rec, { principal });
    const claim = await h.store.claimOperation({
      op_key: `f7-released-${i}`, request_digest: `sha256:${i}`,
      principal_id: principal.principal_id, tenant_id: principal.tenant_id, binding,
    });
    assert.equal(claim.claimed, true);
    const hold = await h.store.acquireHold({
      op_id: claim.op.op_id, generation: 1, pool_id: binding.pools[0].pool_id, amount: 64,
    });
    assert.deepEqual(hold, { held: false, reason: 'insufficient' });
    await h.store.releaseHolds({ op_id: claim.op.op_id, generation: 1, reason: 'budget' });
  }

  const retained = opRows(h.sqlite, principal.principal_id);
  assert.ok(retained.length <= cap,
    `retained operations (${retained.length}) must stay within the cap (${cap}): terminal rows are retained state and must either count or be pruned atomically`);

  // The cap must also stay usable: a fresh claim is either admitted (terminal
  // rows pruned) or refused with DISPATCH_LIMIT (terminal rows counted), never
  // silently accepted while rows keep accumulating.
  const fresh = await h.store.claimOperation({
    op_key: 'f7-after', request_digest: 'sha256:after',
    principal_id: principal.principal_id, tenant_id: principal.tenant_id,
    binding: JSON.parse(h.sqlite.prepare('SELECT binding_json FROM dispatch_operations LIMIT 1').get().binding_json),
  }).then((v) => ({ claimed: v.claimed }), (e) => ({ status: e.status, code: e.code }));
  assert.ok(fresh.claimed === true || (fresh.status === 429 && fresh.code === 'DISPATCH_LIMIT'),
    `a fresh claim after the cap is either admitted or limited, got ${JSON.stringify(fresh)}`);
  if (fresh.claimed === true) {
    assert.ok(opRows(h.sqlite, principal.principal_id).length <= cap,
      'admitting a fresh claim must not raise retained rows above the cap');
  }
});

test('F7: settled operations are retained rows and cannot be used to bypass the cap', async () => {
  const cap = 2;
  const h = createStoreHarness({
    env: { INFERENCE_DISPATCH_MAX_OPERATIONS: String(cap), INFERENCE_DISPATCH_MAX_ADMISSIONS: '100' },
  });

  for (let i = 0; i < 3; i += 1) {
    const flow = await dispatchedOperation(h, { principal: bob, grant: 'grant-1', op_key: `f7-settled-${i}` });
    const frame = await h.store.leaseNextJob({ resource_id: RES_1 });
    assert.equal((await h.store.completeJob({
      job_id: frame.job_id, lease_id: frame.lease_id, resource_id: RES_1,
      status: 'succeeded', result: workerResult(frame),
    })).accepted, true);
    assert.equal((await h.store.settle({
      op_id: flow.op.op_id, generation: 1, job_id: frame.job_id,
      outcome: 'succeeded', result_digest: `sha256:settled-${i}`,
    })).settled, true);
    // A second admission is issued per operation by dispatchedOperation, so the
    // admission allowance is raised above; the operation cap is the subject.
    h.clock.advance(1000);
  }

  const retained = opRows(h.sqlite, bob.principal_id);
  assert.equal(retained.length, 3, 'the three settled operations are retained rows');
  assert.ok(retained.length <= cap,
    `retained settled operations (${retained.length}) must stay within the cap (${cap}) or be pruned atomically`);
});

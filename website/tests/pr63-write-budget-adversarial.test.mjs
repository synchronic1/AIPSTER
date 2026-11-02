/* PR63-INDEPENDENT-QA-20261101 — round 2: admitted-dispatch write/claim budget.
 *
 * Scope: this file only. It asserts the required behaviour of the shipped
 * coordinator and store; it never patches, prunes, releases or settles state to
 * make an assertion pass. Against a base that does not implement the budget the
 * budget tests fail honestly (failing-first evidence), while the protection
 * tests pass and stay as regressions.
 *
 * Finding (PRRT_kwDOVYKI0c6ye8ko / comment 4437565771): at an exhausted
 * inference budget the actual coordinator produced 1499 SQLite changes for 500
 * unique client-chosen idempotency keys while retaining 2 operation rows. Each
 * refused fresh key still wrote a claim row, a fence tombstone and a release
 * update, so a principal at zero budget could drive unbounded write volume and
 * churn. Reproduced at baseline d99469f in
 * qa-results/r2-initial-repro-500keys.log (exactly 500 -> 1499 / 2).
 *
 * Required contract asserted here
 * ------------------------------
 * A per-principal rolling claim allowance bounds the number of *new* operations
 * a caller may create per window. It is enforced in the same SQL statement that
 * creates the operation, so:
 *   - at exhaustion a fresh key is refused with HTTP 429 and ZERO row changes
 *     (no claim row, no fence, no prune, no release update);
 *   - the refusal does not depend on the operation cap, and pruning a released
 *     or aged-settled operation never restores allowance;
 *   - the allowance is durable (survives a new store instance over the same
 *     database), per principal, and rolls with the clock;
 *   - a replay of a retained key is a read: no writes, no charge, no refund,
 *     including when the claim loses a same-key race after its lookup returned
 *     null — the loser must not run cleanup or append a second claim event;
 *   - malformed limit env falls back to the documented finite default, never to
 *     "unlimited" and never to a zero-claim lockout;
 *   - the allowance does not replace the operation cap: unknown work and live
 *     holds/jobs are still never pruned, and a legitimate 21st job after 20
 *     settlements succeeds while the allowance permits it.
 *
 * QA-facing env contract (the writer may rename with a documented equivalent;
 * QA reconciles names against the immutable candidate, the invariants above do
 * not change): INFERENCE_DISPATCH_CLAIM_BUDGET (claims per principal per
 * window), INFERENCE_DISPATCH_CLAIM_WINDOW_MS (window length). Aliases are set
 * together so a reasonable spelling difference does not mask the invariant.
 *
 * Evidence engines: node:sqlite through the repo D1 shim (single-connection
 * batches; never used for concurrency claims), and real miniflare D1 for the
 * cross-instance quota race. No network, no live inference.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { MIGRATION_FILES } from './d1-shim.mjs';
import { createD1DispatchStore } from '../src/inference/dispatch-store.mjs';
import { createDispatchCoordinator } from '../src/inference/dispatch-coordinator.mjs';
import {
  T0, RES_1, alice, bob, createClock, createStoreHarness, bindingFor,
  admittedOperation, dispatchedOperation, workerResult,
} from './fixtures/dispatch-store-fixture.mjs';

const BUDGET_KEYS = ['INFERENCE_DISPATCH_CLAIM_BUDGET', 'INFERENCE_DISPATCH_WRITE_BUDGET',
  'INFERENCE_DISPATCH_MAX_CLAIMS', 'INFERENCE_DISPATCH_CLAIMS_PER_WINDOW'];
const WINDOW_KEYS = ['INFERENCE_DISPATCH_CLAIM_WINDOW_MS', 'INFERENCE_DISPATCH_BUDGET_WINDOW_MS',
  'INFERENCE_DISPATCH_WRITE_WINDOW_MS'];
// Budget refusals are limit refusals. DISPATCH_LIMIT is the store's existing
// 429 code; the aliases let the writer pick a distinct, documented code.
const LIMIT_CODES = new Set(['DISPATCH_LIMIT', 'CLAIM_BUDGET', 'WRITE_BUDGET']);

const quotaEnv = (claims, windowMs, extra = {}) => ({
  ...Object.fromEntries(BUDGET_KEYS.map((k) => [k, String(claims)])),
  ...Object.fromEntries(WINDOW_KEYS.map((k) => [k, String(windowMs)])),
  INFERENCE_DISPATCH_MAX_ADMISSIONS: '200',
  ...extra,
});
const changes = (sqlite) => sqlite.prepare('SELECT total_changes() AS n').get().n;
const count = (sqlite, sql, ...params) => sqlite.prepare(sql).get(...params).n;
const opRows = (sqlite) => count(sqlite, 'SELECT COUNT(*) AS n FROM dispatch_operations');
const opKey = (principal, key) => JSON.stringify([principal.principal_id, key]);
const quotaCode = (res) => res && res.http === 429 && LIMIT_CODES.has(res.code);
const isLimitError = (e) => e && (e.status === 429 || e.http === 429) && LIMIT_CODES.has(e.code);

const submitBody = (admission, key, deadline = T0 + 60000) => ({
  contract_version: 'v1.0.0', admission_ref: admission.admission_ref, idempotency_key: key,
  model_id: admission.model_id, prompt: 'hello', max_tokens: admission.max_tokens, deadline_at: deadline,
});

function coordinatorFor(store, clock, principals = { 'ctx-alice': alice, 'ctx-bob': bob }) {
  return createDispatchCoordinator({
    resolvePrincipal: async (ctx) => (ctx in principals ? { ...principals[ctx] } : null),
    authority: store,
    transport: {
      capabilities: { protocol: 'aipster-bound-cpu-internal/1', instance_pin: true, deadline: true },
      dispatch: (envelope) => store.enqueueJob(envelope),
      poll: ({ job_id }) => store.readJob({ job_id }),
    },
    now: clock.now,
  });
}

async function bindingOverStore(harness, principal = alice, { resource_id = RES_1, grant = null, max_tokens = 64 } = {}) {
  const admission = await harness.store.issueAdmission({ principal, resource_id, model_id: 'model-x', max_tokens, grant });
  const resolved = await harness.store.resolveAdmission({ principal, admission_ref: admission.admission_ref });
  return { admission, binding: bindingFor(resolved, { principal }) };
}

// ---------------------------------------------------------------------------
// 1 — the finding: at exhaustion a fresh key must cost nothing
// ---------------------------------------------------------------------------
test('budget: at exhaustion a fresh key is refused with zero writes and total volume is bounded', async () => {
  const QUOTA = 4;
  const h = createStoreHarness({
    ownerDaily: '0',
    env: quotaEnv(QUOTA, 3600000, { INFERENCE_DISPATCH_MAX_OPERATIONS: '2' }),
  });
  const { admission } = await bindingOverStore(h);
  const coordinator = coordinatorFor(h.store, h.clock);

  const deltas = [];
  const responses = [];
  for (let i = 0; i < 500; i += 1) {
    const key = `budget-key-${String(i).padStart(4, '0')}`;
    const before = changes(h.sqlite);
    let res;
    // A quota refusal may be a thrown limit error (store contract) or a mapped
    // 429 response (coordinator contract). Both are recorded the same way, so
    // exhaustion can never abort the loop before the write bounds are asserted.
    try {
      res = await coordinator.submit('ctx-alice', submitBody(admission, key));
    } catch (e) {
      if (!isLimitError(e)) throw e;
      res = { status: 'rejected', http: e.status || e.http, code: e.code };
    }
    deltas.push(changes(h.sqlite) - before);
    responses.push(res);
  }

  const firstFree = deltas.findIndex((d) => d === 0);
  assert.notEqual(firstFree, -1,
    `500 fresh keys all wrote rows; no claim allowance took effect (expected ${BUDGET_KEYS[0]} / ${WINDOW_KEYS[0]})`);
  assert.ok(firstFree <= QUOTA + 2, `the allowance leaked: ${firstFree} keys wrote before the first free refusal`);

  const total = deltas.reduce((a, b) => a + b, 0);
  assert.ok(total <= QUOTA * 6, `exhaustion wrote ${total} row changes for ${QUOTA} allowed claims (bound ${QUOTA * 6})`);
  for (let i = firstFree; i < deltas.length; i += 1) {
    assert.equal(deltas[i], 0, `refused key ${i} still wrote ${deltas[i]} row change(s)`);
    assert.ok(quotaCode(responses[i]),
      `refused key ${i} returned ${responses[i].http}:${responses[i].code}, not a 429 limit refusal`);
  }
  // Round-2 contract: refused claims write nothing, and retained rows are the
  // budgeted claims themselves (released receipts kept for replay), not a cap
  // count. The active cap still bounds live work.
  assert.equal(opRows(h.sqlite), QUOTA,
    `retained ${opRows(h.sqlite)} operations for ${QUOTA} budgeted claims`);
  assert.ok(count(h.sqlite,
    "SELECT COUNT(*) AS n FROM dispatch_operations WHERE phase <> 'released'") <= 2,
  'live work exceeded the configured active cap');
  assert.equal(count(h.sqlite, 'SELECT COUNT(*) AS n FROM dispatch_fences'), 0, 'a refusal left fence rows');
  assert.equal(count(h.sqlite, 'SELECT COUNT(*) AS n FROM dispatch_holds'), 0, 'a refusal left hold rows');
});

// ---------------------------------------------------------------------------
// 2 — replay is free and does not refund the allowance
// ---------------------------------------------------------------------------
test('budget: a same-key replay writes nothing, charges nothing and does not refund the allowance', async () => {
  const QUOTA = 4;
  const h = createStoreHarness({ ownerDaily: '0', env: quotaEnv(QUOTA, 3600000) });
  const { admission } = await bindingOverStore(h);
  const coordinator = coordinatorFor(h.store, h.clock);

  const first = [];
  for (let i = 0; i < 3; i += 1) {
    const before = changes(h.sqlite);
    const res = await coordinator.submit('ctx-alice', submitBody(admission, `replay-key-${i}`));
    assert.ok(changes(h.sqlite) > before, 'an allowed claim must write');
    assert.equal(res.code, 'BUDGET_EXHAUSTED', `expected the hold refusal, got ${res.http}:${res.code}`);
    first.push(res);
  }

  for (let i = 0; i < 10; i += 1) {
    const before = changes(h.sqlite);
    const replay = await coordinator.submit('ctx-alice', submitBody(admission, 'replay-key-0'));
    assert.equal(changes(h.sqlite), before, 'a same-key replay wrote rows');
    assert.equal(replay.op_id, first[0].op_id, 'a replay must reconcile to the original operation');
    assert.equal(replay.status, 'released', `a released replay must report the retained phase, got ${replay.status}`);
  }

  // The three allowed claims are spent; one more is still inside the allowance.
  const beforeFourth = changes(h.sqlite);
  const fourth = await coordinator.submit('ctx-alice', submitBody(admission, 'replay-key-3'));
  assert.ok(changes(h.sqlite) > beforeFourth, 'the fourth claim must be allowed and write');
  assert.equal(fourth.code, 'BUDGET_EXHAUSTED');

  const beforeFifth = changes(h.sqlite);
  const fifth = await coordinator.submit('ctx-alice', submitBody(admission, 'replay-key-4'));
  assert.equal(changes(h.sqlite), beforeFifth, 'replays consumed allowance: the fifth claim was refused only after writing');
  assert.ok(quotaCode(fifth), `expected a 429 limit refusal at quota, got ${fifth.http}:${fifth.code}`);
});

// ---------------------------------------------------------------------------
// 3 — two stores racing on real D1 cannot exceed the quota
// ---------------------------------------------------------------------------
async function applyFile(db, file) {
  const sql = (await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'))
    .split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  for (const stmt of sql.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) await db.exec(stmt);
}

async function realD1(c, env) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: 'export default {fetch(){return new Response("synthetic")}}',
    compatibilityDate: '2026-10-01', d1Databases: { DB: 'pr63-write-budget' },
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
  const stores = [createD1DispatchStore(db, { now: clock.now, env }), createD1DispatchStore(db, { now: clock.now, env })];
  return { db, clock, stores };
}

test('budget: two stores racing on real D1 cannot exceed the quota', async (c) => {
  const QUOTA = 3;
  const env = quotaEnv(QUOTA, 3600000, { INFERENCE_DISPATCH_MAX_OPERATIONS: '100' });
  const { db, clock, stores } = await realD1(c, env);
  const admission = await stores[0].issueAdmission({ principal: alice, resource_id: RES_1, model_id: 'model-x', max_tokens: 64 });
  const coordinators = stores.map((s) => coordinatorFor(s, clock));

  const keys = Array.from({ length: 8 }, (_, i) => `race-key-${i}`);
  const responses = await Promise.all(keys.map((key, i) =>
    coordinators[i % 2].submit('ctx-alice', submitBody(admission, key))));

  const allowed = responses.filter((r) => r.code === 'BUDGET_EXHAUSTED');
  const denied = responses.filter(quotaCode);
  assert.equal(allowed.length, QUOTA,
    `the race created ${allowed.length} operations for a quota of ${QUOTA} (codes: ${responses.map((r) => r.code).join(',')})`);
  assert.equal(denied.length, keys.length - QUOTA);

  for (let i = 0; i < keys.length; i += 1) {
    if (!quotaCode(responses[i])) continue;
    const row = await db.prepare('SELECT COUNT(*) AS n FROM dispatch_operations WHERE op_key = ?')
      .bind(opKey(alice, keys[i])).first();
    assert.equal(row.n, 0, `denied key ${keys[i]} left an operation row behind`);
  }
  const retained = await db.prepare('SELECT COUNT(*) AS n FROM dispatch_operations').first();
  assert.ok(retained.n <= QUOTA, `retained ${retained.n} operations for a ${QUOTA}-claim allowance`);
});

// ---------------------------------------------------------------------------
// 4 — the allowance is per principal
// ---------------------------------------------------------------------------
test('budget: one principal at quota does not refuse another principal', async () => {
  const QUOTA = 3;
  const h = createStoreHarness({ ownerDaily: '0', env: quotaEnv(QUOTA, 3600000) });
  const coordinator = coordinatorFor(h.store, h.clock);
  const aliceAdmission = (await bindingOverStore(h)).admission;
  for (let i = 0; i < QUOTA; i += 1) {
    assert.equal((await coordinator.submit('ctx-alice', submitBody(aliceAdmission, `iso-alice-${i}`))).code,
      'BUDGET_EXHAUSTED');
  }
  const spent = await coordinator.submit('ctx-alice', submitBody(aliceAdmission, 'iso-alice-spent'));
  assert.ok(quotaCode(spent), `alice should be at quota, got ${spent.http}:${spent.code}`);

  const bobAdmission = (await bindingOverStore(h, bob, { grant: 'grant-1' })).admission;
  const before = changes(h.sqlite);
  const bobRes = await coordinator.submit('ctx-bob', submitBody(bobAdmission, 'iso-bob-only'));
  assert.ok(!quotaCode(bobRes), `bob inherited alice's refusal: ${bobRes.http}:${bobRes.code}`);
  assert.ok(changes(h.sqlite) > before, 'bob\'s allowed claim wrote nothing');
  assert.equal(count(h.sqlite,
    'SELECT COUNT(*) AS n FROM dispatch_operations WHERE principal_id = ?', bob.principal_id), 1);
  assert.equal(count(h.sqlite,
    'SELECT COUNT(*) AS n FROM dispatch_operations WHERE principal_id = ?', alice.principal_id), QUOTA);
});

// ---------------------------------------------------------------------------
// 5 — rolling window boundary and time recovery
// ---------------------------------------------------------------------------
test('budget: the allowance is a rolling window and recovers with time', async () => {
  const QUOTA = 3;
  const WINDOW = 60000;
  const h = createStoreHarness({
    env: quotaEnv(QUOTA, WINDOW, { INFERENCE_DISPATCH_MAX_OPERATIONS: '1000', INFERENCE_OWNER_DAILY_TOKENS: '10000' }),
  });
  const { binding } = await bindingOverStore(h);
  const claim = (key) => h.store.claimOperation({
    op_key: opKey(alice, key), request_digest: `sha256:${key}`,
    principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
  });
  for (let i = 0; i < QUOTA; i += 1) assert.equal((await claim(`win-${i}`)).claimed, true);

  const beforeDenied = changes(h.sqlite);
  await assert.rejects(() => claim('win-denied'), isLimitError,
    'a fresh key inside the window was not refused by the allowance');
  assert.equal(changes(h.sqlite), beforeDenied, 'a window refusal wrote rows');

  h.clock.advance(WINDOW - 1);
  await assert.rejects(() => claim('win-edge'), isLimitError, 'the window expired one millisecond early');

  h.clock.advance(2);
  const recovered = await claim('win-recovered');
  assert.equal(recovered.claimed, true, 'the allowance did not recover after the window elapsed');
  assert.ok(opRows(h.sqlite) >= QUOTA + 1);
});

// ---------------------------------------------------------------------------
// 5b — an anchored reset is not a rolling window
// ---------------------------------------------------------------------------
test('budget: an anchored reset cannot double the hourly allowance at a window boundary', async () => {
  const QUOTA = 5;
  const WINDOW = 3600000;
  const h = createStoreHarness({
    start: T0 - 1000,
    env: quotaEnv(QUOTA, WINDOW, { INFERENCE_DISPATCH_MAX_OPERATIONS: '1000', INFERENCE_OWNER_DAILY_TOKENS: '10000' }),
  });
  // 1 ms before the UTC hour anchor, then 1 ms after it: a true trailing
  // window still sees both batches; a per-hour counter reset would allow 2x.
  h.clock.advance(999);
  const { binding } = await bindingOverStore(h);
  const claim = (key) => h.store.claimOperation({
    op_key: opKey(alice, key), request_digest: `sha256:${key}`,
    principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
  });
  for (let i = 0; i < QUOTA; i += 1) {
    assert.equal((await claim(`anchor-before-${i}`)).claimed, true);
  }
  h.clock.advance(2);
  const beforeRefusals = changes(h.sqlite);
  for (let i = 0; i < QUOTA; i += 1) {
    await assert.rejects(() => claim(`anchor-after-${i}`), isLimitError,
      'a claim just after the hour anchor was admitted although the previous batch is 1 ms old');
  }
  assert.equal(changes(h.sqlite), beforeRefusals, 'a boundary refusal wrote rows');

  h.clock.advance(WINDOW + 2);
  const recovered = await claim('anchor-recovered');
  assert.equal(recovered.claimed, true, 'the trailing window never expired');
});

// ---------------------------------------------------------------------------
// 6 — malformed env falls back to the documented finite default
// ---------------------------------------------------------------------------
async function firstLimitIndex(env, keys = 400) {
  const h = createStoreHarness({ env: { INFERENCE_DISPATCH_MAX_OPERATIONS: '1000', ...env } });
  const { binding } = await bindingOverStore(h, alice, { max_tokens: 8 });
  for (let i = 0; i < keys; i += 1) {
    try {
      await h.store.claimOperation({
        op_key: opKey(alice, `mal-${i}`), request_digest: `sha256:mal-${i}`,
        principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
      });
    } catch (e) {
      if (isLimitError(e)) return i;
      throw e;
    }
  }
  return -1;
}

test('budget: malformed limit env uses the documented default, never unlimited', async () => {
  const withDefaults = await firstLimitIndex({});
  assert.notEqual(withDefaults, -1,
    `400 claims were all accepted with default env: no finite default allowance (expected ${BUDGET_KEYS[0]})`);
  assert.ok(withDefaults > 0, 'the documented default refuses every claim (zero-claim lockout)');

  const malformed = Object.fromEntries([
    ...BUDGET_KEYS.map((k) => [k, 'not-a-number']),
    ...WINDOW_KEYS.map((k) => [k, '-1']),
  ]);
  const withMalformed = await firstLimitIndex(malformed);
  assert.equal(withMalformed, withDefaults,
    'malformed budget env did not behave like the documented default');
});

// ---------------------------------------------------------------------------
// 7 — a spent allowance survives restart and released-row pruning
// ---------------------------------------------------------------------------
test('budget: a spent allowance survives released-row pruning and a restart', async () => {
  const QUOTA = 3;
  const env = quotaEnv(QUOTA, 3600000, { INFERENCE_DISPATCH_MAX_OPERATIONS: '2' });
  const h = createStoreHarness({ env: { ...env, INFERENCE_OWNER_DAILY_TOKENS: '10000' } });
  const { binding } = await bindingOverStore(h);
  for (let i = 0; i < QUOTA; i += 1) {
    const c = await h.store.claimOperation({
      op_key: opKey(alice, `restart-${i}`), request_digest: `sha256:restart-${i}`,
      principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
    });
    assert.equal(c.claimed, true);
    assert.deepEqual(await h.store.releaseHolds({ op_id: c.op.op_id, generation: 1, reason: 'cancelled' }),
      { released: 0 });
    h.clock.advance(1000);
  }
  // Age-only contract: the released rows are retained replay state. A spent
  // allowance is what refuses; a restart must not forget it, and a refusal must
  // not prune (only an admitted claim may).
  assert.equal(opRows(h.sqlite), QUOTA, 'released receipts must be retained for the replay horizon');
  h.sqlite.prepare('UPDATE dispatch_operations SET updated_at = ?')
    .run(new Date(T0 - 8 * 24 * 3600 * 1000).toISOString());

  const restarted = createD1DispatchStore(h.db, { now: h.clock.now, env });
  const before = changes(h.sqlite);
  await assert.rejects(() => restarted.claimOperation({
    op_key: opKey(alice, 'restart-after'), request_digest: 'sha256:restart-after',
    principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
  }), isLimitError, 'a restarted store forgot the spent allowance');
  assert.equal(changes(h.sqlite), before, 'the restarted refusal wrote or pruned rows');
  assert.equal(opRows(h.sqlite), QUOTA, 'a refusal pruned aged rows: only an admitted claim may');

  // When the window rolls, the allowance refills and one admitted claim prunes a
  // batch of aged receipts; pruning must not hand back more than the window.
  h.clock.advance(3600000 + 1);
  const admitted = await restarted.claimOperation({
    op_key: opKey(alice, 'restart-after'), request_digest: 'sha256:restart-after',
    principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
  });
  assert.equal(admitted.claimed, true, 'the allowance did not roll with the clock');
  assert.equal(opRows(h.sqlite), 1, 'the admitted claim did not prune the aged receipts it replaced');
  await restarted.releaseHolds({ op_id: admitted.op.op_id, generation: 1, reason: 'cancelled' });
  for (let i = 0; i < QUOTA - 1; i += 1) {
    const next = await restarted.claimOperation({
      op_key: opKey(alice, `restart-window-${i}`), request_digest: `sha256:restart-window-${i}`,
      principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
    });
    assert.equal(next.claimed, true, 'the rolled window did not allow its full allowance');
    await restarted.releaseHolds({ op_id: next.op.op_id, generation: 1, reason: 'cancelled' });
  }
  const spent = changes(h.sqlite);
  await assert.rejects(() => restarted.claimOperation({
    op_key: opKey(alice, 'restart-over'), request_digest: 'sha256:restart-over',
    principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
  }), isLimitError, 'pruning aged receipts refunded the window allowance');
  assert.equal(changes(h.sqlite), spent, 'the post-roll refusal wrote rows');
});

// ---------------------------------------------------------------------------
// 8 — the 21st legitimate job after 20 settlements, when the allowance permits
// ---------------------------------------------------------------------------
async function settleCycle(h, key, maxTokens = 64, deadline_at = T0 + 60000) {
  const flow = await dispatchedOperation(h, {
    principal: alice, max_tokens: maxTokens, op_key: opKey(alice, key), deadline_at,
  });
  const frame = await h.store.leaseNextJob({ resource_id: RES_1 });
  assert.ok(frame && frame.job_id, `no job to lease for ${key}`);
  assert.deepEqual(await h.store.completeJob({
    job_id: frame.job_id, lease_id: frame.lease_id, resource_id: RES_1,
    status: 'succeeded', result: workerResult(frame),
  }), { accepted: true });
  assert.equal((await h.store.settle({
    op_id: flow.op.op_id, generation: 1, job_id: frame.job_id,
    outcome: 'succeeded', result_digest: `sha256:${key}`,
  })).settled, true);
  return flow;
}

test('budget: a 21st legitimate job works after 20 settlements when the allowance permits', async () => {
  const h = createStoreHarness({
    env: quotaEnv(30, 24 * 3600000, {
      INFERENCE_DISPATCH_MAX_OPERATIONS: '20', INFERENCE_OWNER_DAILY_TOKENS: '100000',
    }),
  });
  for (let i = 0; i < 20; i += 1) {
    await settleCycle(h, `settle-${String(i).padStart(2, '0')}`);
    h.clock.advance(1000);
  }
  assert.equal(count(h.sqlite, "SELECT COUNT(*) AS n FROM dispatch_operations WHERE phase = 'settled'"), 20);
  assert.equal(h.sqlite.prepare('SELECT used_tokens FROM dispatch_pool_usage').get().used_tokens, 20 * 64);

  let flow;
  try {
    flow = await admittedOperation(h, { principal: alice, max_tokens: 64, op_key: 'settle-20' });
  } catch (e) {
    assert.fail(`the 21st claim after 20 settlements was refused: ${e.code || e.message}`);
  }
  assert.equal(flow.admitted.outcome, 'admitted', 'the 21st job must admit while the allowance permits');

  // Retained history is bounded by the configured allowance, not by lifetime work.
  assert.ok(opRows(h.sqlite) <= 20 + 30, `retained ${opRows(h.sqlite)} operations for 20 settlements`);
});

// ---------------------------------------------------------------------------
// 8b — a second window of legitimate work, first-window receipts still promised
// ---------------------------------------------------------------------------
test('budget: a second window of legitimate work succeeds while first-window receipts stay replayable', async () => {
  const WINDOW = 3600000;
  const QUOTA = 20;
  const h = createStoreHarness({
    env: quotaEnv(QUOTA, WINDOW, {
      INFERENCE_DISPATCH_MAX_OPERATIONS: '20', INFERENCE_OWNER_DAILY_TOKENS: '100000',
    }),
  });
  const settled = () => count(h.sqlite,
    "SELECT COUNT(*) AS n FROM dispatch_operations WHERE phase = 'settled'");
  const firstFlows = [];
  for (let i = 0; i < QUOTA; i += 1) {
    firstFlows.push(await settleCycle(h, `w1-${String(i).padStart(2, '0')}`));
  }
  assert.equal(settled(), QUOTA, 'a full first window of settled work must be retained');

  const beforeReplay = changes(h.sqlite);
  const replay = await h.store.claimOperation({
    op_key: opKey(alice, 'w1-00'), request_digest: 'sha256:w1-00',
    principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding: firstFlows[0].binding,
  });
  assert.equal(replay.claimed, false);
  assert.equal(replay.op.op_id, firstFlows[0].op.op_id);
  assert.equal(changes(h.sqlite), beforeReplay, 'a first-window replay wrote rows');

  // Hour 2: the rolling allowance refills while every first-window receipt is
  // still inside the promised replay horizon (default 7 days). A design that
  // merely moves the lockout from 20 to 100 cannot satisfy this.
  h.clock.advance(WINDOW + 1);
  h.sqlite.prepare('UPDATE resources SET heartbeat_at = ?')
    .run(new Date(h.clock.now()).toISOString());
  const deadline = h.clock.now() + 60000;
  for (let i = 0; i < QUOTA; i += 1) {
    await settleCycle(h, `w2-${String(i).padStart(2, '0')}`, 64, deadline);
  }
  assert.equal(settled(), 2 * QUOTA, 'the second window of legitimate work was refused');
  assert.notEqual(await h.store.getOperation({ op_key: opKey(alice, 'w1-00') }), null,
    'a first-window receipt was pruned inside the promised replay horizon');
  const afterReplay = changes(h.sqlite);
  const stillReplayable = await h.store.claimOperation({
    op_key: opKey(alice, 'w1-00'), request_digest: 'sha256:w1-00',
    principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding: firstFlows[0].binding,
  });
  assert.equal(stillReplayable.claimed, false, 'the first-window key stopped reconciling after hour 2 work');
  assert.equal(stillReplayable.op.op_id, firstFlows[0].op.op_id);
  assert.equal(changes(h.sqlite), afterReplay, 'the post-hour-2 replay wrote rows');

  // The second window is now saturated: one more fresh key is a zero-write
  // refusal and does not disturb the retained receipts.
  const beforeDenied = changes(h.sqlite);
  await assert.rejects(() => h.store.claimOperation({
    op_key: opKey(alice, 'w2-over'), request_digest: 'sha256:w2-over',
    principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding: firstFlows[0].binding,
  }), isLimitError, 'a saturated second window accepted another claim');
  assert.equal(changes(h.sqlite), beforeDenied, 'the saturated-window refusal wrote rows');
  assert.notEqual(await h.store.getOperation({ op_key: opKey(alice, 'w1-00') }), null,
    'the refusal pruned a receipt inside the replay horizon');
});

// ---------------------------------------------------------------------------
// 9 — quota pressure never prunes unknown or live work
// ---------------------------------------------------------------------------
test('budget: quota pressure never prunes uncertain work, live holds or queued jobs', async () => {
  const h = createStoreHarness({
    env: quotaEnv(6, 3600000, {
      INFERENCE_DISPATCH_MAX_OPERATIONS: '4', INFERENCE_DISPATCH_MAX_ADMISSIONS: '200',
      INFERENCE_OWNER_DAILY_TOKENS: '200',
    }),
  });
  const { binding } = await bindingOverStore(h);

  // Uncertain operation: the claim exists but its outcome is unknown.
  const unc = await h.store.claimOperation({
    op_key: opKey(alice, 'live-uncertain'), request_digest: 'sha256:live-uncertain',
    principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
  });
  await h.store.markUncertain({ op_id: unc.op.op_id, generation: 1, phase: 'holds', detail: 'test' });

  // Live reservation and a queued job.
  const admitted = await admittedOperation(h, { principal: alice, max_tokens: 64, op_key: 'live-admitted' });
  assert.equal(admitted.admitted.outcome, 'admitted');
  const dispatched = await dispatchedOperation(h, { principal: alice, max_tokens: 32, op_key: 'live-dispatched' });

  // Cap pressure: every fresh claim is either released or refused by the allowance.
  for (let i = 0; i < 20; i += 1) {
    try {
      const c = await h.store.claimOperation({
        op_key: opKey(alice, `live-pressure-${i}`), request_digest: `sha256:live-pressure-${i}`,
        principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
      });
      await h.store.releaseHolds({ op_id: c.op.op_id, generation: 1, reason: 'pressure' });
    } catch (e) { if (!isLimitError(e)) throw e; }
  }

  const phases = h.sqlite.prepare('SELECT op_id, phase, uncertain_phase FROM dispatch_operations').all();
  const byId = new Map(phases.map((r) => [r.op_id, r]));
  assert.ok(byId.has(unc.op.op_id), 'uncertain work was pruned under quota pressure');
  assert.equal(byId.get(unc.op.op_id).uncertain_phase, 'holds');
  assert.ok(byId.has(admitted.op.op_id), 'a live admitted operation was pruned');
  assert.ok(byId.has(dispatched.op.op_id), 'a dispatched operation was pruned');
  assert.equal(count(h.sqlite, `SELECT COUNT(*) AS n FROM dispatch_holds
    WHERE op_id = ? AND state = 'committed'`, admitted.op.op_id), 1, 'a committed hold was pruned');
  assert.equal(count(h.sqlite, `SELECT COUNT(*) AS n FROM dispatch_jobs WHERE op_id = ? AND status = 'queued'`,
    dispatched.op.op_id), 1, 'a queued job was pruned');
  const orphans = count(h.sqlite, `SELECT COUNT(*) AS n FROM dispatch_holds h
    WHERE NOT EXISTS (SELECT 1 FROM dispatch_operations o WHERE o.op_id = h.op_id)`);
  assert.equal(orphans, 0, 'pruning left hold rows behind');
});

// ---------------------------------------------------------------------------
// 9b — an uncertain row stays active even after it leaves the active phase
// ---------------------------------------------------------------------------
test('budget: uncertain work released from its phase still occupies the active cap and is never pruned', async () => {
  const h = createStoreHarness({
    env: quotaEnv(6, 3600000, {
      INFERENCE_DISPATCH_MAX_OPERATIONS: '2', INFERENCE_DISPATCH_MAX_ADMISSIONS: '200',
      INFERENCE_OWNER_DAILY_TOKENS: '10000',
    }),
  });
  const { binding } = await bindingOverStore(h);
  const claim = (key) => h.store.claimOperation({
    op_key: opKey(alice, key), request_digest: `sha256:${key}`,
    principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
  });
  const ids = [];
  for (let i = 0; i < 2; i += 1) {
    const c = await claim(`unc-released-${i}`);
    assert.equal(c.claimed, true);
    await h.store.markUncertain({ op_id: c.op.op_id, generation: 1, phase: 'holds', detail: 'test' });
    // Released phase, uncertain outcome: must still count as active.
    assert.deepEqual(await h.store.releaseHolds({ op_id: c.op.op_id, generation: 1, reason: 'test' }),
      { released: 0 });
    ids.push(c.op.op_id);
  }
  const rows = h.sqlite.prepare('SELECT op_id, phase, uncertain_phase FROM dispatch_operations').all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.phase, 'released');
    assert.equal(row.uncertain_phase, 'holds', 'an uncertain marker was dropped by release');
  }
  assert.equal(count(h.sqlite, 'SELECT COUNT(*) AS n FROM dispatch_operations'), 2);

  // Two never-resolved rows fill the active cap even though their phase is
  // terminal; they cannot accumulate outside it and are not pruned for room.
  const before = changes(h.sqlite);
  await assert.rejects(() => claim('unc-released-fresh'), isLimitError,
    'released-but-uncertain rows stopped counting as active');
  assert.equal(changes(h.sqlite), before, 'the refusal wrote rows');
  assert.equal(count(h.sqlite, 'SELECT COUNT(*) AS n FROM dispatch_operations'), 2,
    'an uncertain row was pruned for capacity');
  for (const id of ids) {
    assert.equal(count(h.sqlite, 'SELECT COUNT(*) AS n FROM dispatch_operations WHERE op_id = ? AND uncertain_phase IS NOT NULL', id),
      1, 'an uncertain operation disappeared');
  }
});

// ---------------------------------------------------------------------------
// 10 — bounded terminal history and an explicit replay horizon
// ---------------------------------------------------------------------------
test('budget: terminal history is bounded and the replay horizon is explicit', async () => {
  const QUOTA = 40;
  const RETENTION = 3600000; // the store's documented floor
  const env = quotaEnv(QUOTA, 24 * 3600000, {
    INFERENCE_DISPATCH_MAX_OPERATIONS: '20', INFERENCE_OWNER_DAILY_TOKENS: '100000',
    INFERENCE_DISPATCH_RETENTION_MS: String(RETENTION),
  });
  const h = createStoreHarness({ env });

  const flows = [];
  for (let i = 0; i < 30; i += 1) {
    flows.push(await settleCycle(h, `hist-${String(i).padStart(2, '0')}`, 32));
    h.clock.advance(1000);
  }
  assert.equal(count(h.sqlite, "SELECT COUNT(*) AS n FROM dispatch_operations WHERE phase = 'settled'"), 30);
  assert.ok(opRows(h.sqlite) <= QUOTA,
    `retained ${opRows(h.sqlite)} terminal operations for a ${QUOTA}-claim allowance`);

  // Inside the horizon a settled replay reconciles to the same operation with
  // no write and no second charge.
  const before = changes(h.sqlite);
  const replay = await h.store.claimOperation({
    op_key: opKey(alice, 'hist-00'), request_digest: 'sha256:hist-00',
    principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding: flows[0].binding,
  });
  assert.equal(replay.claimed, false, 'a retained settled key must reconcile, not re-dispatch');
  assert.equal(replay.op.op_id, flows[0].op.op_id);
  assert.equal(changes(h.sqlite), before, 'a retained replay wrote rows');
  assert.equal((await h.store.settle({
    op_id: flows[0].op.op_id, generation: 1, job_id: flows[0].job_id,
    outcome: 'succeeded', result_digest: 'sha256:hist-00',
  })).settled, false, 'a replay must not settle twice');

  // Past the horizon the receipt is pruned by the next claim batch; the key then
  // becomes a new operation and never silently re-dispatches a retained one.
  h.clock.advance(RETENTION + 1);
  const fresh = await h.store.claimOperation({
    op_key: opKey(alice, 'hist-after-horizon'), request_digest: 'sha256:hist-after-horizon',
    principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding: flows[0].binding,
  });
  assert.equal(fresh.claimed, true, 'the allowance locked the principal out after the horizon');
  assert.equal(await h.store.getOperation({ op_key: opKey(alice, 'hist-00') }), null,
    'an aged settled receipt was not pruned at the documented horizon');
  assert.equal(count(h.sqlite, `SELECT COUNT(*) AS n FROM dispatch_settlements s
    WHERE NOT EXISTS (SELECT 1 FROM dispatch_operations o WHERE o.op_id = s.op_id)`), 0,
    'pruning left settlement rows behind');
  const reuse = await h.store.claimOperation({
    op_key: opKey(alice, 'hist-00'), request_digest: 'sha256:hist-00-new',
    principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding: flows[0].binding,
  });
  assert.equal(reuse.claimed, true, 'the key was locked out forever instead of starting a new operation');
  assert.notEqual(reuse.op.op_id, flows[0].op.op_id);
  assert.ok(opRows(h.sqlite) <= QUOTA, 'history grew past the allowance after the horizon');
});

// ---------------------------------------------------------------------------
// 11 — a lowered cap or quota never prunes a fresh settled receipt
// ---------------------------------------------------------------------------
test('budget: lowering the caps never prunes a fresh settled receipt or re-dispatches its key', async () => {
  const env = quotaEnv(10, 24 * 3600000, {
    INFERENCE_DISPATCH_MAX_OPERATIONS: '10', INFERENCE_OWNER_DAILY_TOKENS: '100000',
  });
  const h = createStoreHarness({ env });
  const keys = Array.from({ length: 5 }, (_, i) => `lower-${String(i).padStart(2, '0')}`);
  const flows = [];
  for (const key of keys) flows.push(await settleCycle(h, key, 32));
  assert.equal(count(h.sqlite, "SELECT COUNT(*) AS n FROM dispatch_operations WHERE phase = 'settled'"), 5);

  // Operator lowers every cap. Fresh receipts are inside the promised replay
  // horizon and no policy may count-prune them to satisfy the smaller number.
  const small = { ...env, INFERENCE_DISPATCH_MAX_OPERATIONS: '1', INFERENCE_DISPATCH_MAX_ADMISSIONS: '1' };
  for (const k of BUDGET_KEYS) small[k] = '1';
  const restarted = createD1DispatchStore(h.db, { now: h.clock.now, env: small });
  try {
    await restarted.claimOperation({
      op_key: opKey(alice, 'lower-fresh'), request_digest: 'sha256:lower-fresh',
      principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding: flows[0].binding,
    });
  } catch (e) {
    if (!isLimitError(e)) throw e;
  }

  for (let i = 0; i < keys.length; i += 1) {
    const row = await restarted.getOperation({ op_key: opKey(alice, keys[i]) });
    assert.ok(row, `the settled receipt for ${keys[i]} was pruned by a lowered cap inside the replay horizon`);
    assert.equal(row.phase, 'settled');
    const replay = await restarted.claimOperation({
      op_key: opKey(alice, keys[i]), request_digest: 'sha256:lower-replay',
      principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding: flows[0].binding,
    });
    assert.equal(replay.claimed, false, `${keys[i]} was re-dispatched after the cap change`);
    assert.equal(replay.op.op_id, flows[i].op.op_id, `${keys[i]} no longer reconciles to its original operation`);
  }
});

// ---------------------------------------------------------------------------
// 12 — a prune decision that read ids outside its batch must not delete a
//      child row of an operation another store made uncertain in between
// ---------------------------------------------------------------------------
const REAL_STMT = Symbol('real-statement');

function dbWithReadHook(db, onFirstOperationRead) {
  let inBatch = 0;
  let fired = false;
  const maybe = async (sql) => {
    if (inBatch || fired) return;
    if (!/^\s*SELECT\b/i.test(sql) || !/dispatch_operations/.test(sql)) return;
    // Only a read that picks prune candidates can split the decision from its
    // deletes. The plain existence check on the requesting key cannot.
    if (!/uncertain_phase\s+IS\s+NULL/i.test(sql)) return;
    fired = true;
    await onFirstOperationRead(sql);
  };
  const wrap = (stmt, sql) => new Proxy(stmt, {
    get(target, prop) {
      if (prop === REAL_STMT) return target;
      if (prop === 'bind') return (...args) => wrap(target.bind(...args), sql);
      if (prop === 'first') return async (...args) => {
        const out = await target.first(...args);
        await maybe(sql);
        return out;
      };
      if (prop === 'all') return async (...args) => {
        const out = await target.all(...args);
        await maybe(sql);
        return out;
      };
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    async batch(statements) {
      inBatch += 1;
      try {
        return await db.batch(statements.map((s) => s[REAL_STMT] || s));
      } finally {
        inBatch -= 1;
      }
    },
    exec: (sql) => db.exec(sql),
  };
}

test('budget: a markUncertain racing a prune decision keeps the operation and every child row', async () => {
  const h = createStoreHarness({
    env: quotaEnv(10, 3600000, {
      INFERENCE_DISPATCH_MAX_OPERATIONS: '1', INFERENCE_DISPATCH_MAX_ADMISSIONS: '200',
      INFERENCE_OWNER_DAILY_TOKENS: '10000',
    }),
  });
  const { binding } = await bindingOverStore(h);
  // One released operation owning a released hold row: prunable, with a child.
  const victim = await h.store.claimOperation({
    op_key: opKey(alice, 'race-victim'), request_digest: 'sha256:race-victim',
    principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
  });
  assert.equal(victim.claimed, true);
  assert.equal((await h.store.acquireHold({
    op_id: victim.op.op_id, generation: 1, pool_id: binding.pools[0].pool_id, amount: binding.pools[0].amount,
  })).held, true);
  assert.deepEqual(await h.store.releaseHolds({ op_id: victim.op.op_id, generation: 1, reason: 'cancelled' }),
    { released: 1 });

  let raced = false;
  let hookSql = null;
  const hooked = dbWithReadHook(h.db, async (sql) => {
    hookSql = sql;
    const marked = await h.store.markUncertain({
      op_id: victim.op.op_id, generation: 1, phase: 'prune-race', detail: 'concurrent uncertainty',
    });
    raced = marked.recorded === true;
  });
  const store = createD1DispatchStore(hooked, {
    now: h.clock.now,
    env: { ...quotaEnv(10, 3600000, {
      INFERENCE_DISPATCH_MAX_OPERATIONS: '1', INFERENCE_DISPATCH_MAX_ADMISSIONS: '200',
      INFERENCE_OWNER_DAILY_TOKENS: '10000',
    }) },
  });
  try {
    await store.claimOperation({
      op_key: opKey(alice, 'race-fresh'), request_digest: 'sha256:race-fresh',
      principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
    });
  } catch (e) {
    if (!isLimitError(e)) throw e;
  }

  if (raced) {
    const op = h.sqlite.prepare('SELECT uncertain_phase FROM dispatch_operations WHERE op_id = ?')
      .get(victim.op.op_id);
    assert.ok(op, `the pruning read (${hookSql}) ran outside its batch and the operation was deleted after a concurrent markUncertain`);
    assert.equal(op.uncertain_phase, 'prune-race', 'the operation survived but its uncertainty marker was lost');
    assert.equal(count(h.sqlite, `SELECT COUNT(*) AS n FROM dispatch_holds WHERE op_id = ?`, victim.op.op_id), 1,
      'a child hold row was deleted although the operation was protected by a concurrent markUncertain');
    for (const table of ['dispatch_holds', 'dispatch_fences', 'dispatch_jobs', 'dispatch_settlements',
      'dispatch_start_redemptions']) {
      assert.equal(count(h.sqlite, `SELECT COUNT(*) AS n FROM ${table} t
        WHERE NOT EXISTS (SELECT 1 FROM dispatch_operations o WHERE o.op_id = t.op_id)`), 0,
        `pruning deleted a ${table} row while keeping its operation`);
    }
  } else {
    // The hook fired only after the claim batch: the prune decision and its
    // child deletes were one atomic unit, so the race could not split them.
    const op = await h.store.getOperation({ op_key: opKey(alice, 'race-victim') });
    assert.equal(op, null, 'the mark landed before the prune batch, so the victim should have been kept');
    assert.equal(count(h.sqlite, 'SELECT COUNT(*) AS n FROM dispatch_holds WHERE op_id = ?', victim.op.op_id), 0,
      'pruning removed the operation but left its hold row');
  }
});

// ---------------------------------------------------------------------------
// 13 — live protected work that never reached the uncertain flag still counts
//      against the active cap (crash between release gate and refunds)
// ---------------------------------------------------------------------------
test('budget: a crash between the release gate and its refunds leaves protected work that consumes the cap', async () => {
  const env = quotaEnv(10, 3600000, {
    INFERENCE_DISPATCH_MAX_OPERATIONS: '1', INFERENCE_DISPATCH_MAX_ADMISSIONS: '200',
    INFERENCE_OWNER_DAILY_TOKENS: '10000',
  });
  const h = createStoreHarness({ env });
  const flow = await admittedOperation(h, { principal: alice, max_tokens: 64, op_key: opKey(alice, 'crash-op') });
  assert.equal(flow.admitted.outcome, 'admitted');
  assert.deepEqual(await h.store.fenceStart({ op_id: flow.op.op_id, generation: 1, reason: 'cancel' }),
    { outcome: 'fenced' });

  // Crash exactly between the release gate batch and the refund batch: the
  // operation is `released` but its hold is still `committed`, and no
  // uncertain flag was ever written.
  const realBatch = h.db.batch.bind(h.db);
  let batches = 0;
  const crashingDb = {
    prepare: h.db.prepare.bind(h.db),
    exec: h.db.exec.bind(h.db),
    async batch(statements) {
      batches += 1;
      if (batches === 2) throw new Error('simulated crash between the release gate and its refunds');
      return realBatch(statements);
    },
  };
  const crashing = createD1DispatchStore(crashingDb, { now: h.clock.now, env });
  await assert.rejects(() => crashing.releaseHolds({
    op_id: flow.op.op_id, generation: 1, reason: 'crash',
  }), /simulated crash/);

  const row = h.sqlite.prepare('SELECT phase, uncertain_phase FROM dispatch_operations WHERE op_id = ?')
    .get(flow.op.op_id);
  assert.equal(row.phase, 'released');
  assert.equal(row.uncertain_phase, null, 'the fixture must model a crash without an uncertainty marker');
  assert.equal(count(h.sqlite, `SELECT COUNT(*) AS n FROM dispatch_holds WHERE op_id = ? AND state = 'committed'`,
    flow.op.op_id), 1, 'the reservation must survive the crash');

  // The stuck reservation is live protected work: it consumes the active cap
  // even though its phase is terminal, and no pressure may prune it.
  const before = changes(h.sqlite);
  for (let i = 0; i < 5; i += 1) {
    try {
      await h.store.claimOperation({
        op_key: opKey(alice, `crash-fresh-${i}`), request_digest: `sha256:crash-fresh-${i}`,
        principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding: flow.binding,
      });
    } catch (e) {
      if (!isLimitError(e)) throw e;
    }
  }
  assert.equal(changes(h.sqlite), before, 'claim attempts under the stuck reservation wrote rows');
  assert.equal(count(h.sqlite, 'SELECT COUNT(*) AS n FROM dispatch_operations WHERE op_id = ?', flow.op.op_id), 1,
    'live protected work was pruned for capacity');
  assert.equal(count(h.sqlite, `SELECT COUNT(*) AS n FROM dispatch_holds WHERE op_id = ? AND state = 'committed'`,
    flow.op.op_id), 1, 'the committed hold was pruned');
  assert.equal(h.sqlite.prepare('SELECT used_tokens FROM dispatch_pool_usage').get().used_tokens, 64,
    'the unrefunded charge must stay charged until the reservation is repaired');
});

// ---------------------------------------------------------------------------
// 14 — a claim that loses a same-key race must not run its cleanup
// ---------------------------------------------------------------------------
test('budget: a losing same-key racer writes nothing after the winner and appends one claim event', async () => {
  const env = quotaEnv(20, 3600000, {
    INFERENCE_DISPATCH_MAX_OPERATIONS: '200', INFERENCE_DISPATCH_MAX_ADMISSIONS: '200',
    INFERENCE_OWNER_DAILY_TOKENS: '100000',
  });
  const h = createStoreHarness({ env });
  const raceKey = opKey(alice, 'same-key-race');
  const { binding } = await bindingOverStore(h);

  let pause = null;
  let winner = null;
  let resumeAt = 0;
  let agedBeforeResume = 0;
  let ledgerAfterWinner = 0;
  let ledgerAtResume = 0;
  const ledgerRows = () => {
    const tables = h.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) LIKE '%claim%'").all()
      .map((r) => r.name)
      .filter((n) => n !== 'dispatch_operations');
    return tables.reduce((sum, t) =>
      sum + count(h.sqlite, `SELECT COUNT(*) AS n FROM ${t} WHERE principal_id = ?`, alice.principal_id), 0);
  };
  const pausedDb = {
    prepare(sql) {
      const stmt = h.db.prepare(sql);
      if (!/^\s*SELECT \* FROM dispatch_operations WHERE op_key = \?\s*$/.test(sql)) return stmt;
      return {
        sql, params: [],
        bind: (...args) => {
          const bound = stmt.bind(...args);
          return {
            sql, params: args,
            all: (...a) => bound.all(...a),
            run: () => bound.run(),
            first: async () => {
              const stale = await bound.first(); // the pre-race lookup, still null
              if (pause) { const p = pause; pause = null; await p(); }
              return stale;
            },
          };
        },
        all: (...a) => stmt.all(...a),
        run: () => stmt.run(),
        first: (...a) => stmt.first(...a),
      };
    },
    batch: (statements) => h.db.batch(statements),
    exec: (sql) => h.db.exec(sql),
  };

  pause = async () => {
    // Another store wins the same idempotency key while this claim is paused.
    winner = await h.store.claimOperation({
      op_key: raceKey, request_digest: 'sha256:same-key-race',
      principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
    });
    assert.equal(winner.claimed, true, 'the winner could not claim the key');
    ledgerAfterWinner = ledgerRows();
    // Work that becomes prunable only after the winner's own cleanup ran, so the
    // loser still has candidates to delete if its cleanup is not gated.
    for (let i = 0; i < 6; i += 1) await settleCycle(h, `race-aged-${i}`);
    h.sqlite.prepare('UPDATE dispatch_operations SET updated_at = ? WHERE phase = ?')
      .run(new Date(T0 - 8 * 24 * 3600 * 1000).toISOString(), 'settled');
    agedBeforeResume = count(h.sqlite,
      'SELECT COUNT(*) AS n FROM dispatch_operations WHERE phase = ?', 'settled');
    ledgerAtResume = ledgerRows();
    resumeAt = changes(h.sqlite);
  };

  const loser = createD1DispatchStore(pausedDb, { now: h.clock.now, env });
  const result = await loser.claimOperation({
    op_key: raceKey, request_digest: 'sha256:same-key-race',
    principal_id: alice.principal_id, tenant_id: alice.tenant_id, binding,
  });

  assert.equal(result.claimed, false, 'the loser must report a replay, not a new claim');
  assert.equal(result.op.op_id, winner.op.op_id, 'the loser replayed a different operation');
  assert.equal(agedBeforeResume, 6, 'the fixture must leave six aged families for the loser to prune');
  assert.equal(changes(h.sqlite) - resumeAt, 0,
    'the losing claim wrote rows after the winner completed: its cleanup is not gated on the same key');
  assert.equal(count(h.sqlite, 'SELECT COUNT(*) AS n FROM dispatch_operations WHERE op_key = ?', raceKey), 1,
    'a losing same-key claim created a second operation row');
  assert.equal(count(h.sqlite, 'SELECT COUNT(*) AS n FROM dispatch_operations WHERE phase = ?', 'settled'), 6,
    'the loser deleted settled history that the winner owned');

  if (ledgerAfterWinner > 0) {
    assert.equal(ledgerAfterWinner, 1, 'the winning claim did not record exactly one ledger event');
    assert.equal(ledgerRows(), ledgerAtResume, 'the losing claim appended a second ledger event');
  }
});

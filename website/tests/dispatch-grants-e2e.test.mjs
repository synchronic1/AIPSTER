// W3 independent validation of the grant path through the REAL L2 routes over
// the REAL L1 D1 dispatch store (no store injection). Bob runs on Alice's
// resource only through a live app grant, which the issuer normalizes into one
// complete no-stitching fabric/policy.mjs authority. Every refusal, revocation
// point, quota exhaustion, and used_jobs/used_tokens movement is asserted
// against the real `grants` row. No network and no inference: the worker side
// is played here with the worker's own wire shapes.
//
// The final case runs the same accounting invariants on real local D1
// (Miniflare/workerd), across independent store instances, matching the repo's
// existing real-D1 harness in dispatch-store-d1.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createTestEnv, readJson, MIGRATION_FILES } from './d1-shim.mjs';
import { createD1DispatchStore } from '../src/inference/dispatch-store.mjs';
import { createDispatchCoordinator } from '../src/inference/dispatch-coordinator.mjs';

const MODEL = 'qwen3.8-27b-atx-iq4_xs';
const ENABLED = { INFERENCE_ENABLED: '1', INFERENCE_OWNER_DAILY_TOKENS: '8192' };
const S = (t, user) => ({ ...t.as(user), ...t.csrf });
const K = (secret) => ({ Authorization: `Bearer ${secret}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ready(t, user = t.alice) {
  const res = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: S(t, user), body: { name: 'box', kind: 'local', origin: 'lab', cpu: 'x', gpu: 'y' },
  }));
  assert.equal(res.status, 201, res.text);
  const hb = await readJson(await t.call('/api/keys', {
    method: 'POST', headers: S(t, user), body: { name: 'hb', scope: 'heartbeat', resourceId: res.json.id },
  }));
  assert.equal(hb.status, 201, hb.text);
  const beat = await t.call(`/api/resources/${res.json.id}/heartbeat`, {
    method: 'POST', headers: K(hb.json.secret), body: JSON.stringify({ usable: true }),
  });
  assert.equal(beat.status, 200, await beat.text());
  return { resourceId: res.json.id, hb: hb.json.secret };
}

const share = async (t, resourceId, maxJobs, maxTokens) => readJson(await t.call('/api/grants', {
  method: 'POST', headers: S(t, t.alice),
  body: { resourceId, grantee: 'bob@example.com', maxJobs, maxTokens },
}));
const revoke = async (t, grantId) => readJson(await t.call(`/api/grants/${grantId}`, {
  method: 'DELETE', headers: S(t, t.alice),
}));

const mintAdmission = async (t, user, r, maxTokens = 100) => readJson(await t.call('/api/inference/admissions', {
  method: 'POST', headers: S(t, user), body: { resource_id: r.resourceId, model_id: MODEL, max_tokens: maxTokens },
}));

const bodyFor = (admissionRef, key, over = {}) => ({
  contract_version: 'v1.0.0', admission_ref: admissionRef, idempotency_key: key,
  model_id: MODEL, prompt: 'Reply with exactly: hello', max_tokens: 100,
  deadline_at: Date.now() + 60000, ...over,
});
const submit = async (t, user, body) => readJson(await t.call('/api/jobs', {
  method: 'POST', headers: S(t, user), body,
}));

async function lease(t, r) {
  const res = await t.call('/api/worker/jobs/next', { headers: K(r.hb) });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

const succeeded = (l, content = 'hello') => {
  const p = l.envelope.task.placement, b = l.envelope.binding;
  return { lease_id: l.lease_id, status: 'succeeded', result: {
    request_id: l.job_id, node_id: p.node_id, runtime_id: p.runtime_id, model_id: l.envelope.task.model_id,
    runtime_instance: b.runtime_instance, model_fingerprint: b.model_fingerprint,
    simulated: false, content, elapsed_ms: 9, usage: { completion_tokens: 1 }, cache: {} } };
};
const failed = (l) => ({ lease_id: l.lease_id, status: 'failed',
  result: { reason: 'MODEL_UNAVAILABLE', detail: 'model_id', elapsed_ms: 4, usage: {}, cache: {} } });
const postResult = (t, r, jobId, body) => t.call(`/api/worker/jobs/${jobId}/result`, {
  method: 'POST', headers: K(r.hb), body,
});

const grantRow = (t, id) => t.DB.prepare(
  'SELECT used_jobs, used_tokens, max_jobs, max_tokens FROM grants WHERE id = ?').bind(id).first();
const jobCount = async (t) => (await t.DB.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').all()).results[0].n;
const opPhases = async (t) => (await t.DB.prepare(
  'SELECT phase FROM dispatch_operations ORDER BY created_at').all()).results.map((r) => r.phase);

async function assertAccounting(t, grantId, jobs, tokens) {
  const row = await grantRow(t, grantId);
  assert.equal(Number(row.used_jobs), jobs, `used_jobs must be exactly ${jobs}`);
  assert.equal(Number(row.used_tokens), tokens, `used_tokens must be exactly ${tokens}`);
  assert.ok(Number(row.used_jobs) >= 0, 'used_jobs is never negative');
  assert.ok(Number(row.used_tokens) >= 0, 'used_tokens is never negative');
}

// Pass-through DB that waits at one chosen statement (deterministic race).
function gateOn(t, matcher) {
  let fired = false;
  let enter; const entered = new Promise((r) => { enter = r; });
  let open; const gate = new Promise((r) => { open = r; });
  const real = t.DB;
  t.env.DB = {
    prepare: (sql) => real.prepare(sql),
    exec: (sql) => real.exec(sql),
    batch: async (stmts) => {
      if (!fired && stmts.some((s) => matcher.test(s.sql || ''))) { fired = true; enter(); await gate; }
      return real.batch(stmts);
    },
  };
  return { entered, open };
}

// Pass-through DB that delays only the server-side admission lookup.
function delayAdmissionLookup(t) {
  const real = t.DB;
  let delayed = false;
  t.env.DB = {
    prepare: (sql) => {
      const st = real.prepare(sql);
      if (!/FROM dispatch_admissions/.test(sql) || !/admission_ref = \?/.test(sql)) return st;
      return { bind: (...args) => {
        const bind = st.bind(...args);
        return { ...bind, first: async (col) => {
          if (!delayed) { delayed = true; await sleep(600); }
          return bind.first(col);
        } };
      } };
    },
    exec: (sql) => real.exec(sql),
    batch: (stmts) => real.batch(stmts),
  };
}

// ------------------------------------------------------------ happy path

test('a live grant runs Bob on Alice\'s resource: exact accounting, content released once', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const g = await share(t, r.resourceId, 3, 1000);
  assert.equal(g.status, 201, g.text);
  const grantId = g.json.id;

  const admission = await mintAdmission(t, t.bob, r);
  assert.equal(admission.status, 201, admission.text);
  // The stored admission is pinned to the real grant and its pool.
  const stored = await t.DB.prepare('SELECT grant_id, pools_json FROM dispatch_admissions WHERE admission_ref = ?')
    .bind(admission.json.admission_ref).first();
  assert.equal(stored.grant_id, grantId, 'the admission is covered by exactly the live grant');
  assert.deepEqual(JSON.parse(stored.pools_json), [{ pool_id: `grant:${grantId}`, amount: 100 }],
    'the hold is charged to the grant pool, not the owner pool');

  const submitted = await submit(t, t.bob, bodyFor(admission.json.admission_ref, 'bob-grant-00000001'));
  assert.equal(submitted.status, 202, submitted.text);
  assert.equal(submitted.json.status, 'dispatched');
  await assertAccounting(t, grantId, 1, 100); // conservative hold at submit

  const l = await lease(t, r);
  assert.equal(l.status, 200);
  assert.equal(l.body.job_id, submitted.json.job_id);
  const ok = await readJson(await postResult(t, r, l.body.job_id, succeeded(l.body)));
  assert.equal(ok.status, 200, ok.text);

  const done = await readJson(await t.call('/api/jobs/bob-grant-00000001', { headers: S(t, t.bob) }));
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.status, 'settled');
  assert.equal(done.json.outcome.content, 'hello');
  assert.equal(done.json.outcome.released, true);
  const again = await readJson(await t.call('/api/jobs/bob-grant-00000001', { headers: S(t, t.bob) }));
  assert.equal(again.status, 200);
  assert.equal(again.json.outcome?.content, undefined, 'content is released exactly once');
  await assertAccounting(t, grantId, 1, 100); // settled once, charged once

  // The grant is now 1/100 spent of 3/1000; Alice's owner-side view agrees.
  const listed = await readJson(await t.call('/api/grants', { headers: S(t, t.alice) }));
  const shown = listed.json.items.find((x) => x.id === grantId);
  assert.equal(shown.usedJobs, 1);
  assert.equal(shown.usedTokens, 100);
});

test('without a grant Bob cannot mint an admission, and the refusal hides the resource', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const refusal = await mintAdmission(t, t.bob, r);
  assert.equal(refusal.status, 404, refusal.text);
  assert.equal(refusal.json.code, 'NOT_FOUND');
  const unknown = await mintAdmission(t, t.bob, { resourceId: 'r_does_not_exist' });
  assert.equal(unknown.status, 404);
  assert.deepEqual(refusal.json, unknown.json, 'foreign and unknown resources look identical');
  assert.equal((await t.DB.prepare('SELECT COUNT(*) AS n FROM dispatch_admissions').all()).results[0].n, 0);
});

// -------------------------------------------------------------- revocation

test('a revoked grant refuses new admissions and a pre-minted admission cannot submit', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const g = await share(t, r.resourceId, 5, 1000);
  assert.equal(g.status, 201, g.text);
  const admission = await mintAdmission(t, t.bob, r);
  assert.equal(admission.status, 201, admission.text);

  const rev = await revoke(t, g.json.id);
  assert.equal(rev.status, 200, rev.text);

  // Between admission issuance and submit: the advisory live read refuses.
  const refused = await submit(t, t.bob, bodyFor(admission.json.admission_ref, 'bob-revoked-000001'));
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.json.code, 'NO_MATCHING_GRANT');
  assert.equal(await jobCount(t), 0);
  assert.equal(await t.DB.prepare('SELECT COUNT(*) AS n FROM dispatch_operations').all()
    .then((x) => x.results[0].n), 0, 'refused before any operation was claimed');
  await assertAccounting(t, g.json.id, 0, 0);

  // A new admission is refused outright (revoked grants authorize nothing).
  const after = await mintAdmission(t, t.bob, r);
  assert.equal(after.status, 404, after.text);
  assert.equal(after.json.code, 'NOT_FOUND');
});

test('a grant revoked between the admission CAS and start redemption refuses the start and releases holds', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const g = await share(t, r.resourceId, 5, 1000);
  const admission = await mintAdmission(t, t.bob, r);
  assert.equal(admission.status, 201, admission.text);

  // Freeze the submit at start redemption: holds are committed, admission done.
  const gate = gateOn(t, /SET\s+phase\s*=\s*'redeemed'/i);
  const pending = submit(t, t.bob, bodyFor(admission.json.admission_ref, 'bob-revoke-start01'));
  await gate.entered;
  assert.deepEqual(await opPhases(t), ['admitted']);
  await assertAccounting(t, g.json.id, 1, 100);

  const rev = await revoke(t, g.json.id);
  assert.equal(rev.status, 200, rev.text);
  gate.open();
  const out = await pending;

  assert.equal(out.status, 409, out.text);
  assert.equal(out.json.code, 'START_REFUSED');
  assert.equal(out.json.reason, 'revoked', 'revoke serializes with start redemption in the same store');
  assert.deepEqual(await opPhases(t), ['released']);
  assert.equal(await jobCount(t), 0, 'no job was ever queued');
  await assertAccounting(t, g.json.id, 0, 0);
});

test('a grant revoked after start withholds the content but still charges once', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const g = await share(t, r.resourceId, 5, 1000);
  const admission = await mintAdmission(t, t.bob, r);
  const submitted = await submit(t, t.bob, bodyFor(admission.json.admission_ref, 'bob-revoke-late01'));
  assert.equal(submitted.status, 202, submitted.text);

  // Redemption already happened, so the job may run; only the release rechecks.
  const rev = await revoke(t, g.json.id);
  assert.equal(rev.status, 200, rev.text);
  const l = await lease(t, r);
  assert.equal(l.status, 200, 'a redeemed start is not retracted by a later revoke');
  const ok = await readJson(await postResult(t, r, l.body.job_id, succeeded(l.body)));
  assert.equal(ok.status, 200, ok.text);

  const done = await readJson(await t.call('/api/jobs/bob-revoke-late01', { headers: S(t, t.bob) }));
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.status, 'settled');
  assert.equal(done.json.outcome.released, false);
  assert.equal(done.json.outcome.withheld_reason, 'authority_revoked_before_release');
  assert.equal(done.json.outcome.content, undefined);
  await assertAccounting(t, g.json.id, 1, 100); // charged once, not released
});

// ---------------------------------------------------------- quota exhaustion

test('grant max_jobs exhaustion refuses the next admission and a pre-minted submit', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const g = await share(t, r.resourceId, 1, 1000);
  assert.equal(g.status, 201, g.text);

  const first = await mintAdmission(t, t.bob, r);
  const second = await mintAdmission(t, t.bob, r); // minted while the job quota was still free
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const s1 = await submit(t, t.bob, bodyFor(first.json.admission_ref, 'bob-jobs-00000001'));
  assert.equal(s1.status, 202, s1.text);
  const l = await lease(t, r);
  assert.equal(l.status, 200);
  assert.equal((await postResult(t, r, l.body.job_id, succeeded(l.body))).status, 200);
  assert.equal((await readJson(await t.call('/api/jobs/bob-jobs-00000001', {
    headers: S(t, t.bob),
  }))).status, 200);
  await assertAccounting(t, g.json.id, 1, 100);

  // The pre-minted second admission cannot commit another hold.
  const s2 = await submit(t, t.bob, bodyFor(second.json.admission_ref, 'bob-jobs-00000002'));
  assert.equal(s2.status, 429, s2.text);
  assert.equal(s2.json.code, 'BUDGET_EXHAUSTED');
  assert.equal(await jobCount(t), 1, 'the refused submit queued nothing');
  await assertAccounting(t, g.json.id, 1, 100);

  const third = await mintAdmission(t, t.bob, r);
  assert.equal(third.status, 404, third.text);
});

test('grant max_tokens exhaustion refuses the next admission and a pre-minted submit', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const g = await share(t, r.resourceId, 5, 100);
  assert.equal(g.status, 201, g.text);

  const first = await mintAdmission(t, t.bob, r, 100);
  const second = await mintAdmission(t, t.bob, r, 100); // both fit while nothing was held
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const s1 = await submit(t, t.bob, bodyFor(first.json.admission_ref, 'bob-tokens-0000001'));
  assert.equal(s1.status, 202, s1.text);
  await assertAccounting(t, g.json.id, 1, 100);

  const s2 = await submit(t, t.bob, bodyFor(second.json.admission_ref, 'bob-tokens-0000002'));
  assert.equal(s2.status, 429, s2.text);
  assert.equal(s2.json.code, 'BUDGET_EXHAUSTED');
  await assertAccounting(t, g.json.id, 1, 100);

  const third = await mintAdmission(t, t.bob, r, 100);
  assert.equal(third.status, 404, third.text);
});

// ------------------------------------------------------- accounting matrix

test('grant accounting is exact and never negative after success, failure, cancel and expiry', async () => {
  // success
  {
    const t = await createTestEnv(ENABLED);
    const r = await ready(t);
    const g = await share(t, r.resourceId, 5, 1000);
    const a = await mintAdmission(t, t.bob, r);
    assert.equal((await submit(t, t.bob, bodyFor(a.json.admission_ref, 'bob-acct-success1'))).status, 202);
    const l = await lease(t, r);
    assert.equal((await postResult(t, r, l.body.job_id, succeeded(l.body))).status, 200);
    assert.equal((await readJson(await t.call('/api/jobs/bob-acct-success1', { headers: S(t, t.bob) }))).status, 200);
    await assertAccounting(t, g.json.id, 1, 100);
  }
  // failure: the full admitted envelope is charged, no content
  {
    const t = await createTestEnv(ENABLED);
    const r = await ready(t);
    const g = await share(t, r.resourceId, 5, 1000);
    const a = await mintAdmission(t, t.bob, r);
    assert.equal((await submit(t, t.bob, bodyFor(a.json.admission_ref, 'bob-acct-failure1'))).status, 202);
    const l = await lease(t, r);
    assert.equal((await postResult(t, r, l.body.job_id, failed(l.body))).status, 200);
    const done = await readJson(await t.call('/api/jobs/bob-acct-failure1', { headers: S(t, t.bob) }));
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json.outcome.finish, 'failed');
    assert.equal(done.json.outcome.released, false);
    await assertAccounting(t, g.json.id, 1, 100);
  }
  // cancel before start: the conservative charge is compensated, exactly once
  {
    const t = await createTestEnv(ENABLED);
    const r = await ready(t);
    const g = await share(t, r.resourceId, 5, 1000);
    const a = await mintAdmission(t, t.bob, r);
    const gate = gateOn(t, /SET\s+phase\s*=\s*'redeemed'/i);
    const pending = submit(t, t.bob, bodyFor(a.json.admission_ref, 'bob-acct-cancel01'));
    await gate.entered;
    await assertAccounting(t, g.json.id, 1, 100);
    const canc = await readJson(await t.call('/api/jobs/bob-acct-cancel01/cancel', {
      method: 'POST', headers: S(t, t.bob),
    }));
    assert.equal(canc.status, 200, canc.text);
    gate.open();
    assert.equal((await pending).status, 409);
    await assertAccounting(t, g.json.id, 0, 0);
    assert.equal(await jobCount(t), 0);
  }
  // deadline expired before start: the charge is compensated
  {
    const t = await createTestEnv(ENABLED);
    const r = await ready(t);
    const g = await share(t, r.resourceId, 5, 1000);
    const a = await mintAdmission(t, t.bob, r);
    delayAdmissionLookup(t);
    const out = await submit(t, t.bob, bodyFor(a.json.admission_ref, 'bob-acct-expiry01', {
      deadline_at: Date.now() + 300,
    }));
    assert.equal(out.status, 504, out.text);
    assert.equal(out.json.status, 'expired_before_start');
    await assertAccounting(t, g.json.id, 0, 0);
    assert.equal(await jobCount(t), 0);
  }
});

// ------------------------------------------------- real local D1 (Miniflare)

async function applyFile(db, file) {
  const sql = (await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'))
    .split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  for (const stmt of sql.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
    await db.exec(stmt);
  }
}

const T0 = Date.parse('2026-03-01T12:00:00.000Z');
const BOB = Object.freeze({ principal_id: 'user-bob', tenant_id: 'user-bob', actor_kind: 'session' });

function bindingFor(admission, deadlineAt = T0 + 60000) {
  return {
    admission_ref: admission.admission_ref, principal_id: admission.principal_id,
    tenant_id: admission.tenant_id, grant_id: admission.grant_id,
    grant_revision: admission.grant_revision, resource_id: admission.resource_id,
    incarnation: admission.incarnation, node_id: admission.node_id,
    runtime_id: admission.runtime_id, runtime_instance: admission.runtime_instance,
    model_id: admission.model_id, model_fingerprint: admission.model_fingerprint,
    pools: admission.pools.map((p) => ({ pool_id: p.pool_id, amount: p.amount })),
    deadline_at: deadlineAt,
  };
}

test('real D1: parallel submits across store instances never over-commit; holds release at most once and never after start', async (c) => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: 'export default {fetch(){return new Response("synthetic")}}',
    compatibilityDate: '2026-10-01', d1Databases: { DB: 'w3-grants' },
    outboundService: () => { throw new Error('Unexpected outbound request'); },
  }));
  c.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of MIGRATION_FILES) await applyFile(db, file);

  const created = new Date(T0 - 60 * 60 * 1000).toISOString();
  const at = new Date(T0).toISOString();
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
    VALUES ('grant-1', 'res-1', 'user-alice', 'user-bob', 5, 200, 0, 0, 1, ?)`).bind(created).run();
  await db.prepare(`INSERT INTO grants
    (id, resource_id, owner_id, grantee_id, max_jobs, max_tokens, used_jobs, used_tokens, inference_only, created_at)
    VALUES ('grant-2', 'res-2', 'user-alice', 'user-bob', 5, 100, 0, 0, 1, ?)`).bind(created).run();

  const clock = () => T0;
  const env = { INFERENCE_OWNER_DAILY_TOKENS: '10000' };
  const used = (id) => db.prepare('SELECT used_jobs, used_tokens FROM grants WHERE id = ?').bind(id).first();

  // One coordinator per independent store instance: the in-isolate mutex does
  // not serialize them, so only the conditional SQL protects the budget.
  const stores = Array.from({ length: 4 }, () => createD1DispatchStore(db, { now: clock, env }));
  const coordinators = stores.map((store) => createDispatchCoordinator({
    resolvePrincipal: async () => ({ ...BOB }),
    authority: store,
    transport: {
      capabilities: { protocol: 'aipster-bound-cpu-internal/1', instance_pin: true, deadline: true },
      dispatch: (envelope) => store.enqueueJob(envelope),
      poll: ({ job_id }) => store.readJob({ job_id }),
    },
    now: clock,
  }));

  const admissions = [];
  for (let i = 0; i < 4; i += 1) {
    admissions.push(await stores[0].issueAdmission({
      principal: BOB, resource_id: 'res-1', model_id: 'model-x', max_tokens: 100, grant: 'grant-1',
    }));
  }
  const outs = await Promise.all(admissions.map((a, i) => coordinators[i].submit({}, {
    contract_version: 'v1.0.0', admission_ref: a.admission_ref, idempotency_key: `w3-race-0000000${i}`,
    model_id: 'model-x', prompt: 'hello', max_tokens: 100, deadline_at: T0 + 60000,
  })));
  assert.equal(outs.filter((o) => o.status === 'dispatched').length, 2,
    JSON.stringify(outs.map((o) => o.code || o.status)));
  assert.equal(outs.filter((o) => o.code === 'BUDGET_EXHAUSTED').length, 2);
  assert.deepEqual({ ...(await used('grant-1')) }, { used_jobs: 2, used_tokens: 200 });
  const queued = await db.prepare("SELECT COUNT(*) AS n FROM dispatch_jobs WHERE status = 'queued'").first();
  assert.equal(Number(queued.n), 2);

  // No release after start: the dispatch redeemed its start, so fencing is a
  // tombstone refusal and releaseHolds must not refund the envelope.
  const started = outs.find((o) => o.status === 'dispatched');
  assert.deepEqual(await stores[0].fenceStart({ op_id: started.op_id, generation: 1 }),
    { outcome: 'already_redeemed' });
  assert.deepEqual(await stores[1].releaseHolds({ op_id: started.op_id, generation: 1 }), { released: 0 });
  assert.deepEqual({ ...(await used('grant-1')) }, { used_jobs: 2, used_tokens: 200 });

  // A pre-start release is guarded: the first release refunds its own hold
  // once, the second is a no-op, and the counters never go negative.
  const admission2 = await stores[0].issueAdmission({
    principal: BOB, resource_id: 'res-2', model_id: 'model-x', max_tokens: 100, grant: 'grant-2',
  });
  const resolved = await stores[0].resolveAdmission({ principal: BOB, admission_ref: admission2.admission_ref });
  const binding = bindingFor(resolved);
  const claim = await stores[0].claimOperation({
    op_key: JSON.stringify(['user-bob', 'w3-release-key-0001']), request_digest: 'sha256:' + 'a'.repeat(64),
    principal_id: BOB.principal_id, tenant_id: BOB.tenant_id, binding,
  });
  assert.equal(claim.claimed, true);
  const hold = await stores[0].acquireHold({
    op_id: claim.op.op_id, generation: 1, pool_id: binding.pools[0].pool_id, amount: 100,
  });
  assert.equal(hold.held, true);
  assert.deepEqual({ ...(await used('grant-2')) }, { used_jobs: 1, used_tokens: 100 });
  assert.deepEqual(await stores[0].admit({
    op_id: claim.op.op_id, generation: 1, holds: [hold.hold_id],
    authority: { grant_id: binding.grant_id, grant_revision: binding.grant_revision, incarnation: binding.incarnation },
  }), { outcome: 'admitted' });
  assert.deepEqual(await stores[2].fenceStart({ op_id: claim.op.op_id, generation: 1, reason: 'cancel' }),
    { outcome: 'fenced' });
  assert.deepEqual(await stores[2].releaseHolds({ op_id: claim.op.op_id, generation: 1, reason: 'cancel' }),
    { released: 1 });
  assert.deepEqual({ ...(await used('grant-2')) }, { used_jobs: 0, used_tokens: 0 });
  assert.deepEqual(await stores[3].releaseHolds({ op_id: claim.op.op_id, generation: 1, reason: 'cancel' }),
    { released: 0 }, 'a second release changes nothing');
  const finalRow = await used('grant-2');
  assert.equal(Number(finalRow.used_jobs), 0);
  assert.equal(Number(finalRow.used_tokens), 0);
  assert.ok(Number(finalRow.used_jobs) >= 0 && Number(finalRow.used_tokens) >= 0, 'never negative');
});

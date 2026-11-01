// W3 independent adversarial validation: lifecycle edges, principal isolation,
// concurrency and flag-off, driven through the REAL L2 routes over the REAL L1
// D1 dispatch store (getDispatchStore resolves ./dispatch-store.mjs over the
// migrated D1 shim). No store injection: the only test-side wrapper is a
// pass-through DB that (a) delays one chosen statement to open a deterministic
// race window or (b) refuses any dispatch_* SQL, so a route cannot silently
// consult the store while the flag is off. No network, no inference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';

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

const mintAdmission = async (t, user, r, maxTokens = 100) => readJson(await t.call('/api/inference/admissions', {
  method: 'POST', headers: S(t, user), body: { resource_id: r.resourceId, model_id: MODEL, max_tokens: maxTokens },
}));

// One immutable submit body: a duplicate submit must reuse every field,
// including deadline_at, or the digest legitimately differs.
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
const postResult = (t, r, jobId, body) => t.call(`/api/worker/jobs/${jobId}/result`, {
  method: 'POST', headers: K(r.hb), body,
});

const opRows = async (t) => (await t.DB.prepare(
  'SELECT phase, job_id, uncertain_phase FROM dispatch_operations ORDER BY created_at').all()).results;
const jobCount = async (t) => (await t.DB.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').all()).results[0].n;
const poolUsed = async (t) => (await t.DB.prepare(
  'SELECT used_tokens FROM dispatch_pool_usage').all()).results.map((x) => x.used_tokens);
const maxAdmissionRef = async (t) => (await t.DB.prepare(
  'SELECT COUNT(*) AS n FROM dispatch_admissions').all()).results[0].n;

// A pass-through DB whose batch() waits at one chosen statement until the test
// releases it. The store is still the real one; only the interleaving is fixed.
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

// Fail the test if any dispatch_* statement reaches the database.
function blindDispatchStore(t) {
  const real = t.DB;
  const guard = (sql) => {
    if (/dispatch_/i.test(sql)) throw new Error(`dispatch store touched while the flag is off: ${String(sql).slice(0, 80)}`);
  };
  t.env.DB = {
    prepare: (sql) => { guard(sql); return real.prepare(sql); },
    exec: (sql) => { guard(sql); return real.exec(sql); },
    batch: (stmts) => { stmts.forEach((s) => guard(s.sql)); return real.batch(stmts); },
  };
}

// ---------------------------------------------------------------- flag off

for (const flag of [undefined, '0']) {
  test(`flag ${flag === undefined ? 'unset' : "'0'"}: every new route is 404, /api/jobs is the exact 501, store untouched`, async () => {
    const overrides = { INFERENCE_OWNER_DAILY_TOKENS: '8192' };
    if (flag !== undefined) overrides.INFERENCE_ENABLED = flag;
    const t = await createTestEnv(overrides);
    const r = await ready(t);
    blindDispatchStore(t); // any dispatch_* SQL from here on fails the test

    const admission = await readJson(await t.call('/api/inference/admissions', {
      method: 'POST', headers: S(t, t.alice), body: { resource_id: r.resourceId, model_id: MODEL, max_tokens: 64 },
    }));
    assert.equal(admission.status, 404, admission.text);
    assert.equal(admission.json.code, 'NOT_FOUND');

    const next = await t.call('/api/worker/jobs/next', { headers: K(r.hb) });
    assert.equal(next.status, 404);

    const result = await readJson(await t.call('/api/worker/jobs/job_0001/result', {
      method: 'POST', headers: K(r.hb), body: {},
    }));
    assert.equal(result.status, 404);
    assert.equal(result.json.code, 'NOT_FOUND');

    const rec = await readJson(await t.call('/api/jobs/alice-adv-00000001', { headers: S(t, t.alice) }));
    assert.equal(rec.status, 404);
    assert.equal(rec.json.code, 'NOT_FOUND');

    const cancel = await readJson(await t.call('/api/jobs/alice-adv-00000001/cancel', {
      method: 'POST', headers: S(t, t.alice),
    }));
    assert.equal(cancel.status, 404);
    assert.equal(cancel.json.code, 'NOT_FOUND');

    const disabled = await readJson(await t.call('/api/jobs', {
      method: 'POST', headers: S(t, t.alice), body: { contract_version: 'v1.0.0' },
    }));
    assert.equal(disabled.status, 501);
    assert.deepEqual(disabled.json, {
      error: 'Inference dispatch is disabled. No job was created and no compute ran.',
      code: 'INFERENCE_DISABLED',
    });

    // Nothing was minted and no operation was claimed.
    assert.equal(await maxAdmissionRef(t), 0);
    assert.equal(await jobCount(t), 0);
    assert.equal((await t.DB.prepare('SELECT COUNT(*) AS n FROM dispatch_operations').all()).results[0].n, 0);
  });
}

// --------------------------------------------------------------- isolation

test('isolation: another principal cannot read, cancel or borrow Alice\'s job key', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const admission = await mintAdmission(t, t.alice, r);
  assert.equal(admission.status, 201, admission.text);
  const submitted = await submit(t, t.alice, bodyFor(admission.json.admission_ref, 'alice-adv-00000001'));
  assert.equal(submitted.status, 202, submitted.text);

  // Bob knows the exact key. Reconcile and cancel are principal-scoped.
  const read = await readJson(await t.call('/api/jobs/alice-adv-00000001', { headers: S(t, t.bob) }));
  assert.equal(read.status, 404, read.text);
  assert.equal(read.json.code, 'OPERATION_NOT_FOUND');
  const canc = await readJson(await t.call('/api/jobs/alice-adv-00000001/cancel', {
    method: 'POST', headers: S(t, t.bob),
  }));
  assert.equal(canc.status, 404, canc.text);
  assert.equal(canc.json.code, 'OPERATION_NOT_FOUND');
  assert.equal((await opRows(t)).length, 1, 'Bob neither read nor changed Alice\'s operation');

  // Alice's admission_ref is not a bearer token: Bob's borrow and an unknown
  // reference must be indistinguishable, and neither may claim an operation.
  const opsBefore = (await opRows(t)).length;
  const aliceAdmission = await mintAdmission(t, t.alice, r);
  assert.equal(aliceAdmission.status, 201, aliceAdmission.text);
  const borrow = await submit(t, t.bob, bodyFor(aliceAdmission.json.admission_ref, 'bob-adv-borrow01'));
  const unknown = await submit(t, t.bob, bodyFor('adm_ffffffffffffffffffffffffffffffff', 'bob-adv-unknown1'));
  assert.equal(borrow.status, 403, borrow.text);
  assert.equal(unknown.status, 403, unknown.text);
  assert.deepEqual(borrow.json, unknown.json, 'foreign and unknown references look identical');
  assert.equal(borrow.json.code, 'ADMISSION_NOT_AVAILABLE');
  assert.equal((await opRows(t)).length, opsBefore, 'neither refused submit claimed an operation');

  // The same key string is a different operation per principal: no shadowing.
  // Bob submits on his own resource, under the key Alice also used.
  const bobResource = await ready(t, t.bob);
  const bobAdmission = await mintAdmission(t, t.bob, bobResource);
  assert.equal(bobAdmission.status, 201, bobAdmission.text);
  const bobSubmit = await submit(t, t.bob, bodyFor(bobAdmission.json.admission_ref, 'alice-adv-00000001'));
  assert.equal(bobSubmit.status, 202, bobSubmit.text);
  assert.notEqual(bobSubmit.json.op_id, submitted.json.op_id, 'same key, different principal => different operation');
  const bobRead = await readJson(await t.call('/api/jobs/alice-adv-00000001', { headers: S(t, t.bob) }));
  assert.equal(bobRead.status, 202, bobRead.text);
  assert.equal(bobRead.json.op_id, bobSubmit.json.op_id, 'Bob reads his own operation, never Alice\'s');
});

// ---------------------------------------------------------- deadline edges

test('deadline passes before start: expired_before_start, holds released, nothing queued', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const admission = await mintAdmission(t, t.alice, r);
  assert.equal(admission.status, 201, admission.text);

  // Delay only the server-side admission lookup. t0 (and the deadline check)
  // are already past it, so the submit deterministically outlives its deadline
  // between the admission CAS and start redemption.
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

  const out = await submit(t, t.alice, bodyFor(admission.json.admission_ref, 'alice-adv-expiry01', {
    deadline_at: Date.now() + 300,
  }));
  assert.equal(out.status, 504, out.text);
  assert.equal(out.json.status, 'expired_before_start');
  assert.equal(out.json.code, 'DEADLINE_EXCEEDED');

  const rows = await opRows(t);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phase, 'released', 'the operation is not left admitted or uncertain');
  assert.equal(rows[0].job_id, null);
  assert.equal(await jobCount(t), 0, 'nothing was dispatched');
  assert.deepEqual(await poolUsed(t), [0], 'the pre-start expiry released its hold');
});

test('deadline passes after lease: late result refused, reconcile uncertain, holds retained, no replay', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const admission = await mintAdmission(t, t.alice, r);
  assert.equal(admission.status, 201, admission.text);
  const body = bodyFor(admission.json.admission_ref, 'alice-adv-late001', { deadline_at: Date.now() + 800 });
  const submitted = await submit(t, t.alice, body);
  assert.equal(submitted.status, 202, submitted.text);

  const l = await lease(t, r);
  assert.equal(l.status, 200);
  await sleep(1000);

  // The worker is past the deadline: the result is refused and the lease is
  // not consumed. A late-but-well-formed report can never settle the job.
  const late = await readJson(await postResult(t, r, l.body.job_id, succeeded(l.body)));
  assert.equal(late.status, 409, late.text);
  assert.equal(late.json.code, 'RESULT_REJECTED');
  assert.equal(late.json.reason, 'late');

  const rec = await readJson(await t.call('/api/jobs/alice-adv-late001', { headers: S(t, t.alice) }));
  assert.equal(rec.status, 503, rec.text);
  assert.equal(rec.json.status, 'uncertain');
  assert.equal(rec.json.phase, 'deadline');
  assert.equal(rec.json.automatic_retry, false);
  assert.equal(rec.json.remote_stopped, false);

  const again = await readJson(await t.call('/api/jobs/alice-adv-late001', { headers: S(t, t.alice) }));
  assert.equal(again.status, 503);
  assert.equal(again.json.status, 'uncertain', 'the recorded uncertainty is stable');

  // A retry with the same key never repeats the step. The changed deadline is
  // a changed digest, so the coordinator answers a conflict, not a redispatch.
  const retry = await submit(t, t.alice, { ...body, deadline_at: Date.now() + 60000 });
  assert.equal(retry.status, 409, retry.text);
  assert.equal(retry.json.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(await jobCount(t), 1, 'no second job');
  assert.equal((await opRows(t)).length, 1, 'no second operation');
  assert.deepEqual(await poolUsed(t), [100], 'the uncertain hold is retained, not released');
});

// ---------------------------------------------------------------- cancel

test('cancel before start fences the start and releases the holds', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const admission = await mintAdmission(t, t.alice, r);
  assert.equal(admission.status, 201, admission.text);

  // Hold the submit at start redemption (phase admitted, holds committed), so
  // the cancel deterministically lands in the pre-start window.
  const gate = gateOn(t, /SET\s+phase\s*=\s*'redeemed'/i);
  const pending = submit(t, t.alice, bodyFor(admission.json.admission_ref, 'alice-adv-cancel01'));
  await gate.entered;
  assert.equal((await opRows(t))[0].phase, 'admitted');

  const canc = await readJson(await t.call('/api/jobs/alice-adv-cancel01/cancel', {
    method: 'POST', headers: S(t, t.alice),
  }));
  assert.equal(canc.status, 200, canc.text);
  assert.equal(canc.json.status, 'cancelled_before_start');
  assert.equal(canc.json.code, 'CANCELLED');

  gate.open();
  const out = await pending;
  assert.equal(out.status, 409, out.text);
  assert.equal(out.json.code, 'START_FENCED', 'the racing submit cannot redeem a fenced start');

  assert.equal((await opRows(t))[0].phase, 'released');
  assert.equal(await jobCount(t), 0);
  assert.deepEqual(await poolUsed(t), [0]);
});

test('cancel after start is an unsupported capability: holds retained, job still leasable', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const admission = await mintAdmission(t, t.alice, r);
  const submitted = await submit(t, t.alice, bodyFor(admission.json.admission_ref, 'alice-adv-cancel02'));
  assert.equal(submitted.status, 202, submitted.text);

  const canc = await readJson(await t.call('/api/jobs/alice-adv-cancel02/cancel', {
    method: 'POST', headers: S(t, t.alice),
  }));
  assert.equal(canc.status, 202, canc.text);
  assert.equal(canc.json.cancel, 'UNSUPPORTED_CAPABILITY');
  assert.equal(canc.json.remote_stopped, false);

  const l = await lease(t, r);
  assert.equal(l.status, 200, 'cancel intent does not stop an already-started job');
  assert.deepEqual(await poolUsed(t), [100], 'holds are retained after start');
  assert.equal(await jobCount(t), 1);
});

// ------------------------------------------------------------ idempotency

test('duplicate submit: an identical body replays, a changed body conflicts, one job total', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const admission = await mintAdmission(t, t.alice, r);
  const body = bodyFor(admission.json.admission_ref, 'alice-adv-idem-01');

  const first = await submit(t, t.alice, body);
  assert.equal(first.status, 202, first.text);
  const same = await submit(t, t.alice, body);
  assert.equal(same.status, 202, same.text);
  assert.equal(same.json.op_id, first.json.op_id);
  assert.equal(same.json.job_id, first.json.job_id, 'the replay returns the recorded dispatch');

  const changed = await submit(t, t.alice, { ...body, prompt: 'a different prompt' });
  assert.equal(changed.status, 409, changed.text);
  assert.equal(changed.json.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(changed.json.op_id, first.json.op_id);

  assert.equal(await jobCount(t), 1, 'neither the replay nor the conflict queued a second job');
  assert.equal((await opRows(t)).length, 1);
  assert.deepEqual(await poolUsed(t), [100], 'charged once');
});

// ------------------------------------------------------------ concurrency

test('parallel submits under one budget never over-commit', async () => {
  const t = await createTestEnv({ ...ENABLED, INFERENCE_OWNER_DAILY_TOKENS: '200' });
  const r = await ready(t);
  const admissions = [];
  for (let i = 0; i < 4; i += 1) {
    const a = await mintAdmission(t, t.alice, r, 100);
    assert.equal(a.status, 201, a.text);
    admissions.push(a.json);
  }
  const outs = await Promise.all(admissions.map((a, i) => submit(
    t, t.alice, bodyFor(a.admission_ref, `alice-adv-race-000${i}`))));

  const dispatched = outs.filter((o) => o.status === 202);
  const refused = outs.filter((o) => o.status === 429);
  assert.equal(dispatched.length, 2, outs.map((o) => `${o.status}:${o.json?.code}`).join(','));
  assert.equal(refused.length, 2, 'a 200-token pool admits exactly two 100-token holds');
  for (const o of refused) assert.equal(o.json.code, 'BUDGET_EXHAUSTED');

  assert.deepEqual(await poolUsed(t), [200], 'used tokens equal the ceiling, never more');
  assert.equal(await jobCount(t), 2, 'exactly the admitted operations queued one job');
  const holds = await t.DB.prepare(
    "SELECT SUM(amount) AS total, COUNT(*) AS n FROM dispatch_holds WHERE state IN ('held', 'committed')").first();
  assert.equal(Number(holds.total), 200);
  assert.equal(Number(holds.n), 2);
});

// ------------------------------------------------------- known defect (W3)

// BUG (low severity, error fidelity): a hold refused because the operation was
// fenced by a concurrent pre-start cancel is reported to the client as
// BUDGET_EXHAUSTED (429). acquireHold returns {held:false, reason:'fenced'};
// the coordinator's hold loop discards `reason` and maps every non-permitted
// hold to BUDGET_EXHAUSTED. Capacity is untouched and nothing is dispatched,
// so this is a false cause, not a budget leak. Suggested fix: in
// dispatch-coordinator.mjs submit(), when hold.reason === 'fenced', return the
// recorded cancelled/released state (viewOf) or CANCELLED/START_FENCED instead
// of BUDGET_EXHAUSTED. Repro: the test body below.
test('BUG: a hold fenced by a concurrent cancel is reported as BUDGET_EXHAUSTED', {
  todo: 'BUG: dispatch-coordinator.mjs maps a fenced hold to BUDGET_EXHAUSTED; see RESULT-W3.md',
}, async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const admission = await mintAdmission(t, t.alice, r);

  // Freeze the submit after the claim and before the owner-pool charge.
  const gate = gateOn(t, /UPDATE dispatch_pool_usage SET used_tokens/i);
  const pending = submit(t, t.alice, bodyFor(admission.json.admission_ref, 'alice-adv-fence01'));
  await gate.entered;
  const canc = await readJson(await t.call('/api/jobs/alice-adv-fence01/cancel', {
    method: 'POST', headers: S(t, t.alice),
  }));
  assert.equal(canc.status, 200, canc.text);
  gate.open();
  const out = await pending;

  // Safety invariants hold in every case.
  assert.equal(await jobCount(t), 0);
  assert.deepEqual(await poolUsed(t), [0]);
  assert.equal((await opRows(t))[0].phase, 'released');
  // The reported cause should reflect the cancellation, not spent budget.
  assert.notEqual(out.json.code, 'BUDGET_EXHAUSTED', 'a cancel is not a budget refusal');
});

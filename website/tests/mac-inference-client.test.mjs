/* Mac REQUEST-ORIGIN lane: offline synthetic client harness over current real
 * interfaces (PRD AIPSTER Real Fabric Inference Qualification on JJP v1.0,
 * Gate B only). Real worker.js + real L1 D1 dispatch store behind the real
 * L2 routes (no store injection, cf. inference-e2e-real-store.test.mjs), an
 * in-memory D1 test shim, and a test-played synthetic worker using the
 * worker's wire shapes. No network beyond the in-process Request/Response
 * path, no model, no GPU, no JJP/GMH contact. Fixture success here is NOT
 * live qualification: the lease envelope is CPU-bound by contract and the
 * provenance.simulated=false stamp below is a contract field, never
 * hardware proof. Live inference is HOLD (see docs/mac-real-inference-client.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';

const ENABLED = { INFERENCE_ENABLED: '1', INFERENCE_OWNER_DAILY_TOKENS: '8192' };
const MODEL = 'qwen3.8-27b-atx-iq4_xs'; // repo fixture model id, not a live weight claim
const PROMPT = 'Reply with exactly: hello'; // non-sensitive synthetic prompt

const S = (t, user) => ({ ...t.as(user), ...t.csrf });
const K = (secret) => ({ Authorization: `Bearer ${secret}` });

async function ready(t, user = t.alice) {
  const res = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: S(t, user), body: { name: 'mac-harness-box', kind: 'local', origin: 'lab', cpu: 'x', gpu: 'y' },
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
  const inference = await readJson(await t.call('/api/keys', {
    method: 'POST', headers: S(t, user), body: { name: 'inference', scope: 'inference' },
  }));
  assert.equal(inference.status, 201, inference.text);
  return { resourceId: res.json.id, hb: hb.json.secret, inference: inference.json.secret };
}

async function admit(t, user, { resourceId, model_id = MODEL, max_tokens = 128, extra = {} } = {}) {
  return readJson(await t.call('/api/inference/admissions', {
    method: 'POST', headers: S(t, user), body: { resource_id: resourceId, model_id, max_tokens, ...extra },
  }));
}

const submitBody = (admission_ref, key, over = {}) => ({
  contract_version: 'v1.0.0', admission_ref, idempotency_key: key,
  model_id: MODEL, prompt: PROMPT, max_tokens: 128, deadline_at: Date.now() + 60000, ...over,
});
const submitJob = async (t, headers, body) => readJson(await t.call('/api/jobs', { method: 'POST', headers, body }));
const poll = async (t, headers, key) => readJson(await t.call(`/api/jobs/${key}`, { headers }));
const cancel = async (t, headers, key) => readJson(await t.call(`/api/jobs/${key}/cancel`, { method: 'POST', headers }));
const nextJob = (t, secret) => t.call('/api/worker/jobs/next', { headers: K(secret) });
const postResult = async (t, secret, jobId, body) => readJson(await t.call(`/api/worker/jobs/${jobId}/result`, {
  method: 'POST', headers: K(secret), body,
}));

// Synthetic worker report: test-played content shaped exactly like the
// worker wire format. simulated:false here is a required contract field,
// not evidence of hardware execution.
const succeeded = (l, content = 'hello') => {
  const p = l.envelope.task.placement, b = l.envelope.binding;
  return {
    lease_id: l.lease_id, status: 'succeeded',
    result: {
      request_id: l.job_id, node_id: p.node_id, runtime_id: p.runtime_id, model_id: l.envelope.task.model_id,
      runtime_instance: b.runtime_instance, model_fingerprint: b.model_fingerprint,
      simulated: false, content, elapsed_ms: 9, usage: { completion_tokens: 1 }, cache: {},
    },
  };
};

async function lease(t, r) {
  const res = await nextJob(t, r.hb);
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}

const usedTokens = async (t, poolLike) => (await t.DB.prepare(
  'SELECT COALESCE(SUM(used_tokens), 0) AS n FROM dispatch_pool_usage WHERE pool_id LIKE ?').bind(poolLike).first()).n;
const holdStates = async (t, opId) => (await t.DB.prepare(
  'SELECT state, COUNT(*) AS n FROM dispatch_holds WHERE op_id = ? GROUP BY state').bind(opId).all()).results;

// ------------------------------------------------------- one stable chain
test('mac client: admit -> submit -> lease -> result -> settle joins one chain and charges once', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const key = 'mac-client-00000001';

  const admission = await admit(t, t.alice, { resourceId: r.resourceId });
  assert.equal(admission.status, 201, admission.text);
  assert.deepEqual(Object.keys(admission.json).sort(), ['admission_ref', 'expires_at', 'max_tokens', 'model_id']);

  const sub = await submitJob(t, S(t, t.alice), submitBody(admission.json.admission_ref, key));
  assert.equal(sub.status, 202, sub.text);
  assert.equal(sub.json.status, 'dispatched');
  assert.ok(sub.json.op_id && sub.json.job_id, 'stable op/job binding returned');

  const l = await lease(t, r);
  assert.equal(l.job_id, sub.json.job_id, 'lease binds the submitted job');
  assert.equal(l.envelope.protocol, 'aipster-bound-cpu-internal/1');
  assert.deepEqual(l.envelope.task.placement, { device: 'cpu', node_id: r.resourceId, runtime_id: 'ganglion' });
  assert.deepEqual(Object.keys(l.envelope.binding).sort(),
    ['deadline_at', 'generation', 'model_fingerprint', 'op_id', 'runtime_instance']);
  assert.equal(l.envelope.binding.op_id, sub.json.op_id, 'binding carries the op');
  assert.equal((await nextJob(t, r.hb)).status, 204, 'one lease at a time');

  const ok = await postResult(t, r.hb, l.job_id, succeeded(l));
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.job_id, l.job_id);

  const done = await poll(t, S(t, t.alice), key);
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.status, 'settled');
  assert.equal(done.json.outcome.content, 'hello', 'synthetic content released once');
  assert.equal(done.json.outcome.provenance.simulated, false, 'contract stamp, not hardware proof');
  const again = await poll(t, S(t, t.alice), key);
  assert.equal(again.json.outcome?.content, undefined, 'no second copy on re-poll');

  assert.equal(await usedTokens(t, 'owner:%'), 128, 'exactly one 128-token charge');
  const holds = await holdStates(t, sub.json.op_id);
  assert.ok(holds.length > 0, 'holds exist for the op');
  assert.ok(holds.every((h) => h.state === 'charged'), `no outstanding hold: ${JSON.stringify(holds)}`);
});

// ------------------------------------------------------------- replay/no-op
test('mac client: stable idempotency key replays without redispatch; changed body conflicts', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const key = 'mac-client-00000002';
  const admission = await admit(t, t.alice, { resourceId: r.resourceId });
  assert.equal(admission.status, 201, admission.text);

  // A true replay re-sends the identical body: the digest covers deadline_at,
  // so rebuilding the body would be a different operation, not a replay.
  const body = submitBody(admission.json.admission_ref, key);
  const first = await submitJob(t, S(t, t.alice), body);
  assert.equal(first.status, 202, first.text);
  const replay = await submitJob(t, S(t, t.alice), body);
  assert.equal(replay.status, 202, replay.text);
  assert.equal(replay.json.op_id, first.json.op_id, 'same op, never redispatch');
  assert.equal(replay.json.job_id, first.json.job_id);
  assert.equal((await t.DB.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').first()).n, 1, 'single job row');

  const conflict = await submitJob(t, S(t, t.alice), { ...body, prompt: 'different prompt' });
  assert.equal(conflict.status, 409, conflict.text);
  assert.equal(conflict.json.code, 'IDEMPOTENCY_CONFLICT');

  const l = await lease(t, r);
  const dup = await postResult(t, r.hb, l.job_id, succeeded(l, 'second'));
  assert.equal(dup.status, 200, dup.text);
  const late = await postResult(t, r.hb, l.job_id, succeeded(l, 'third'));
  assert.equal(late.status, 409, late.text);
  assert.equal(late.json.code, 'RESULT_REJECTED', 'duplicate result changes nothing');
  const settled = await poll(t, S(t, t.alice), key);
  assert.equal(settled.json.outcome.content, 'second', 'first completion wins');
});

// ------------------------------------------------------------------ auth
test('mac client: anonymous and wrong-scope callers are refused on every inference route', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  for (const [path, method] of [
    ['/api/inference/admissions', 'POST'],
    ['/api/jobs', 'POST'],
    ['/api/jobs/mac-client-00000003', 'GET'],
    ['/api/jobs/mac-client-00000003/cancel', 'POST'],
  ]) {
    const out = await readJson(await t.call(path, { method, body: method === 'POST' ? {} : undefined }));
    assert.equal(out.status, 401, `${method} ${path}`);
    assert.equal(out.json.code, 'AUTH_REQUIRED', `${method} ${path}`);
  }
  const next = await t.call('/api/worker/jobs/next', {});
  assert.equal(next.status, 403);
  assert.equal((await readJson(next)).json.code, 'KEY_REQUIRED');

  const read = await readJson(await t.call('/api/keys', {
    method: 'POST', headers: S(t, t.alice), body: { name: 'read', scope: 'read' },
  }));
  assert.equal(read.status, 201, read.text);
  const denied = await readJson(await t.call('/api/inference/admissions', {
    method: 'POST', headers: K(read.json.secret),
    body: { resource_id: r.resourceId, model_id: MODEL, max_tokens: 64 },
  }));
  assert.equal(denied.status, 403, denied.text);
  assert.equal(denied.json.code, 'KEY_SCOPE');
  const deniedSubmit = await submitJob(t, K(r.hb), submitBody('adm-does-not-matter', 'mac-client-00000004'));
  assert.equal(deniedSubmit.status, 403, deniedSubmit.text);
  assert.equal(deniedSubmit.json.code, 'KEY_SCOPE', 'heartbeat key cannot submit');
});

// -------------------------------------------------------------- isolation
test('mac client: cross-owner reads, leases, and results are denied', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t, t.alice);
  const other = await ready(t, t.bob);
  const key = 'mac-client-00000005';
  const admission = await admit(t, t.alice, { resourceId: r.resourceId });
  assert.equal(admission.status, 201, admission.text);
  const sub = await submitJob(t, S(t, t.alice), submitBody(admission.json.admission_ref, key));
  assert.equal(sub.status, 202, sub.text);

  const foreign = await poll(t, S(t, t.bob), key);
  assert.equal(foreign.status, 404, foreign.text);
  assert.equal(foreign.json.code, 'OPERATION_NOT_FOUND', 'op keys are principal-scoped');

  assert.equal((await nextJob(t, other.hb)).status, 204, "bob's key leases no alice job");

  const l = await lease(t, r);
  const stolen = await postResult(t, other.hb, l.job_id, succeeded(l));
  assert.equal(stolen.status, 409, stolen.text);
  assert.equal(stolen.json.code, 'RESULT_REJECTED');
  assert.equal(stolen.json.reason, 'wrong_resource');
});

// ------------------------------------------------------- gpu-path refusal
test('mac client: device/gpu selection is refused and the lease stays cpu', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const admission = await admit(t, t.alice, { resourceId: r.resourceId });
  assert.equal(admission.status, 201, admission.text);

  for (const [extra, code] of [
    [{ placement: { device: 'gpu', node_id: r.resourceId } }, 'FORGED_CLIENT_AUTHORITY'],
    [{ device: 'gpu' }, 'UNSUPPORTED_FIELD'],
    [{ runtime_id: 'ganglion' }, 'FORGED_CLIENT_AUTHORITY'],
  ]) {
    const out = await submitJob(t, S(t, t.alice),
      submitBody(admission.json.admission_ref, 'mac-client-00000006', extra));
    assert.equal(out.status, 400, JSON.stringify(extra));
    assert.equal(out.json.code, code, JSON.stringify(extra));
  }
  const admDevice = await admit(t, t.alice, { resourceId: r.resourceId, extra: { device: 'gpu' } });
  assert.equal(admDevice.status, 400, admDevice.text);
  assert.equal(admDevice.json.code, 'UNSUPPORTED_FIELD');

  const ok = await submitJob(t, S(t, t.alice), submitBody(admission.json.admission_ref, 'mac-client-00000007'));
  assert.equal(ok.status, 202, ok.text);
  const l = await lease(t, r);
  assert.equal(l.envelope.task.placement.device, 'cpu', 'no contract path selects a GPU: live HOLD');
});

// ----------------------------------------------- deadlines/cancel/unknown
test('mac client: deadlines bound submit; post-start cancel is unsupported and remote not stopped', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const admission = await admit(t, t.alice, { resourceId: r.resourceId });
  assert.equal(admission.status, 201, admission.text);

  const past = await submitJob(t, S(t, t.alice),
    submitBody(admission.json.admission_ref, 'mac-client-00000008', { deadline_at: Date.now() - 1000 }));
  assert.equal(past.status, 400, past.text);
  assert.equal(past.json.code, 'INVALID_DEADLINE');
  const far = await submitJob(t, S(t, t.alice),
    submitBody(admission.json.admission_ref, 'mac-client-00000009', { deadline_at: Date.now() + 181000 }));
  assert.equal(far.status, 400, far.text);
  assert.equal(far.json.code, 'INVALID_DEADLINE', 'deadline beyond 180s refused');

  const sub = await submitJob(t, S(t, t.alice), submitBody(admission.json.admission_ref, 'mac-client-00000010'));
  assert.equal(sub.status, 202, sub.text);
  const noCsrf = await readJson(await t.call('/api/jobs/mac-client-00000010/cancel', {
    method: 'POST', headers: t.as(t.alice),
  }));
  assert.equal(noCsrf.status, 403, noCsrf.text);
  assert.equal(noCsrf.json.code, 'CSRF_REQUIRED');

  const out = await cancel(t, S(t, t.alice), 'mac-client-00000010');
  assert.equal(out.status, 202, out.text);
  assert.equal(out.json.cancel, 'UNSUPPORTED_CAPABILITY', 'no execution-cancel frame exists');
  assert.equal(out.json.remote_stopped, false, 'timeout/cancel never claims remote execution stopped');
  assert.equal(await usedTokens(t, 'owner:%'), 128, 'holds retained after unsupported cancel');

  const unknown = await cancel(t, S(t, t.alice), 'mac-client-never-submitted');
  assert.equal(unknown.status, 404, unknown.text);
  assert.equal(unknown.json.code, 'OPERATION_NOT_FOUND');
});

test('mac client: unknown-lease result is rejected without settlement; no replay follows', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const key = 'mac-client-00000011';
  const admission = await admit(t, t.alice, { resourceId: r.resourceId });
  assert.equal(admission.status, 201, admission.text);
  const sub = await submitJob(t, S(t, t.alice), submitBody(admission.json.admission_ref, key));
  assert.equal(sub.status, 202, sub.text);
  const l = await lease(t, r);

  const forged = succeeded(l);
  forged.lease_id = 'lease_forged00000000000000000000001';
  const out = await postResult(t, r.hb, l.job_id, forged);
  assert.equal(out.status, 409, out.text);
  assert.equal(out.json.code, 'RESULT_REJECTED');
  assert.equal(out.json.reason, 'wrong_lease');

  const still = await poll(t, S(t, t.alice), key);
  assert.notEqual(still.json.status, 'settled', 'rejected result settles nothing');
  assert.equal((await t.DB.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').first()).n, 1, 'no new job opened');
  assert.equal(await usedTokens(t, 'owner:%'), 128, 'single hold retained, no second charge');

  // The genuine lease still completes the same key: reconcile, never resubmit.
  const genuine = await postResult(t, r.hb, l.job_id, succeeded(l));
  assert.equal(genuine.status, 200, genuine.text);
  const done = await poll(t, S(t, t.alice), key);
  assert.equal(done.json.status, 'settled');
});

// --------------------------------------------------------------- accounting
test('mac client: exhausted budget rejects submit with no charge and no job', async () => {
  const t = await createTestEnv({ INFERENCE_ENABLED: '1', INFERENCE_OWNER_DAILY_TOKENS: '64' });
  const r = await ready(t);
  const admission = await admit(t, t.alice, { resourceId: r.resourceId, max_tokens: 128 });
  assert.equal(admission.status, 201, admission.text, 'admission ceiling is advisory; hold enforces');
  const sub = await submitJob(t, S(t, t.alice), submitBody(admission.json.admission_ref, 'mac-client-00000012'));
  assert.equal(sub.status, 429, sub.text);
  assert.equal(sub.json.code, 'BUDGET_EXHAUSTED');
  assert.equal(await usedTokens(t, 'owner:%'), 0, 'rejected submit charges nothing');
  assert.equal((await t.DB.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').first()).n, 0, 'no job opened');
});

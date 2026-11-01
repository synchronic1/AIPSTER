// L2: HTTP routes + worker-pull transport for admitted dispatch.
// Everything here runs against the in-memory L1 fake (tests/fixtures/
// dispatch-store-fake.mjs) and the real worker.js + D1 test shim. No live
// inference, no network beyond the in-process Request/Response path.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { createFakeDispatchStore } from './fixtures/dispatch-store-fake.mjs';
import { __setDispatchStoreFactoryForTest } from '../src/inference/dispatch-wiring.mjs';

const ENABLED = { INFERENCE_ENABLED: '1', INFERENCE_OWNER_DAILY_TOKENS: '8192' };
const MODEL = 'deepseek-v4.1-flash:1017-cloud';
const PROMPT = 'Reply with exactly: hello';

const S = (t, user, extra = {}) => ({ ...t.as(user), ...t.csrf, ...extra });
const K = (t, secret, extra = {}) => ({ Authorization: `Bearer ${secret}`, ...extra });

afterEach(() => __setDispatchStoreFactoryForTest(null));

async function register(t, user, name = 'box') {
  const out = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: S(t, user), body: { name, kind: 'local', origin: 'lab', cpu: 'x', gpu: 'y' },
  }));
  assert.equal(out.status, 201, out.text);
  return out.json;
}

async function mintKey(t, user, scope, resourceId) {
  const body = { name: `${scope} key`, scope };
  if (resourceId) body.resourceId = resourceId;
  const out = await readJson(await t.call('/api/keys', { method: 'POST', headers: S(t, user), body }));
  assert.equal(out.status, 201, out.text);
  return out.json;
}

const beat = (t, secret, id) => t.call(`/api/resources/${id}/heartbeat`, {
  method: 'POST', headers: K(t, secret), body: JSON.stringify({ usable: true }),
});

// Owner-scoped worker fixture: resource + fresh heartbeat + bound key, and an
// inference-scoped key for the submitter.
async function ready(t, user = t.alice) {
  const resource = await register(t, user);
  const hb = await mintKey(t, user, 'heartbeat', resource.id);
  const hbRes = await beat(t, hb.secret, resource.id);
  assert.equal(hbRes.status, 200, await hbRes.text());
  const inference = await mintKey(t, user, 'inference');
  return { resource, hb, inference: inference.secret };
}

function useStore(t) {
  const store = createFakeDispatchStore(t.DB, { env: t.env });
  __setDispatchStoreFactoryForTest(() => store);
  return store;
}

async function admit(t, user, { resource_id, model_id = MODEL, max_tokens = 128, runtime_id, headers } = {}) {
  const body = { resource_id, model_id, max_tokens };
  if (runtime_id !== undefined) body.runtime_id = runtime_id;
  return readJson(await t.call('/api/inference/admissions', {
    method: 'POST', headers: headers || S(t, user), body,
  }));
}

const submitBody = (admission_ref, over = {}) => ({
  contract_version: 'v1.0.0', admission_ref, idempotency_key: 'alice-op-00000001',
  model_id: MODEL, prompt: PROMPT, max_tokens: 128, deadline_at: Date.now() + 60000, ...over,
});

async function submitJob(t, headers, body) {
  return readJson(await t.call('/api/jobs', { method: 'POST', headers, body }));
}

function resultFor(lease, over = {}) {
  const env = lease.envelope;
  const p = env.task.placement;
  const b = env.binding;
  return {
    lease_id: lease.lease_id,
    status: 'succeeded',
    result: {
      request_id: lease.job_id, node_id: p.node_id, runtime_id: p.runtime_id, model_id: env.task.model_id,
      runtime_instance: b.runtime_instance, model_fingerprint: b.model_fingerprint,
      simulated: false, content: 'hello', elapsed_ms: 12, usage: { output_tokens: 1 }, cache: {},
      ...over,
    },
  };
}

const postResult = (t, secret, jobId, body) => t.call(`/api/worker/jobs/${jobId}/result`, {
  method: 'POST', headers: K(t, secret), body,
});
const nextJob = (t, headers) => t.call('/api/worker/jobs/next', { headers });

// --------------------------------------------------------------- flag off

test('flag off: new routes are absent and POST /api/jobs keeps its exact 501', async () => {
  const t = await createTestEnv();
  const store = useStore(t); // proves the routes never consult a store while disabled
  const r = await ready(t);
  const admission = await readJson(await t.call('/api/inference/admissions', {
    method: 'POST', headers: S(t, t.alice), body: { resource_id: r.resource.id, model_id: MODEL, max_tokens: 64 },
  }));
  assert.equal(admission.status, 404);
  assert.equal(admission.json.code, 'NOT_FOUND');

  const next = await nextJob(t, K(t, r.hb.secret));
  assert.equal(next.status, 404);
  const result = await postResult(t, r.hb.secret, 'job-0001', {});
  assert.equal(result.status, 404);
  const cancel = await t.call('/api/jobs/alice-op-00000001/cancel', { method: 'POST', headers: S(t, t.alice) });
  assert.equal(cancel.status, 404);

  const disabled = await submitJob(t, K(t, r.inference), { model: 'demo', prompt: 'hi' });
  assert.equal(disabled.status, 501);
  assert.equal(disabled.json.code, 'INFERENCE_DISABLED');
  assert.equal(disabled.json.error, 'Inference dispatch is disabled. No job was created and no compute ran.');

  // The legacy GET /api/jobs/:id read still answers (no operation exists).
  const legacy = await readJson(await t.call('/api/jobs/legacyjob1', { headers: K(t, r.inference) }));
  assert.equal(legacy.status, 404);
  assert.equal(legacy.json.code, 'NOT_FOUND');
  assert.deepEqual(store.state.operations, {});
  assert.deepEqual(store.state.jobs, {});
});

// ------------------------------------------------------------------ auth

test('anonymous callers are refused (401) on every inference route', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t);
  for (const [path, method] of [
    ['/api/inference/admissions', 'POST'],
    ['/api/jobs', 'POST'],
    ['/api/jobs/alice-op-00000001', 'GET'],
    ['/api/jobs/alice-op-00000001/cancel', 'POST'],
  ]) {
    const out = await readJson(await t.call(path, { method, body: method === 'POST' ? {} : undefined }));
    assert.equal(out.status, 401, `${method} ${path}`);
    assert.equal(out.json.code, 'AUTH_REQUIRED', `${method} ${path}`);
  }
  // Worker endpoints exist but demand a heartbeat-scoped key.
  const next = await nextJob(t, {});
  assert.equal(next.status, 403);
  assert.equal((await readJson(next)).json.code, 'KEY_REQUIRED');
  assert.equal(r.resource.id.length > 0, true);
});

test('read- and heartbeat-scoped keys cannot submit or mint admissions', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t);
  const read = await mintKey(t, t.alice, 'read');
  const admission = await admit(t, t.alice, { resource_id: r.resource.id, headers: K(t, read.secret) });
  assert.equal(admission.status, 403);
  assert.equal(admission.json.code, 'KEY_SCOPE');

  const body = submitBody('adm-does-not-matter');
  const byRead = await submitJob(t, K(t, read.secret), body);
  assert.equal(byRead.status, 403);
  assert.equal(byRead.json.code, 'KEY_SCOPE');
  const byHeartbeat = await submitJob(t, K(t, r.hb.secret), body);
  assert.equal(byHeartbeat.status, 403);
  assert.equal(byHeartbeat.json.code, 'KEY_SCOPE');
});

test('inference key and session+CSRF are both accepted for admissions and submit', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t);

  // inference key, no CSRF needed
  const a1 = await admit(t, t.alice, { resource_id: r.resource.id, headers: K(t, r.inference) });
  assert.equal(a1.status, 201, a1.text);
  const s1 = await submitJob(t, K(t, r.inference), submitBody(a1.json.admission_ref));
  assert.equal(s1.status, 202, s1.text);
  assert.equal(s1.json.status, 'dispatched');

  // session + CSRF
  const a2 = await admit(t, t.alice, { resource_id: r.resource.id });
  assert.equal(a2.status, 201, a2.text);
  const s2 = await submitJob(t, S(t, t.alice), submitBody(a2.json.admission_ref, { idempotency_key: 'alice-op-00000002' }));
  assert.equal(s2.status, 202, s2.text);

  // session without CSRF is refused after authentication
  const noCsrf = await submitJob(t, t.as(t.alice), submitBody(a2.json.admission_ref, { idempotency_key: 'alice-op-00000003' }));
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.code, 'CSRF_REQUIRED');
});

// ------------------------------------------------------------- admissions

test('admissions: only {admission_ref, expires_at, model_id, max_tokens} is returned', async () => {
  const t = await createTestEnv(ENABLED);
  const store = useStore(t);
  const r = await ready(t);
  const out = await admit(t, t.alice, { resource_id: r.resource.id, max_tokens: 128 });
  assert.equal(out.status, 201, out.text);
  assert.deepEqual(Object.keys(out.json).sort(), ['admission_ref', 'expires_at', 'max_tokens', 'model_id']);
  assert.match(out.json.admission_ref, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  assert.equal(out.json.model_id, MODEL);
  assert.equal(out.json.max_tokens, 128);
  assert.ok(out.json.expires_at > Date.now());
  assert.equal(Object.keys(store.state.admissions).length, 1);
});

test('admissions: a foreign resource without a grant is refused', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t);
  const out = await admit(t, t.bob, { resource_id: r.resource.id });
  assert.equal(out.status, 404);
  assert.equal(out.json.code, 'NOT_FOUND');

  const missing = await admit(t, t.alice, { resource_id: 'r_does_not_exist' });
  assert.equal(missing.status, 404);
});

test('admissions: a stale heartbeat is refused', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t);
  const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  await t.DB.prepare('UPDATE resources SET heartbeat_at = ? WHERE id = ?').bind(stale, r.resource.id).run();
  const out = await admit(t, t.alice, { resource_id: r.resource.id });
  assert.equal(out.status, 409);
  assert.equal(out.json.code, 'RESOURCE_STALE');
});

test('admissions: max_tokens must be an integer in 1..4096', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t);
  for (const max_tokens of [0, 4097, -1, 1.5, '128', null]) {
    const out = await admit(t, t.alice, { resource_id: r.resource.id, max_tokens });
    assert.equal(out.status, 400, `max_tokens=${String(max_tokens)}`);
    assert.equal(out.json.code, 'BAD_MAX_TOKENS', `max_tokens=${String(max_tokens)}`);
  }
  const ok = await admit(t, t.alice, { resource_id: r.resource.id, max_tokens: 4096 });
  assert.equal(ok.status, 201, ok.text);
});

test('admissions: unknown fields are rejected', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t);
  const out = await readJson(await t.call('/api/inference/admissions', {
    method: 'POST', headers: S(t, t.alice),
    body: { resource_id: r.resource.id, model_id: MODEL, max_tokens: 64, principal_id: 'u_bob' },
  }));
  assert.equal(out.status, 400);
  assert.equal(out.json.code, 'UNSUPPORTED_FIELD');
});

// ------------------------------------------------------- runtime identity

test('admissions: runtime_id defaults to ganglion and a llama-server admission runs end to end', async () => {
  const t = await createTestEnv(ENABLED);
  const store = useStore(t);
  const r = await ready(t);

  // Default: ganglion, unchanged from before the runtime field existed.
  const def = await admit(t, t.alice, { resource_id: r.resource.id });
  assert.equal(def.status, 201, def.text);
  assert.equal(store.state.admissions[def.json.admission_ref].runtime_id, 'ganglion');
  assert.equal(store.state.admissions[def.json.admission_ref].runtime_instance, `${r.resource.id}#ganglion`);
  const defSubmit = await submitJob(t, S(t, t.alice), submitBody(def.json.admission_ref));
  assert.equal(defSubmit.status, 202, defSubmit.text);
  const defLease = await (await nextJob(t, K(t, r.hb.secret))).json();
  assert.equal(defLease.envelope.task.placement.runtime_id, 'ganglion');
  assert.equal(defLease.envelope.binding.runtime_instance, `${r.resource.id}#ganglion`);
  assert.equal((await readJson(await postResult(t, r.hb.secret, defLease.job_id, resultFor(defLease)))).status, 200);

  // Explicit llama-server: the identity is stored, placed and pinned.
  const mac = await admit(t, t.alice, { resource_id: r.resource.id, runtime_id: 'llama-server' });
  assert.equal(mac.status, 201, mac.text);
  assert.equal(store.state.admissions[mac.json.admission_ref].runtime_id, 'llama-server');
  assert.equal(store.state.admissions[mac.json.admission_ref].runtime_instance, `${r.resource.id}#llama-server`);
  const submitted = await submitJob(t, S(t, t.alice), submitBody(mac.json.admission_ref, { idempotency_key: 'alice-op-00000002' }));
  assert.equal(submitted.status, 202, submitted.text);
  const lease = await (await nextJob(t, K(t, r.hb.secret))).json();
  assert.equal(lease.job_id, submitted.json.job_id);
  assert.deepEqual(lease.envelope.task.placement,
    { device: 'cpu', node_id: r.resource.id, runtime_id: 'llama-server' });
  assert.equal(lease.envelope.binding.runtime_instance, `${r.resource.id}#llama-server`);

  const accepted = await readJson(await postResult(t, r.hb.secret, lease.job_id, resultFor(lease)));
  assert.equal(accepted.status, 200, accepted.text);
  const done = await readJson(await t.call('/api/jobs/alice-op-00000002', { headers: S(t, t.alice) }));
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.status, 'settled');
  assert.equal(done.json.outcome.released, true);
  assert.equal(done.json.outcome.content, 'hello');
  assert.equal(done.json.outcome.provenance.runtime_instance, `${r.resource.id}#llama-server`);
});

test('admissions: a runtime_id outside the allowlist is refused with BAD_RUNTIME', async () => {
  const t = await createTestEnv(ENABLED);
  const store = useStore(t);
  const r = await ready(t);
  for (const runtime_id of ['llama-cpp', 'GANGLION', 'ganglion ', '', null, 42, ['ganglion'], { id: 'ganglion' }]) {
    const out = await admit(t, t.alice, { resource_id: r.resource.id, runtime_id });
    assert.equal(out.status, 400, JSON.stringify(runtime_id));
    assert.equal(out.json.code, 'BAD_RUNTIME', JSON.stringify(runtime_id));
  }
  // Refused before the store is consulted, so no admission was minted.
  assert.deepEqual(store.state.admissions, {});
});

// ---------------------------------------------------------- worker endpoints

test('worker endpoints refuse sessions and inference keys', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t);

  const bySession = await readJson(await nextJob(t, S(t, t.alice)));
  assert.equal(bySession.status, 403);
  assert.equal(bySession.json.code, 'KEY_REQUIRED');
  const byInference = await readJson(await nextJob(t, K(t, r.inference)));
  assert.equal(byInference.status, 403);
  assert.equal(byInference.json.code, 'KEY_SCOPE');
});

// ------------------------------------------------------------ happy path

test('happy path: admit -> submit -> lease -> result -> reconcile returns content once', async () => {
  const t = await createTestEnv(ENABLED);
  const store = useStore(t);
  const r = await ready(t);

  const admission = await admit(t, t.alice, { resource_id: r.resource.id, max_tokens: 128 });
  assert.equal(admission.status, 201, admission.text);
  const submitted = await submitJob(t, S(t, t.alice), submitBody(admission.json.admission_ref));
  assert.equal(submitted.status, 202, submitted.text);
  assert.equal(submitted.json.status, 'dispatched');
  const jobId = submitted.json.job_id;
  assert.match(jobId, /^job-/);

  // Reconcile before any result: still dispatched, no content.
  const early = await readJson(await t.call('/api/jobs/alice-op-00000001', { headers: S(t, t.alice) }));
  assert.equal(early.status, 202, early.text);
  assert.equal(early.json.status, 'dispatched');
  assert.equal(early.json.outcome, undefined);

  const leaseRes = await nextJob(t, K(t, r.hb.secret));
  assert.equal(leaseRes.status, 200);
  const lease = await leaseRes.json();
  assert.equal(lease.job_id, jobId);
  assert.match(lease.lease_id, /^lease-/);
  assert.ok(lease.deadline_at > Date.now());
  assert.equal(lease.envelope.protocol, 'aipster-bound-cpu-internal/1');
  assert.deepEqual(lease.envelope.task.placement, { device: 'cpu', node_id: r.resource.id, runtime_id: 'ganglion' });
  assert.equal(lease.envelope.task.model_id, MODEL);
  assert.equal(lease.envelope.task.allow_simulated, false);

  // No second job for the same resource.
  const empty = await nextJob(t, K(t, r.hb.secret));
  assert.equal(empty.status, 204);

  // Result before reconcile settles it.
  const accepted = await postResult(t, r.hb.secret, jobId, resultFor(lease));
  const acceptedJson = await readJson(accepted);
  assert.equal(acceptedJson.status, 200, acceptedJson.text);
  assert.equal(acceptedJson.json.ok, true);

  const done = await readJson(await t.call('/api/jobs/alice-op-00000001', { headers: S(t, t.alice) }));
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.status, 'settled');
  assert.equal(done.json.outcome.finish, 'succeeded');
  assert.equal(done.json.outcome.released, true);
  assert.equal(done.json.outcome.content, 'hello');
  assert.equal(done.json.outcome.provenance.simulated, false);

  // Content is released exactly once: the replayed settled view is read-only
  // and carries no second copy of the content.
  const again = await readJson(await t.call('/api/jobs/alice-op-00000001', { headers: S(t, t.alice) }));
  assert.equal(again.status, 200);
  assert.equal(again.json.status, 'settled');
  assert.equal(again.json.outcome.finish, 'succeeded');
  assert.equal(again.json.outcome.content, undefined);
  assert.equal(store.state.pools[`owner:${t.alice.id}:${new Date().toISOString().slice(0, 10)}`].used, 128);
});

test('a failed result settles without content release', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t);
  const admission = await admit(t, t.alice, { resource_id: r.resource.id });
  const submitted = await submitJob(t, S(t, t.alice), submitBody(admission.json.admission_ref));
  assert.equal(submitted.status, 202, submitted.text);
  const lease = await (await nextJob(t, K(t, r.hb.secret))).json();

  const out = await readJson(await postResult(t, r.hb.secret, lease.job_id, {
    lease_id: lease.lease_id, status: 'failed', result: { reason: 'MODEL_UNAVAILABLE' },
  }));
  assert.equal(out.status, 200, out.text);
  const done = await readJson(await t.call('/api/jobs/alice-op-00000001', { headers: S(t, t.alice) }));
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.status, 'settled');
  assert.equal(done.json.outcome.finish, 'failed');
  assert.equal(done.json.outcome.released, false);
});

test('duplicate worker result is refused with 409', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t);
  const admission = await admit(t, t.alice, { resource_id: r.resource.id });
  const submitted = await submitJob(t, S(t, t.alice), submitBody(admission.json.admission_ref));
  assert.equal(submitted.status, 202, submitted.text);
  const lease = await (await nextJob(t, K(t, r.hb.secret))).json();

  const first = await readJson(await postResult(t, r.hb.secret, lease.job_id, resultFor(lease)));
  assert.equal(first.status, 200, first.text);
  const second = await readJson(await postResult(t, r.hb.secret, lease.job_id, resultFor(lease)));
  assert.equal(second.status, 409);
  assert.equal(second.json.code, 'RESULT_REJECTED');
  assert.equal(second.json.reason, 'already_completed');
});

test('a worker key bound to another resource cannot result another resource job', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t);
  const other = await ready(t);

  const admission = await admit(t, t.alice, { resource_id: r.resource.id });
  const submitted = await submitJob(t, S(t, t.alice), submitBody(admission.json.admission_ref));
  assert.equal(submitted.status, 202, submitted.text);
  const lease = await (await nextJob(t, K(t, r.hb.secret))).json();

  const empty = await nextJob(t, K(t, other.hb.secret));
  assert.equal(empty.status, 204);

  const out = await readJson(await postResult(t, other.hb.secret, lease.job_id, resultFor(lease)));
  assert.equal(out.status, 409);
  assert.equal(out.json.reason, 'resource_mismatch');
});

test('the result report is validated strictly and size-capped', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t);
  const admission = await admit(t, t.alice, { resource_id: r.resource.id });
  const submitted = await submitJob(t, S(t, t.alice), submitBody(admission.json.admission_ref));
  const lease = await (await nextJob(t, K(t, r.hb.secret))).json();

  const missingLease = await postResult(t, r.hb.secret, lease.job_id, { status: 'succeeded', result: {} });
  assert.equal(missingLease.status, 400);
  assert.equal((await readJson(missingLease)).json.code, 'INVALID_RESULT');

  const badStatus = await postResult(t, r.hb.secret, lease.job_id, { ...resultFor(lease), status: 'simulated' });
  assert.equal(badStatus.status, 400);

  const simulated = await postResult(t, r.hb.secret, lease.job_id, {
    ...resultFor(lease), result: { ...resultFor(lease).result, simulated: true },
  });
  assert.equal(simulated.status, 400);
  assert.equal((await readJson(simulated)).json.code, 'INVALID_RESULT');

  const oversized = await postResult(t, r.hb.secret, lease.job_id, {
    ...resultFor(lease), result: { ...resultFor(lease).result, content: 'x'.repeat(1024 * 1024 + 1) },
  });
  assert.equal(oversized.status, 413);
  assert.equal((await readJson(oversized)).json.code, 'BODY_TOO_LARGE');
});

// Addendum A: the worker echoes the lease frame. These two bodies are the
// exact wire shapes it sends, driven through lease -> result -> reconcile.
test('worker wire shapes: the exact succeeded and failed reports settle their jobs', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t);

  // ---- succeeded
  const a1 = await admit(t, t.alice, { resource_id: r.resource.id });
  const s1 = await submitJob(t, S(t, t.alice), submitBody(a1.json.admission_ref));
  assert.equal(s1.status, 202, s1.text);
  const lease = await (await nextJob(t, K(t, r.hb.secret))).json();
  const p = lease.envelope.task.placement;
  const b = lease.envelope.binding;
  const succeeded = {
    lease_id: lease.lease_id,
    status: 'succeeded',
    result: {
      request_id: lease.job_id,
      node_id: p.node_id,
      runtime_id: p.runtime_id,
      model_id: lease.envelope.task.model_id,
      runtime_instance: b.runtime_instance,
      model_fingerprint: b.model_fingerprint,
      simulated: false,
      content: 'hello',
      elapsed_ms: 12,
      usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 },
      cache: { hit: false },
    },
  };
  assert.deepEqual(Object.keys(succeeded.result).sort(), [
    'cache', 'content', 'elapsed_ms', 'model_fingerprint', 'model_id', 'node_id',
    'request_id', 'runtime_id', 'runtime_instance', 'simulated', 'usage',
  ]);
  const ok = await readJson(await postResult(t, r.hb.secret, lease.job_id, succeeded));
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json, { ok: true, job_id: lease.job_id, status: 'succeeded' });
  const done = await readJson(await t.call('/api/jobs/alice-op-00000001', { headers: S(t, t.alice) }));
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.status, 'settled');
  assert.equal(done.json.outcome.finish, 'succeeded');
  assert.equal(done.json.outcome.released, true);
  assert.equal(done.json.outcome.content, 'hello');

  // ---- failed
  const a2 = await admit(t, t.alice, { resource_id: r.resource.id });
  const s2 = await submitJob(t, S(t, t.alice), submitBody(a2.json.admission_ref, { idempotency_key: 'alice-op-00000002' }));
  assert.equal(s2.status, 202, s2.text);
  const lease2 = await (await nextJob(t, K(t, r.hb.secret))).json();
  assert.equal(lease2.job_id, s2.json.job_id);

  // Addendum A forbids content, or any other key, on a failed result. The
  // refused report must not consume the lease.
  const withContent = await readJson(await postResult(t, r.hb.secret, lease2.job_id, {
    lease_id: lease2.lease_id, status: 'failed',
    result: { reason: 'UPSTREAM_ERROR', content: 'partial' },
  }));
  assert.equal(withContent.status, 400);
  assert.equal(withContent.json.code, 'INVALID_RESULT');

  const failed = {
    lease_id: lease2.lease_id,
    status: 'failed',
    result: { reason: 'UPSTREAM_ERROR', detail: 'llama-server exited 1', elapsed_ms: 40, usage: {}, cache: {} },
  };
  assert.deepEqual(Object.keys(failed.result).sort(), ['cache', 'detail', 'elapsed_ms', 'reason', 'usage']);
  const failedRes = await readJson(await postResult(t, r.hb.secret, lease2.job_id, failed));
  assert.equal(failedRes.status, 200, failedRes.text);
  assert.deepEqual(failedRes.json, { ok: true, job_id: lease2.job_id, status: 'failed' });  const done2 = await readJson(await t.call('/api/jobs/alice-op-00000002', { headers: S(t, t.alice) }));
  assert.equal(done2.status, 200, done2.text);
  assert.equal(done2.json.status, 'settled');
  assert.equal(done2.json.outcome.finish, 'failed');
  assert.equal(done2.json.outcome.released, false);
  assert.equal(done2.json.outcome.content, undefined);
});

// ------------------------------------------------------------- forged input

test('client-signed authority fields in the submit body are refused as forged', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t);
  const admission = await admit(t, t.alice, { resource_id: r.resource.id });
  for (const forged of [
    { principal_id: 'u_bob' }, { tenant_id: 'u_bob' }, { grant_id: 'grant-1' },
    { placement: { device: 'cpu', node_id: 'elsewhere' } }, { authenticated: true },
  ]) {
    const out = await submitJob(t, K(t, r.inference), submitBody(admission.json.admission_ref, forged));
    assert.equal(out.status, 400, JSON.stringify(forged));
    assert.equal(out.json.code, 'FORGED_CLIENT_AUTHORITY', JSON.stringify(forged));
  }
});

// --------------------------------------------------------------- grant path

test('a live grantee grant admits and submits under the same no-stitching policy', async () => {
  const t = await createTestEnv(ENABLED);
  const store = useStore(t);
  const r = await ready(t);
  const now = new Date().toISOString();
  await t.DB.prepare(`INSERT INTO grants (id, resource_id, owner_id, grantee_id, max_jobs, max_tokens, used_jobs, used_tokens, inference_only, created_at, revoked_at)
    VALUES ('g_shared01', ?, ?, ?, 5, 1000, 0, 0, 1, ?, NULL)`)
    .bind(r.resource.id, t.alice.id, t.bob.id, now).run();

  const admission = await admit(t, t.bob, { resource_id: r.resource.id, max_tokens: 100 });
  assert.equal(admission.status, 201, admission.text);
  assert.equal(store.state.admissions[admission.json.admission_ref].grant_id, 'g_shared01');

  const submitted = await submitJob(t, S(t, t.bob), submitBody(admission.json.admission_ref, { idempotency_key: 'bob-op-00000001', max_tokens: 100 }));
  assert.equal(submitted.status, 202, submitted.text);

  // Revoking the grant before release withholds content (still settled).
  store.state.grants.g_shared01.revoked = true;
  store.state.grants.g_shared01.status = 'revoked';
  const lease = await (await nextJob(t, K(t, r.hb.secret))).json();
  const accepted = await readJson(await postResult(t, r.hb.secret, lease.job_id, resultFor(lease)));
  assert.equal(accepted.status, 200, accepted.text);
  const done = await readJson(await t.call('/api/jobs/bob-op-00000001', { headers: S(t, t.bob) }));
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.outcome.released, false);
  assert.equal(done.json.outcome.withheld_reason, 'authority_revoked_before_release');
  assert.equal(done.json.outcome.content, undefined);
});

// ------------------------------------------------------------------ cancel

test('cancel after start reports UNSUPPORTED_CAPABILITY and requires session CSRF', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t);
  const admission = await admit(t, t.alice, { resource_id: r.resource.id });
  const submitted = await submitJob(t, S(t, t.alice), submitBody(admission.json.admission_ref));
  assert.equal(submitted.status, 202, submitted.text);

  const noCsrf = await readJson(await t.call('/api/jobs/alice-op-00000001/cancel', { method: 'POST', headers: t.as(t.alice) }));
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.code, 'CSRF_REQUIRED');

  const out = await readJson(await t.call('/api/jobs/alice-op-00000001/cancel', { method: 'POST', headers: S(t, t.alice) }));
  assert.equal(out.status, 202, out.text);
  assert.equal(out.json.cancel, 'UNSUPPORTED_CAPABILITY');
});

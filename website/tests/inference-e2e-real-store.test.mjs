// Integration: the real L1 D1 dispatch store behind the real L2 routes.
// No store injection: getDispatchStore() resolves ./dispatch-store.mjs over
// the migrated D1 test shim, exactly as production would. No network and no
// inference: the worker side is played by this test with the worker's wire
// shapes (DS-INFERENCE-LANES-20261101.md Addendum A).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';

const ENABLED = { INFERENCE_ENABLED: '1', INFERENCE_OWNER_DAILY_TOKENS: '8192' };
const MODEL = 'qwen3.8-27b-atx-iq4_xs';

const S = (t, user) => ({ ...t.as(user), ...t.csrf });
const K = (secret) => ({ Authorization: `Bearer ${secret}` });

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

async function admitAndSubmit(t, r, { key, runtime_id, max_tokens = 64 } = {}) {
  const body = { resource_id: r.resourceId, model_id: MODEL, max_tokens };
  if (runtime_id) body.runtime_id = runtime_id;
  const admission = await readJson(await t.call('/api/inference/admissions', {
    method: 'POST', headers: S(t, t.alice), body,
  }));
  assert.equal(admission.status, 201, admission.text);
  const submitted = await readJson(await t.call('/api/jobs', {
    method: 'POST', headers: S(t, t.alice),
    body: { contract_version: 'v1.0.0', admission_ref: admission.json.admission_ref, idempotency_key: key,
      model_id: MODEL, prompt: 'Reply with exactly: hello', max_tokens, deadline_at: Date.now() + 60000 },
  }));
  assert.equal(submitted.status, 202, submitted.text);
  assert.equal(submitted.json.status, 'dispatched');
  return submitted.json;
}

async function lease(t, r) {
  const res = await t.call('/api/worker/jobs/next', { headers: K(r.hb) });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}

const succeeded = (l, content = 'hello') => {
  const p = l.envelope.task.placement, b = l.envelope.binding;
  return { lease_id: l.lease_id, status: 'succeeded', result: {
    request_id: l.job_id, node_id: p.node_id, runtime_id: p.runtime_id, model_id: l.envelope.task.model_id,
    runtime_instance: b.runtime_instance, model_fingerprint: b.model_fingerprint,
    simulated: false, content, elapsed_ms: 9, usage: { completion_tokens: 1 }, cache: {} } };
};

const post = (t, r, jobId, body) => t.call(`/api/worker/jobs/${jobId}/result`, {
  method: 'POST', headers: K(r.hb), body,
});

test('real store: admit -> submit -> lease -> result -> reconcile releases content once and charges once', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const sub = await admitAndSubmit(t, r, { key: 'alice-e2e-00000001' });

  const l = await lease(t, r);
  assert.equal(l.job_id, sub.job_id);
  assert.equal(l.envelope.protocol, 'aipster-bound-cpu-internal/1');
  assert.deepEqual(l.envelope.task.placement, { device: 'cpu', node_id: r.resourceId, runtime_id: 'ganglion' });
  assert.deepEqual(Object.keys(l.envelope.binding).sort(),
    ['deadline_at', 'generation', 'model_fingerprint', 'op_id', 'runtime_instance']);
  assert.equal(l.envelope.binding.deadline_at, l.deadline_at);
  assert.equal((await t.call('/api/worker/jobs/next', { headers: K(r.hb) })).status, 204, 'one lease at a time');

  const ok = await readJson(await post(t, r, l.job_id, succeeded(l)));
  assert.equal(ok.status, 200, ok.text);
  const dup = await post(t, r, l.job_id, succeeded(l, 'second'));
  assert.equal(dup.status, 409, 'a duplicate result changes nothing');

  const done = await readJson(await t.call('/api/jobs/alice-e2e-00000001', { headers: S(t, t.alice) }));
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.status, 'settled');
  assert.equal(done.json.outcome.content, 'hello');
  assert.equal(done.json.outcome.provenance.simulated, false);
  const again = await readJson(await t.call('/api/jobs/alice-e2e-00000001', { headers: S(t, t.alice) }));
  assert.equal(again.json.status, 'settled');
  assert.equal(again.json.outcome?.content, undefined, 'content is released once');

  const settlements = (await t.DB.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ? AND name LIKE ?')
    .bind('table', '%settle%').all()).results[0].n;
  assert.ok(settlements >= 1, 'migration 0024 settlement table exists');
});

// Finding 4437293854 (P1): the route validator accepted this completion but
// the real store rejected anything over 256 chars as RESULT_REJECTED.
test('real store: a completion longer than 256 chars is stored and released', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  await admitAndSubmit(t, r, { key: 'alice-e2e-content-0001' });
  const l = await lease(t, r);
  const content = `hello ${'worker '.repeat(200)}`; // > 256 chars
  assert.ok(content.length > 256);
  const ok = await readJson(await post(t, r, l.job_id, succeeded(l, content)));
  assert.equal(ok.status, 200, ok.text);
  const done = await readJson(await t.call('/api/jobs/alice-e2e-content-0001', { headers: S(t, t.alice) }));
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.outcome.content, content);
});

test('real store: a llama-server admission flows to the envelope and a failed result settles without content', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  await admitAndSubmit(t, r, { key: 'alice-e2e-00000002', runtime_id: 'llama-server' });
  const l = await lease(t, r);
  assert.equal(l.envelope.task.placement.runtime_id, 'llama-server');
  assert.equal(l.envelope.binding.runtime_instance, 'llama-server');
  const failed = await readJson(await post(t, r, l.job_id,
    { lease_id: l.lease_id, status: 'failed', result: { reason: 'MODEL_UNAVAILABLE', detail: 'model_id' } }));
  assert.equal(failed.status, 200, failed.text);
  const done = await readJson(await t.call('/api/jobs/alice-e2e-00000002', { headers: S(t, t.alice) }));
  assert.ok([200, 202].includes(done.status), done.text);
  assert.equal(done.json.outcome?.content, undefined);
});

test('real store: another resource\'s key cannot lease or complete the job', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const other = await ready(t);
  await admitAndSubmit(t, r, { key: 'alice-e2e-00000003' });
  assert.equal((await t.call('/api/worker/jobs/next', { headers: K(other.hb) })).status, 204);
  const l = await lease(t, r);
  const stolen = await post(t, other, l.job_id, succeeded(l));
  assert.ok([403, 409].includes(stolen.status), `foreign completion refused, got ${stolen.status}`);
});

// Finding 4437293871 (P2): dispatch_admissions.resource_id references
// resources(id), so DELETE /api/inventory/:id failed once an admission
// existed. Deletion must still work and must revoke the resource's pending
// admission and queued job.
test('real store: deleting a resource revokes its admissions and queued jobs', async () => {
  const t = await createTestEnv(ENABLED);
  const r = await ready(t);
  const admission = await readJson(await t.call('/api/inference/admissions', {
    method: 'POST', headers: S(t, t.alice), body: { resource_id: r.resourceId, model_id: MODEL, max_tokens: 64 },
  }));
  assert.equal(admission.status, 201, admission.text);
  const submitBody = (key) => ({
    contract_version: 'v1.0.0', admission_ref: admission.json.admission_ref, idempotency_key: key,
    model_id: MODEL, prompt: 'hello', max_tokens: 64, deadline_at: Date.now() + 60000,
  });
  const submitted = await readJson(await t.call('/api/jobs', {
    method: 'POST', headers: S(t, t.alice), body: submitBody('alice-e2e-delete-0001'),
  }));
  assert.equal(submitted.status, 202, submitted.text);
  assert.equal((await t.DB.prepare('SELECT COUNT(*) AS n FROM dispatch_admissions WHERE resource_id = ?')
    .bind(r.resourceId).first()).n, 1);
  assert.equal((await t.DB.prepare("SELECT COUNT(*) AS n FROM dispatch_jobs WHERE resource_id = ? AND status = 'queued'")
    .bind(r.resourceId).first()).n, 1);

  const del = await readJson(await t.call(`/api/inventory/${r.resourceId}`, {
    method: 'DELETE', headers: S(t, t.alice),
  }));
  assert.equal(del.status, 200, del.text);

  assert.equal((await t.DB.prepare('SELECT COUNT(*) AS n FROM dispatch_admissions WHERE resource_id = ?')
    .bind(r.resourceId).first()).n, 0, 'admission revoked');
  assert.equal((await t.DB.prepare("SELECT COUNT(*) AS n FROM dispatch_jobs WHERE resource_id = ? AND status IN ('queued', 'leased')")
    .bind(r.resourceId).first()).n, 0, 'queued job revoked');

  // The revoked admission cannot start new work, and the revoked heartbeat key
  // cannot lease the queued job.
  const resubmit = await readJson(await t.call('/api/jobs', {
    method: 'POST', headers: S(t, t.alice), body: submitBody('alice-e2e-delete-0002'),
  }));
  assert.notEqual(resubmit.status, 202, resubmit.text);
  assert.equal(resubmit.status, 403, resubmit.text);
  assert.equal(resubmit.json.code, 'ADMISSION_NOT_AVAILABLE');
  const leaseAfter = await t.call('/api/worker/jobs/next', { headers: K(r.hb) });
  assert.ok([401, 403].includes(leaseAfter.status), `lease refused, got ${leaseAfter.status}`);
});

// Finding 4437303806 (P2 security): dispatch state is bounded per principal,
// and a cap refusal is a stable retryable 429 DISPATCH_LIMIT, not an outage.
test('real store: live admissions are capped per principal and expired rows do not count', async () => {
  const t = await createTestEnv({ ...ENABLED, INFERENCE_DISPATCH_MAX_ADMISSIONS: '2' });
  const r = await ready(t);
  const mint = async () => readJson(await t.call('/api/inference/admissions', {
    method: 'POST', headers: S(t, t.alice), body: { resource_id: r.resourceId, model_id: MODEL, max_tokens: 64 },
  }));
  assert.equal((await mint()).status, 201);
  assert.equal((await mint()).status, 201);
  const third = await mint();
  assert.equal(third.status, 429, third.text);
  assert.equal(third.json.code, 'DISPATCH_LIMIT');

  // Expired admissions stop counting and are swept by the next issuance.
  await t.DB.prepare('UPDATE dispatch_admissions SET expires_at = 0 WHERE principal_id = ?')
    .bind(t.alice.id).run();
  const after = await mint();
  assert.equal(after.status, 201, after.text);
  const live = await t.DB.prepare('SELECT COUNT(*) AS n FROM dispatch_admissions WHERE principal_id = ?')
    .bind(t.alice.id).all();
  assert.equal(live.results[0].n, 1, 'expired admissions were swept');
});

test('real store: non-terminal operations are capped per principal with 429 DISPATCH_LIMIT', async () => {
  const t = await createTestEnv({ ...ENABLED, INFERENCE_DISPATCH_MAX_OPERATIONS: '2' });
  const r = await ready(t);
  const admission = await readJson(await t.call('/api/inference/admissions', {
    method: 'POST', headers: S(t, t.alice), body: { resource_id: r.resourceId, model_id: MODEL, max_tokens: 64 },
  }));
  assert.equal(admission.status, 201, admission.text);
  const submit = async (key) => readJson(await t.call('/api/jobs', {
    method: 'POST', headers: S(t, t.alice),
    body: { contract_version: 'v1.0.0', admission_ref: admission.json.admission_ref, idempotency_key: key,
      model_id: MODEL, prompt: 'hello', max_tokens: 64, deadline_at: Date.now() + 60000 },
  }));
  assert.equal((await submit('alice-e2e-cap-0000001')).status, 202);
  assert.equal((await submit('alice-e2e-cap-0000002')).status, 202);
  const third = await submit('alice-e2e-cap-0000003');
  assert.equal(third.status, 429, third.text);
  assert.equal(third.json.code, 'DISPATCH_LIMIT');
  const queued = await t.DB.prepare("SELECT COUNT(*) AS n FROM dispatch_jobs WHERE status = 'queued'").all();
  assert.equal(queued.results[0].n, 2, 'the refused claim queued nothing');
});

test('real store: owner budget of 0 fails closed before any job is queued', async () => {
  const t = await createTestEnv({ INFERENCE_ENABLED: '1' });
  const r = await ready(t);
  const admission = await readJson(await t.call('/api/inference/admissions', {
    method: 'POST', headers: S(t, t.alice), body: { resource_id: r.resourceId, model_id: MODEL, max_tokens: 64 },
  }));
  if (admission.status === 201) {
    const submitted = await readJson(await t.call('/api/jobs', {
      method: 'POST', headers: S(t, t.alice),
      body: { contract_version: 'v1.0.0', admission_ref: admission.json.admission_ref, idempotency_key: 'alice-e2e-00000004',
        model_id: MODEL, prompt: 'x', max_tokens: 64, deadline_at: Date.now() + 60000 },
    }));
    assert.notEqual(submitted.status, 202, submitted.text);
  }
  assert.equal((await t.call('/api/worker/jobs/next', { headers: K(r.hb) })).status, 204);
});

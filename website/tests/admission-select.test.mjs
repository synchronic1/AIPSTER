// ADMISSION-WIRING-001: opt-in server selection wired into the existing
// admission authority. Offline only: in-memory L1 fake store + real worker.js
// + D1 test shim. No live inference, no network beyond the in-process path.
// Failing-first: these tests define the select contract before the route hunk.
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

async function register(t, user, name) {
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

async function ready(t, user, name) {
  const resource = await register(t, user, name);
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

const admitSelect = async (t, user, body) => readJson(await t.call('/api/inference/admissions', {
  method: 'POST', headers: S(t, user), body,
}));

const submitBody = (admission_ref, over = {}) => ({
  contract_version: 'v1.0.0', admission_ref, idempotency_key: 'alice-op-00000001',
  model_id: MODEL, prompt: PROMPT, max_tokens: 128, deadline_at: Date.now() + 60000, ...over,
});

function resultFor(lease) {
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
    },
  };
}

// --------------------------------------------------------------- select path

test('select: fresh owned resource is server-picked and runs the full authority lifecycle', async () => {
  const t = await createTestEnv(ENABLED);
  const store = useStore(t);
  const r = await ready(t, t.alice, 'abox');
  const out = await admitSelect(t, t.alice, { model_id: MODEL, max_tokens: 64, select: {} });
  assert.equal(out.status, 201, out.text);
  assert.deepEqual(Object.keys(out.json).sort(),
    ['admission_ref', 'expires_at', 'max_tokens', 'model_id', 'selection']);
  const sel = out.json.selection;
  assert.equal(sel.resource_id, r.resource.id);
  assert.equal(sel.device, 'cpu');
  assert.equal(sel.runtime_id, 'ganglion');
  assert.equal(sel.evidence.liveness, 'online');
  assert.equal(sel.evidence.modelCompat, 'unverified');
  assert.ok(Number.isFinite(sel.score));
  assert.equal(Object.keys(store.state.admissions).length, 1);

  // The minted admission is ordinary authority: submit -> lease -> result -> settle.
  const submitted = await readJson(await t.call('/api/jobs', {
    method: 'POST', headers: S(t, t.alice),
    body: submitBody(out.json.admission_ref, { max_tokens: 64 }),
  }));
  assert.equal(submitted.status, 202, submitted.text);
  const lease = await (await t.call('/api/worker/jobs/next', { headers: K(t, r.hb.secret) })).json();
  assert.deepEqual(lease.envelope.task.placement,
    { device: 'cpu', node_id: r.resource.id, runtime_id: 'ganglion' });
  const accepted = await readJson(await t.call(`/api/worker/jobs/${lease.job_id}/result`, {
    method: 'POST', headers: K(t, r.hb.secret), body: resultFor(lease),
  }));
  assert.equal(accepted.status, 200, accepted.text);
  const done = await readJson(await t.call('/api/jobs/alice-op-00000001', { headers: S(t, t.alice) }));
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.status, 'settled');
  assert.equal(done.json.outcome.content, 'hello');
});

test('omitting both resource_id and select keeps the legacy refusal', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  await ready(t, t.alice, 'abox');
  const out = await admitSelect(t, t.alice, { model_id: MODEL, max_tokens: 64 });
  assert.equal(out.status, 400);
  assert.equal(out.json.code, 'BAD_RESOURCE');
});

test('select rejects unknown fields and non-objects', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  await ready(t, t.alice, 'abox');
  for (const select of [{ device: 'cpu', node_id: 'elsewhere' }, { runtime_id: 'x' }, 'cpu', true, 1]) {
    const out = await admitSelect(t, t.alice, { model_id: MODEL, max_tokens: 64, select });
    assert.equal(out.status, 400, `select=${JSON.stringify(select)}`);
    assert.ok(['UNSUPPORTED_FIELD', 'BAD_RESOURCE'].includes(out.json.code), out.text);
  }
});

test('gpu select is refused explicitly and mints nothing', async () => {
  const t = await createTestEnv(ENABLED);
  const store = useStore(t);
  await ready(t, t.alice, 'abox');
  const out = await admitSelect(t, t.alice, { model_id: MODEL, max_tokens: 64, select: { device: 'gpu' } });
  assert.equal(out.status, 400, out.text);
  assert.equal(out.json.code, 'DEVICE_UNSUPPORTED');
  assert.deepEqual(store.state.admissions, {});
});

test('select with an off-allowlist runtime keeps BAD_RUNTIME', async () => {
  const t = await createTestEnv(ENABLED);
  const store = useStore(t);
  await ready(t, t.alice, 'abox');
  const out = await admitSelect(t, t.alice,
    { model_id: MODEL, max_tokens: 64, runtime_id: 'cuda-rt', select: {} });
  assert.equal(out.status, 400);
  assert.equal(out.json.code, 'BAD_RUNTIME');
  assert.deepEqual(store.state.admissions, {});
});

test('select with no eligible node is a precise 409 and mints nothing', async () => {
  const t = await createTestEnv(ENABLED);
  const store = useStore(t);
  const r = await ready(t, t.alice, 'abox');
  const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  await t.DB.prepare('UPDATE resources SET heartbeat_at = ? WHERE id = ?').bind(stale, r.resource.id).run();
  const out = await admitSelect(t, t.alice, { model_id: MODEL, max_tokens: 64, select: {} });
  assert.equal(out.status, 409, out.text);
  assert.equal(out.json.code, 'NO_ELIGIBLE_NODE');
  assert.deepEqual(store.state.admissions, {});

  const stranger = await admitSelect(t, t.bob, { model_id: MODEL, max_tokens: 64, select: {} });
  assert.equal(stranger.status, 409);
  assert.equal(stranger.json.code, 'NO_ELIGIBLE_NODE');
});

test('selection never crosses tenants and discloses no foreign ids', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const a = await ready(t, t.alice, 'abox');
  const b = await ready(t, t.bob, 'bbox');
  const out = await admitSelect(t, t.alice, { model_id: MODEL, max_tokens: 64, select: {} });
  assert.equal(out.status, 201, out.text);
  assert.equal(out.json.selection.resource_id, a.resource.id);
  assert.ok(!JSON.stringify(out.json).includes(b.resource.id),
    'foreign resource id must not appear in the selection response');
  const bout = await admitSelect(t, t.bob, { model_id: MODEL, max_tokens: 64, select: {} });
  assert.equal(bout.status, 201, bout.text);
  assert.equal(bout.json.selection.resource_id, b.resource.id);
});

test('select honors a live same-side grant for a resourceless grantee', async () => {
  const t = await createTestEnv(ENABLED);
  const store = useStore(t);
  const r = await ready(t, t.alice, 'abox');
  const now = new Date().toISOString();
  await t.DB.prepare(`INSERT INTO grants (id, resource_id, owner_id, grantee_id, max_jobs, max_tokens, used_jobs, used_tokens, inference_only, created_at, revoked_at)
    VALUES ('g_shared01', ?, ?, ?, 5, 1000, 0, 0, 1, ?, NULL)`)
    .bind(r.resource.id, t.alice.id, t.bob.id, now).run();
  const out = await admitSelect(t, t.bob, { model_id: MODEL, max_tokens: 100, select: {} });
  assert.equal(out.status, 201, out.text);
  assert.equal(out.json.selection.resource_id, r.resource.id);
  assert.equal(store.state.admissions[out.json.admission_ref].grant_id, 'g_shared01');
});

test('select with llama-server runtime pins placement end to end', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t, t.alice, 'abox');
  const out = await admitSelect(t, t.alice,
    { model_id: MODEL, max_tokens: 64, runtime_id: 'llama-server', select: {} });
  assert.equal(out.status, 201, out.text);
  assert.equal(out.json.selection.runtime_id, 'llama-server');
  const submitted = await readJson(await t.call('/api/jobs', {
    method: 'POST', headers: S(t, t.alice),
    body: submitBody(out.json.admission_ref, { max_tokens: 64 }),
  }));
  assert.equal(submitted.status, 202, submitted.text);
  const lease = await (await t.call('/api/worker/jobs/next', { headers: K(t, r.hb.secret) })).json();
  assert.deepEqual(lease.envelope.task.placement,
    { device: 'cpu', node_id: r.resource.id, runtime_id: 'llama-server' });
});

test('flag off: the select path stays dark', async () => {
  const t = await createTestEnv();
  useStore(t);
  const r = await ready(t, t.alice, 'abox');
  const out = await admitSelect(t, t.alice, { model_id: MODEL, max_tokens: 64, select: {} });
  assert.equal(out.status, 404);
  assert.equal(r.resource.id.length > 0, true);
});

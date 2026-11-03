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

const S = (t, user, extra = {}) => ({ ...t.as(user), ...t.csrf, ...extra });
const K = (t, secret, extra = {}) => ({ Authorization: `Bearer ${secret}`, ...extra });

afterEach(() => __setDispatchStoreFactoryForTest(null));

async function register(t, user, name, capabilities) {
  const body = { name, kind: 'local', origin: 'lab', cpu: 'x', gpu: 'y' };
  if (capabilities !== undefined) body.capabilities = capabilities;
  const out = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: S(t, user), body,
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

async function ready(t, user, name, capabilities) {
  const resource = await register(t, user, name, capabilities);
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

// --------------------------------------------------------------- select path

test('select with unattested fresh/usable resource refuses with advisory evidence and mints nothing', async () => {
  const t = await createTestEnv(ENABLED);
  const store = useStore(t);
  const before = JSON.stringify(store.state);
  // Matching soft model token, authorized/online/usable — but no resident or
  // exact-instance qualification evidence exists for any row.
  const r = await ready(t, t.alice, 'abox', ['test-model-uno']);
  const out = await admitSelect(t, t.alice, { model_id: 'test-model-uno', max_tokens: 64, select: {} });
  assert.equal(out.status, 409, out.text);
  assert.equal(out.json.code, 'SELECTION_UNQUALIFIED');
  assert.ok(!('admission_ref' in out.json), 'refusal must not mint an admission');
  const sel = out.json.selection;
  assert.equal(sel.resource_id, r.resource.id);
  assert.equal(sel.device, 'cpu');
  assert.equal(sel.runtime_id, 'ganglion');
  assert.equal(sel.evidence.liveness, 'online');
  assert.equal(sel.evidence.modelCompat, 'unverified');
  assert.ok(Number.isFinite(sel.score));
  assert.ok(Number.isSafeInteger(sel.examined) && Number.isSafeInteger(sel.excluded));
  assert.equal(JSON.stringify(store.state), before, 'refusal must not mutate store state');
  // No implicit fallback: the same unattested model still admits explicitly (legacy unchanged).
  const explicit = await readJson(await t.call('/api/inference/admissions', {
    method: 'POST', headers: S(t, t.alice),
    body: { resource_id: r.resource.id, model_id: 'test-model-uno', max_tokens: 64 },
  }));
  assert.equal(explicit.status, 201, explicit.text);
  assert.ok(!('selection' in explicit.json));
});

test('select with an unknown model string refuses despite zero token match', async () => {
  const t = await createTestEnv(ENABLED);
  const store = useStore(t);
  const before = JSON.stringify(store.state);
  const r = await ready(t, t.alice, 'abox');
  const out = await admitSelect(t, t.alice,
    { model_id: 'zzz-no-such-model-anywhere', max_tokens: 64, select: {} });
  assert.equal(out.status, 409, out.text);
  assert.equal(out.json.code, 'SELECTION_UNQUALIFIED');
  assert.ok(!('admission_ref' in out.json));
  assert.equal(out.json.selection.resource_id, r.resource.id);
  assert.equal(out.json.selection.evidence.modelCompat, 'unverified');
  assert.equal(JSON.stringify(store.state), before);
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
  assert.equal(out.status, 409, out.text);
  assert.equal(out.json.code, 'SELECTION_UNQUALIFIED');
  assert.equal(out.json.selection.resource_id, a.resource.id);
  assert.ok(!JSON.stringify(out.json).includes(b.resource.id),
    'foreign resource id must not appear in the selection response');
  const bout = await admitSelect(t, t.bob, { model_id: MODEL, max_tokens: 64, select: {} });
  assert.equal(bout.status, 409, bout.text);
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
  assert.equal(out.status, 409, out.text);
  assert.equal(out.json.code, 'SELECTION_UNQUALIFIED');
  assert.ok(!('admission_ref' in out.json));
  assert.equal(out.json.selection.resource_id, r.resource.id);
  assert.deepEqual(store.state.admissions, {});
});

test('select with llama-server runtime refuses with truthful advisory evidence', async () => {
  const t = await createTestEnv(ENABLED);
  const store = useStore(t);
  await ready(t, t.alice, 'abox');
  const out = await admitSelect(t, t.alice,
    { model_id: MODEL, max_tokens: 64, runtime_id: 'llama-server', select: {} });
  assert.equal(out.status, 409, out.text);
  assert.equal(out.json.code, 'SELECTION_UNQUALIFIED');
  assert.ok(!('admission_ref' in out.json));
  assert.equal(out.json.selection.runtime_id, 'llama-server');
  assert.deepEqual(store.state.admissions, {});
});

test('flag off: the select path stays dark', async () => {
  const t = await createTestEnv();
  useStore(t);
  const r = await ready(t, t.alice, 'abox');
  const out = await admitSelect(t, t.alice, { model_id: MODEL, max_tokens: 64, select: {} });
  assert.equal(out.status, 404);
  assert.equal(r.resource.id.length > 0, true);
});

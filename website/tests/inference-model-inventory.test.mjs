// W1: per-resource advertised model inventory (heartbeat -> D1 -> admission).
//
// Drives the REAL worker.js over the in-memory D1 shim (migration 0025) with
// the L1 dispatch-store test double. No live inference, no network beyond the
// in-process Request/Response path. Covers:
//   * heartbeat stores a strictly bounded `models` list with its observed_at,
//   * malformed lists are 400 and store nothing (and do not beat),
//   * a beat without `models` leaves the list unchanged while it ages,
//   * admission refuses a fresh list that lacks the model (409
//     MODEL_NOT_ADVERTISED) and reports model_advertised otherwise,
//   * resource deletion removes the inventory row (0025 FK).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { createFakeDispatchStore } from './fixtures/dispatch-store-fake.mjs';
import { __setDispatchStoreFactoryForTest } from '../src/inference/dispatch-wiring.mjs';

const ENABLED = { INFERENCE_ENABLED: '1', INFERENCE_OWNER_DAILY_TOKENS: '8192' };
const MODEL = 'deepseek-v4.1-flash:1017-cloud';
const OTHER = 'qwen3.8-27b-atx-iq4_xs';
const STALE_MS = 5 * 60 * 1000;

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

async function ready(t, user = t.alice) {
  const resource = await register(t, user);
  const hb = await mintKey(t, user, 'heartbeat', resource.id);
  const inference = await mintKey(t, user, 'inference');
  return { resource, hb: hb.secret, inference: inference.secret };
}

const models = (model_ids = [MODEL], runtime_id = 'ganglion') => ({ runtime_id, model_ids });

function beat(t, secret, id, body) {
  return t.call(`/api/resources/${id}/heartbeat`, {
    method: 'POST', headers: K(t, secret),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const beatWith = (t, secret, id, model_ids, runtime_id) =>
  beat(t, secret, id, { usable: true, models: models(model_ids, runtime_id) });

const storedRow = (t, id) => t.DB.prepare('SELECT * FROM resource_models WHERE resource_id = ?').bind(id).first();

async function backdateHeartbeat(t, id, ms) {
  await t.DB.prepare('UPDATE resources SET heartbeat_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - ms).toISOString(), id).run();
}

function useStore(t) {
  const store = createFakeDispatchStore(t.DB, { env: t.env });
  __setDispatchStoreFactoryForTest(() => store);
  return store;
}

async function admit(t, user, { resource_id, model_id = MODEL, max_tokens = 128 } = {}) {
  return readJson(await t.call('/api/inference/admissions', {
    method: 'POST', headers: S(t, user), body: { resource_id, model_id, max_tokens },
  }));
}

// ------------------------------------------------------- heartbeat storage

test('heartbeat: a valid advertised list is stored with the server observed_at', async () => {
  const t = await createTestEnv();
  const r = await ready(t);
  const out = await readJson(await beatWith(t, r.hb, r.resource.id, [MODEL, OTHER]));
  assert.equal(out.status, 200, out.text);

  const row = await storedRow(t, r.resource.id);
  assert.equal(row.runtime_id, 'ganglion');
  assert.deepEqual(JSON.parse(row.model_ids_json), [MODEL, OTHER]);
  assert.equal(row.observed_at, out.json.heartbeatAt, 'observed_at is the accepted beat time');
});

test('heartbeat: a beat without models leaves the stored list unchanged but ageing', async () => {
  const t = await createTestEnv();
  const r = await ready(t);
  const first = await readJson(await beatWith(t, r.hb, r.resource.id, [MODEL]));
  assert.equal(first.status, 200, first.text);
  const before = await storedRow(t, r.resource.id);

  // The 25s window would refuse an immediate second beat; backdate it while
  // keeping the stored advert's observed_at untouched.
  await backdateHeartbeat(t, r.resource.id, 30_000);
  const second = await readJson(await beat(t, r.hb, r.resource.id, { usable: true }));
  assert.equal(second.status, 200, second.text);

  const after = await storedRow(t, r.resource.id);
  assert.deepEqual(JSON.parse(after.model_ids_json), [MODEL], 'list unchanged');
  assert.equal(after.observed_at, before.observed_at, 'observed_at unchanged: the list ages');
  assert.ok(second.json.heartbeatAt > first.json.heartbeatAt, 'the heartbeat itself advanced');
});

test('heartbeat: re-advertising replaces the list, runtime and observed_at', async () => {
  const t = await createTestEnv();
  const r = await ready(t);
  assert.equal((await readJson(await beatWith(t, r.hb, r.resource.id, [MODEL]))).status, 200);
  await backdateHeartbeat(t, r.resource.id, 30_000);

  const out = await readJson(await beatWith(t, r.hb, r.resource.id, [OTHER], 'llama-server'));
  assert.equal(out.status, 200, out.text);
  const row = await storedRow(t, r.resource.id);
  assert.equal(row.runtime_id, 'llama-server');
  assert.deepEqual(JSON.parse(row.model_ids_json), [OTHER]);
  assert.equal(row.observed_at, out.json.heartbeatAt);
  assert.equal(
    (await t.DB.prepare('SELECT COUNT(*) AS n FROM resource_models WHERE resource_id = ?').bind(r.resource.id).first()).n,
    1, 'one inventory row per resource',
  );
});

test('heartbeat: duplicate ids are collapsed and order is preserved', async () => {
  const t = await createTestEnv();
  const r = await ready(t);
  const out = await readJson(await beatWith(t, r.hb, r.resource.id, [OTHER, MODEL, OTHER]));
  assert.equal(out.status, 200, out.text);
  assert.deepEqual(JSON.parse((await storedRow(t, r.resource.id)).model_ids_json), [OTHER, MODEL]);
});

test('heartbeat: the 32 x 128-character bound is accepted in full', async () => {
  const t = await createTestEnv();
  const r = await ready(t);
  const ids = Array.from({ length: 32 }, (_, i) => String(i).padStart(3, '0') + 'x'.repeat(125));
  assert.ok(ids.every((id) => id.length === 128));
  const out = await readJson(await beatWith(t, r.hb, r.resource.id, ids));
  assert.equal(out.status, 200, out.text);
  assert.equal(JSON.parse((await storedRow(t, r.resource.id)).model_ids_json).length, 32);
});

// --------------------------------------------------- malformed list refusal

test('heartbeat: malformed model lists are 400 and store nothing', async () => {
  const t = await createTestEnv();
  const r = await ready(t);
  const cases = [
    ['null models', null],
    ['array models', []],
    ['string models', 'ganglion'],
    ['missing model_ids', { runtime_id: 'ganglion' }],
    ['missing runtime_id', { model_ids: [MODEL] }],
    ['extra key', { runtime_id: 'ganglion', model_ids: [MODEL], extra: 1 }],
    ['unknown runtime', { runtime_id: 'llama-cpp', model_ids: [MODEL] }],
    ['non-string runtime', { runtime_id: 7, model_ids: [MODEL] }],
    ['empty list', { runtime_id: 'ganglion', model_ids: [] }],
    ['33 ids', { runtime_id: 'ganglion', model_ids: Array.from({ length: 33 }, (_, i) => `m${i}`) }],
    ['129-char id', { runtime_id: 'ganglion', model_ids: ['m'.repeat(129)] }],
    ['empty id', { runtime_id: 'ganglion', model_ids: [''] }],
    ['non-string id', { runtime_id: 'ganglion', model_ids: [42] }],
    ['control char id', { runtime_id: 'ganglion', model_ids: ['a\u0001b'] }],
    ['surrounding whitespace id', { runtime_id: 'ganglion', model_ids: [' m '] }],
    ['models not an array', { runtime_id: 'ganglion', model_ids: MODEL }],
  ];
  for (const [label, value] of cases) {
    const out = await readJson(await beat(t, r.hb, r.resource.id, { usable: true, models: value }));
    assert.equal(out.status, 400, `${label}: ${out.text}`);
    assert.equal(out.json.code, 'BAD_HEARTBEAT', label);
    const row = await t.DB.prepare('SELECT heartbeat_at FROM resources WHERE id = ?').bind(r.resource.id).first();
    assert.equal(row.heartbeat_at, null, `${label}: a refused body writes nothing`);
  }
  assert.equal(await storedRow(t, r.resource.id), null, 'nothing was stored');
});

test('heartbeat: unknown top-level fields are still refused alongside models', async () => {
  const t = await createTestEnv();
  const r = await ready(t);
  const out = await readJson(await beat(t, r.hb, r.resource.id, {
    usable: true, models: models(), heartbeat_at: new Date().toISOString(),
  }));
  assert.equal(out.status, 400);
  assert.equal(out.json.code, 'BAD_HEARTBEAT');
  // usable is still mandatory.
  const missing = await readJson(await beat(t, r.hb, r.resource.id, { models: models() }));
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 'BAD_HEARTBEAT');
});

test('heartbeat: the 1 KiB cap still applies to a body without models', async () => {
  const t = await createTestEnv();
  const r = await ready(t);
  const big = await readJson(await beat(t, r.hb, r.resource.id, { usable: true, pad: 'x'.repeat(2048) }));
  assert.equal(big.status, 413);
  assert.equal(big.json.code, 'BODY_TOO_LARGE');
  // Over the larger models cap is still refused.
  const huge = await readJson(await beatWith(t, r.hb, r.resource.id,
    Array.from({ length: 32 }, () => 'y'.repeat(400))));
  assert.equal(huge.status, 413);
  assert.equal(huge.json.code, 'BODY_TOO_LARGE');
});

// ------------------------------------------------------- admission refusal

test('admission: a fresh list containing the model is accepted and reported', async () => {
  const t = await createTestEnv(ENABLED);
  const store = useStore(t);
  const r = await ready(t);
  assert.equal((await readJson(await beatWith(t, r.hb, r.resource.id, [MODEL]))).status, 200);

  const out = await admit(t, t.alice, { resource_id: r.resource.id, model_id: MODEL });
  assert.equal(out.status, 201, out.text);
  assert.equal(out.json.model_advertised, true);
  assert.equal(Object.keys(store.state.admissions).length, 1);
});

test('admission: a fresh list lacking the model is 409 MODEL_NOT_ADVERTISED and mints nothing', async () => {
  const t = await createTestEnv(ENABLED);
  const store = useStore(t);
  const r = await ready(t);
  assert.equal((await readJson(await beatWith(t, r.hb, r.resource.id, [OTHER]))).status, 200);

  const out = await admit(t, t.alice, { resource_id: r.resource.id, model_id: MODEL });
  assert.equal(out.status, 409, out.text);
  assert.equal(out.json.code, 'MODEL_NOT_ADVERTISED');
  assert.deepEqual(store.state.admissions, {}, 'refused before the store');
});

test('admission: a resource that never advertised keeps today\'s behaviour', async () => {
  const t = await createTestEnv(ENABLED);
  const store = useStore(t);
  const r = await ready(t);
  assert.equal((await readJson(await beat(t, r.hb, r.resource.id, { usable: true }))).status, 200);

  const out = await admit(t, t.alice, { resource_id: r.resource.id, model_id: MODEL });
  assert.equal(out.status, 201, out.text);
  assert.equal(out.json.model_advertised, false);
  assert.equal(Object.keys(store.state.admissions).length, 1, 'older workers keep working');
});

test('admission: an aged advertisement is not authority', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t);
  assert.equal((await readJson(await beatWith(t, r.hb, r.resource.id, [OTHER]))).status, 200);
  // Keep the resource reachable but let the advertised list age past the
  // reachable window: the list no longer vouches for anything.
  await t.DB.prepare('UPDATE resource_models SET observed_at = ? WHERE resource_id = ?')
    .bind(new Date(Date.now() - STALE_MS - 60_000).toISOString(), r.resource.id).run();

  const out = await admit(t, t.alice, { resource_id: r.resource.id, model_id: MODEL });
  assert.equal(out.status, 201, out.text);
  assert.equal(out.json.model_advertised, false);
});

test('admission: an unparseable stored row is treated as absent, never as "no models"', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t);
  assert.equal((await readJson(await beatWith(t, r.hb, r.resource.id, [OTHER]))).status, 200);
  await t.DB.prepare('UPDATE resource_models SET model_ids_json = ? WHERE resource_id = ?')
    .bind('not json', r.resource.id).run();

  const out = await admit(t, t.alice, { resource_id: r.resource.id, model_id: MODEL });
  assert.equal(out.status, 201, out.text);
  assert.equal(out.json.model_advertised, false);
});

test('a stale-heartbeat refusal takes precedence over the model check', async () => {
  const t = await createTestEnv(ENABLED);
  useStore(t);
  const r = await ready(t);
  assert.equal((await readJson(await beatWith(t, r.hb, r.resource.id, [OTHER]))).status, 200);
  await backdateHeartbeat(t, r.resource.id, STALE_MS + 60_000);
  const out = await admit(t, t.alice, { resource_id: r.resource.id, model_id: MODEL });
  assert.equal(out.status, 409);
  assert.equal(out.json.code, 'RESOURCE_STALE');
});

// ------------------------------------------------------------- teardown

test('deleting a resource removes its advertised inventory (0025 FK)', async () => {
  const t = await createTestEnv();
  const r = await ready(t);
  assert.equal((await readJson(await beatWith(t, r.hb, r.resource.id, [MODEL]))).status, 200);
  assert.ok(await storedRow(t, r.resource.id));

  const out = await readJson(await t.call(`/api/inventory/${r.resource.id}`, {
    method: 'DELETE', headers: S(t, t.alice),
  }));
  assert.equal(out.status, 200, out.text);
  assert.equal(await storedRow(t, r.resource.id), null, 'inventory row removed with the resource');
});

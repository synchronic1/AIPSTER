/* Built with Meta Muse. */
// Compatibility evaluation (Phase 1): AC02 (tenant isolation), AC05 (full
// budget blocks despite weight fit), AC06 (no combined VRAM), AC07 (stale/
// missing/revoked), AC08 (LoRA binding), AC09 (invalidation + cache).
// Fixture metadata + synthetic snapshots; no network, no inference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { fixtureSnapshot, fixtureSmallSnapshot } from '../src/lib/catalog/fixtures.mjs';
import { evaluateCompatibility } from '../src/lib/catalog/estimate.mjs';
import { budgetWindow } from '../src/lib/quotas.js';
import { __resetHubMetaCache } from '../src/lib/catalog/hub.mjs';

const fx = () => createTestEnv({ CATALOG_FIXTURES: '1' });
const BASE = 'fixture-org/tiny-base';
const GGUF = 'fixture-org/tiny-instruct-gguf';
const LORA = 'fixture-org/tiny-lora';

async function register(t, user, name) {
  const res = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: { ...t.as(user), ...t.csrf }, body: { name, kind: 'local' },
  }));
  assert.equal(res.status, 201, res.text);
  return res.json;
}

async function report(t, nodeId, snapshot, ageMs = 1000) {
  const reportedAt = new Date(Date.now() - ageMs).toISOString();
  await t.DB.prepare('INSERT INTO node_capabilities (node_id, schema_version, reported_at, os, arch, runtimes_json, mem_json, disk_json, workload_json) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)')
    .bind(nodeId, reportedAt, snapshot.os, snapshot.arch, JSON.stringify(snapshot.runtimes), JSON.stringify(snapshot.mem), JSON.stringify(snapshot.disk), JSON.stringify(snapshot.workload))
    .run();
}

async function evaluate(t, user, body) {
  return readJson(await t.call('/api/catalog/compat', { method: 'POST', headers: { ...t.as(user), ...t.csrf }, body }));
}

async function grant(t, resourceId, granteeEmail) {
  const res = await readJson(await t.call('/api/grants', {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf },
    body: { resourceId, grantee: granteeEmail, maxJobs: 5, maxTokens: 1000 },
  }));
  assert.equal(res.status, 201, res.text);
  return res.json;
}

test('AC05: weights fit but full-context budget blocks with a breakdown', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'small-box');
  await report(t, node.id, fixtureSmallSnapshot());
  const res = await evaluate(t, t.alice, { repo: BASE, nodeId: node.id, runtime: 'fixture-llama', context: 8192, concurrency: 1 });
  assert.equal(res.status, 200, res.text);
  // safetensors base on a gguf-only matrix row blocks on format first; use
  // the GGUF at a context whose KV alone overflows the small node instead.
  assert.equal(res.json.state, 'blocked');
  const codes = res.json.blocking.map((r) => r.code);
  assert.ok(codes.includes('FORMAT_UNSUPPORTED'), JSON.stringify(codes));
  const big = await evaluate(t, t.alice, { repo: GGUF, nodeId: node.id, runtime: 'fixture-llama', context: 8192, concurrency: 2 });
  assert.equal(big.status, 200, big.text);
  assert.equal(big.json.state, 'blocked');
  assert.ok(big.json.blocking.some((r) => r.code === 'INSUFFICIENT_VRAM'), JSON.stringify(big.json.blocking));
  assert.ok(big.json.estimate.totalBytes > big.json.estimate.weightsBytes, 'total exceeds weights: KV + buffers + workspace + reserve');
  assert.ok(big.json.estimate.weightsBytes < 6442450944, 'weights alone fit the small VRAM');
  assert.ok(big.json.estimate.method && big.json.estimate.uncertainty, 'method + uncertainty ship with the estimate');
});

test('estimated-compatible on a fitting node; validated is never returned', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const res = await evaluate(t, t.alice, { repo: GGUF, nodeId: node.id, runtime: 'fixture-llama', context: 2048, concurrency: 1 });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.state, 'estimated-compatible');
  assert.equal(res.json.cached, false);
  assert.ok(res.json.estimate && res.json.estimate.totalBytes > 0);
  const again = await evaluate(t, t.alice, { repo: GGUF, nodeId: node.id, runtime: 'fixture-llama', context: 2048, concurrency: 1 });
  assert.equal(again.json.cached, true, 'identical input replays the cached decision');
  assert.ok(!['validated'].includes(res.json.state), 'no recorded qualification exists in Phase 1');
});

test('Codex-P2: a cached decision never outlives its telemetry freshness', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot(), 298_000); // 2s inside the 5-min window
  const body = { repo: GGUF, nodeId: node.id, runtime: 'fixture-llama', context: 2048, concurrency: 1 };
  const first = await evaluate(t, t.alice, body);
  assert.equal(first.json.state, 'estimated-compatible', first.text);
  assert.equal(first.json.cached, false);
  await new Promise((r) => setTimeout(r, 3000)); // telemetry crosses stale; cache TTL has not
  const second = await evaluate(t, t.alice, body);
  assert.equal(second.json.state, 'unknown', second.text);
  assert.equal(second.json.cached, false, 'stale telemetry misses the cache');
});

test('R2: spent budget blocks uncached Hub resolution before any fetch', async () => {
  const t = await createTestEnv({});
  __resetHubMetaCache();
  const node = await register(t, t.alice, 'r2-node');
  await t.DB.prepare('INSERT OR REPLACE INTO write_budget (user_id, window, count) VALUES (?, ?, ?)')
    .bind('u_alice', budgetWindow(), 120).run();
  const realFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    assert.equal(url.hostname, 'huggingface.co', 'all network is mocked; unexpected destinations are refused');
    upstreamCalls += 1;
    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    for (let i = 0; i < 3; i += 1) {
      const r = await evaluate(t, t.alice, { repo: `r2-missing/model-${i}`, nodeId: node.id, runtime: 'llama', context: 2048, concurrency: 1 });
      assert.equal(r.status, 429, r.text);
      assert.equal(r.json.code, 'WRITE_RATE_LIMITED');
    }
    assert.equal(upstreamCalls, 0, 'fresh names fetch nothing on a spent budget');
  } finally {
    globalThis.fetch = realFetch;
    __resetHubMetaCache();
  }
});

test('R2: admitted Hub metadata serves later lookups without new fetches or claims', async () => {
  const t = await createTestEnv({});
  __resetHubMetaCache();
  const node = await register(t, t.alice, 'r2-cached');
  await report(t, node.id, fixtureSnapshot());
  const realFetch = globalThis.fetch;
  let upstreamCalls = 0;
  const model = { id: 'r2-org/model-a', sha: 'b'.repeat(40), tags: [], siblings: [], likes: 3 };
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    assert.equal(url.hostname, 'huggingface.co', 'all network is mocked; unexpected destinations are refused');
    upstreamCalls += 1;
    return new Response(JSON.stringify(model), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const spent = async () => t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind('u_alice', budgetWindow()).first('count');
  try {
    const body = { repo: 'r2-org/model-a', nodeId: node.id, runtime: 'fixture-llama', context: 2048, concurrency: 1 };
    const c0 = await spent();
    const first = await evaluate(t, t.alice, body);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.cached, false);
    assert.equal(upstreamCalls, 1, 'first lookup fetches once');
    const c1 = await spent();
    assert.equal(c1, c0 + 2, 'first lookup admits the Hub fetch and the compat-cache write');
    const second = await evaluate(t, t.alice, body);
    assert.equal(second.status, 200, second.text);
    assert.equal(second.json.cached, true, 'identical input replays the cached decision');
    assert.equal(upstreamCalls, 1, 'Hub metadata is not re-fetched');
    assert.equal(await spent(), c1, 'cached reads claim nothing');
    const third = await evaluate(t, t.alice, { ...body, context: 4096 });
    assert.equal(third.status, 200, third.text);
    assert.equal(third.json.cached, false, 'changed input misses the compat cache');
    assert.equal(upstreamCalls, 1, 'Hub-cache hit needs no outbound fetch');
    assert.equal(await spent(), c1 + 1, 'only the compat-cache write is metered on a Hub hit');
  } finally {
    globalThis.fetch = realFetch;
    __resetHubMetaCache();
  }
});

test('AC06: two nodes never combine; evaluation uses exactly the named node', async () => {
  const t = await fx();
  const small = await register(t, t.alice, 'small');
  const big = await register(t, t.alice, 'big');
  await report(t, small.id, fixtureSmallSnapshot());
  await report(t, big.id, fixtureSnapshot());
  const res = await evaluate(t, t.alice, { repo: GGUF, nodeId: small.id, runtime: 'fixture-llama', context: 8192, concurrency: 2 });
  assert.equal(res.json.state, 'blocked', 'the big node contributes nothing to the small evaluation');
  assert.equal(res.json.nodeId, small.id);
  const ok = await evaluate(t, t.alice, { repo: GGUF, nodeId: big.id, runtime: 'fixture-llama', context: 2048, concurrency: 1 });
  assert.equal(ok.json.state, 'estimated-compatible');
});

test('AC07: missing/stale snapshots are unknown; revoked access denies', async () => {
  const t = await fx();
  const bare = await register(t, t.alice, 'bare');
  const missing = await evaluate(t, t.alice, { repo: GGUF, nodeId: bare.id, runtime: 'fixture-llama', context: 1024, concurrency: 1 });
  assert.equal(missing.json.state, 'unknown');
  assert.ok(missing.json.unknown.some((r) => r.code === 'TELEMETRY_MISSING'));
  const stale = await register(t, t.alice, 'stale');
  await report(t, stale.id, fixtureSnapshot(), 3600 * 1000);
  const old = await evaluate(t, t.alice, { repo: GGUF, nodeId: stale.id, runtime: 'fixture-llama', context: 1024, concurrency: 1 });
  assert.equal(old.json.state, 'unknown');
  assert.ok(old.json.unknown.some((r) => r.code === 'TELEMETRY_STALE'));
  const g = await grant(t, bare.id, 'bob@example.com');
  await report(t, bare.id, fixtureSnapshot());
  const shared = await evaluate(t, t.bob, { repo: GGUF, nodeId: bare.id, runtime: 'fixture-llama', context: 1024, concurrency: 1 });
  assert.equal(shared.status, 200, 'live grant permits evaluation');
  await t.DB.prepare('UPDATE grants SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), g.id).run();
  const revoked = await evaluate(t, t.bob, { repo: GGUF, nodeId: bare.id, runtime: 'fixture-llama', context: 1024, concurrency: 1 });
  assert.equal(revoked.status, 404, 'revoked grant denies even with a cached decision underneath');
});

test('AC02: cross-tenant nodes are invisible without a grant', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'alice-box');
  await report(t, node.id, fixtureSnapshot());
  const cross = await evaluate(t, t.bob, { repo: GGUF, nodeId: node.id, runtime: 'fixture-llama', context: 1024, concurrency: 1 });
  assert.equal(cross.status, 404);
  assert.equal(cross.json.code, 'NOT_FOUND');
  await grant(t, node.id, 'bob@example.com');
  const allowed = await evaluate(t, t.bob, { repo: GGUF, nodeId: node.id, runtime: 'fixture-llama', context: 1024, concurrency: 1 });
  assert.equal(allowed.status, 200, allowed.text);
  assert.equal(allowed.json.cached, false, 'cache is principal-aware: no hit on alice’s entry');
});

test('AC08: LoRA binding is exact or it fails closed', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'box');
  await report(t, node.id, fixtureSnapshot());
  const headers = { ...t.as(t.alice), ...t.csrf };
  const noBase = await readJson(await t.call('/api/catalog/compat', { method: 'POST', headers, body: { repo: LORA, adapterRepo: LORA, nodeId: node.id, runtime: 'fixture-llama', context: 1024, concurrency: 1 } }));
  assert.equal(noBase.status, 400);
  assert.equal(noBase.json.code, 'ADAPTER_BASE_REQUIRED');
  // Correct binding, but the fixture runtime has no tested adapter path.
  const untested = await evaluate(t, t.alice, { repo: LORA, adapterRepo: LORA, baseRepo: BASE, nodeId: node.id, runtime: 'fixture-llama', context: 1024, concurrency: 1 });
  assert.equal(untested.json.state, 'blocked');
  assert.ok(untested.json.blocking.some((r) => r.code === 'ADAPTER_RUNTIME_UNSUPPORTED'), JSON.stringify(untested.json.blocking));
  // Wrong base revision: mismatch + tokenizer mismatch, never green.
  const wrong = await evaluate(t, t.alice, { repo: LORA, adapterRepo: LORA, baseRepo: GGUF, nodeId: node.id, runtime: 'fixture-llama', context: 1024, concurrency: 1 });
  assert.equal(wrong.json.cached, false, 'changed base misses the other-base cache entry');
  assert.equal(wrong.json.state, 'blocked');
  const codes = wrong.json.blocking.map((r) => r.code);
  assert.ok(codes.includes('ADAPTER_BASE_MISMATCH'), JSON.stringify(codes));
  assert.ok(codes.includes('ADAPTER_TOKENIZER_MISMATCH'), JSON.stringify(codes));
  // Missing adapter metadata evaluates unknown, never blocked-or-green.
  const dec = evaluateCompatibility({
    asset: { id: 'hub:x/y', revision: 'a'.repeat(40), format: 'gguf', quant: 'unknown', totalBytes: 100 },
    adapterAsset: { id: 'hub:x/z', revision: 'b'.repeat(40), totalBytes: 10 },
    baseAsset: null,
    settings: { context: 128, concurrency: 1, runtime: 'fixture-llama' },
    snapshot: fixtureSnapshot(), snapshotAgeMs: 1000, snapshotAt: new Date().toISOString(),
    nodeId: 'r_x', principal: 'u_x', nowMs: Date.now(),
  });
  assert.equal(dec.state, 'unknown');
  assert.ok(dec.unknown.some((r) => r.code === 'ADAPTER_BASE_UNKNOWN') || dec.unknown.some((r) => r.code === 'ADAPTER_METADATA_UNKNOWN'));
});

test('AC09: changed inputs invalidate; cache carries the full fingerprint', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'box');
  await report(t, node.id, fixtureSnapshot());
  const base = { repo: GGUF, nodeId: node.id, runtime: 'fixture-llama', context: 2048, concurrency: 1 };
  const first = await evaluate(t, t.alice, base);
  assert.equal(first.json.cached, false);
  const row = await t.DB.prepare('SELECT fingerprint_json FROM catalog_compat_cache').bind().first();
  const fp = JSON.parse(row.fingerprint_json);
  assert.equal(fp.context, 2048);
  assert.ok(fp.asset.includes(GGUF) && fp.node === node.id && fp.runtime === 'fixture-llama');
  const changed = await evaluate(t, t.alice, { ...base, context: 4096 });
  assert.equal(changed.json.cached, false, 'changed context misses the cache');
  assert.notDeepEqual(changed.json.fingerprint, first.json.fingerprint);
  const rerun = await evaluate(t, t.alice, { ...base, context: 4096 });
  assert.equal(rerun.json.cached, true);
});

test('compat auth and input boundaries', async () => {
  const t = await fx();
  const anon = await readJson(await t.call('/api/catalog/compat', { method: 'POST', body: {} }));
  assert.equal(anon.status, 401);
  const node = await register(t, t.alice, 'box');
  const good = { repo: GGUF, nodeId: node.id, runtime: 'fixture-llama', context: 1024, concurrency: 1 };
  const noCsrf = await readJson(await t.call('/api/catalog/compat', { method: 'POST', headers: t.as(t.alice), body: good }));
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.code, 'CSRF_REQUIRED');
  const headers = { ...t.as(t.alice), ...t.csrf };
  for (const [patch, code] of [
    [{ repo: 'nope' }, 'BAD_REPO'], [{ nodeId: '!!!' }, 'BAD_NODE'], [{ runtime: '' }, 'BAD_RUNTIME'],
    [{ context: 0 }, 'BAD_SETTINGS'], [{ context: 1048577 }, 'BAD_SETTINGS'], [{ concurrency: 0 }, 'BAD_SETTINGS'],
    [{ adapterRepo: 'nope' }, 'BAD_REPO'],
  ]) {
    const r = await readJson(await t.call('/api/catalog/compat', { method: 'POST', headers, body: { ...good, ...patch } }));
    assert.equal(r.status, 400, JSON.stringify(patch));
    assert.equal(r.json.code, code, JSON.stringify(patch));
  }
  const ghost = await readJson(await t.call('/api/catalog/compat', { method: 'POST', headers, body: { ...good, repo: 'fixture-org/nope' } }));
  assert.equal(ghost.status, 404);
});

test('S-F12: compat writes prune expired rows and cap per-principal growth', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const past = new Date(Date.now() - 3600000).toISOString();
  await t.DB.prepare('INSERT INTO catalog_compat_cache (cache_key, principal, fingerprint_json, decision_json, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind('expired-1', 'u_alice', '{}', '{}', past).run();
  const future = new Date(Date.now() + 300000).toISOString();
  for (let i = 0; i < 205; i += 1) {
    await t.DB.prepare('INSERT INTO catalog_compat_cache (cache_key, principal, fingerprint_json, decision_json, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(`fresh-${i}`, 'u_alice', '{}', '{}', future).run();
  }
  const res = await evaluate(t, t.alice, { repo: GGUF, nodeId: node.id, runtime: 'fixture-llama', context: 2048, concurrency: 1 });
  assert.equal(res.status, 200, res.text);
  const rows = await t.DB.prepare('SELECT cache_key FROM catalog_compat_cache WHERE principal = ?').bind('u_alice').all();
  assert.ok(rows.results.length <= 200, `cache capped, got ${rows.results.length}`);
  assert.ok(!rows.results.some((r) => r.cache_key === 'expired-1'), 'expired row pruned');
});

test('Codex-P2: a runtime the node does not report never estimates compatible (route)', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'bare-box');
  await report(t, node.id, fixtureSnapshot({ runtimes: [] }));
  const res = await evaluate(t, t.alice, { repo: GGUF, nodeId: node.id, runtime: 'fixture-llama', context: 2048, concurrency: 1 });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.state, 'blocked', JSON.stringify(res.json));
  assert.ok(res.json.blocking.some((r) => r.code === 'RUNTIME_NOT_REPORTED'), JSON.stringify(res.json.blocking));
});

test('Codex-P2: node-reported format, quant, and context restrictions bind the estimate (unit)', async () => {
  const snap = fixtureSnapshot({
    runtimes: [{ name: 'fixture-llama', version: '0.1.0', formats: ['safetensors'], quants: ['Q8_0'], maxContext: 1024, adapters: [] }],
  });
  const dec = evaluateCompatibility({
    asset: { id: GGUF, revision: 'a'.repeat(40), format: 'gguf', quant: 'Q4_K_M', totalBytes: 1024 },
    settings: { context: 2048, concurrency: 1, runtime: 'fixture-llama' },
    snapshot: snap, snapshotAgeMs: 1000, snapshotAt: new Date().toISOString(),
    nodeId: 'n_x', principal: 'u_x', nowMs: Date.now(),
  });
  assert.equal(dec.state, 'blocked', JSON.stringify(dec.blocking || dec.unknown));
  const codes = dec.blocking.map((r) => r.code);
  assert.ok(codes.includes('FORMAT_NOT_REPORTED'), JSON.stringify(codes));
  assert.ok(codes.includes('QUANT_NOT_REPORTED'), JSON.stringify(codes));
  assert.ok(codes.includes('CONTEXT_EXCEEDS_NODE'), JSON.stringify(codes));
});
test('Codex-sec-P2: spent write budgets reject compat misses but serve hits', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'box');
  await report(t, node.id, fixtureSnapshot());
  const body = { repo: GGUF, nodeId: node.id, runtime: 'fixture-llama', context: 2048, concurrency: 1 };
  const first = await evaluate(t, t.alice, body);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.cached, false);
  await t.DB.prepare('INSERT OR REPLACE INTO write_budget (user_id, window, count) VALUES (?, ?, ?)')
    .bind('u_alice', budgetWindow(), 120).run();
  const hit = await evaluate(t, t.alice, body);
  assert.equal(hit.status, 200, hit.text);
  assert.equal(hit.json.cached, true, 'hits stay read-only on a spent budget');
  const miss = await evaluate(t, t.alice, { ...body, context: 4096 });
  assert.equal(miss.status, 429, miss.text);
  assert.equal(miss.json.code, 'WRITE_RATE_LIMITED');
  const rows = await t.DB.prepare('SELECT COUNT(*) AS n FROM catalog_compat_cache WHERE principal = ?').bind('u_alice').first('n');
  assert.equal(rows, 1, 'the rejected miss wrote no cache row');
});

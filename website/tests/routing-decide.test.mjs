/* Built with Meta Muse. */
// Latency-first routing, Milestone C: durable op ledger, atomic capacity
// reservation/release, bounded advice cache, and the decideRoute
// orchestrator. Dispatch stays disabled: every outcome carries
// executable:false until a qualified transport exists (Milestone E gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { claimRequest, finalizeDecision, getOpByRequest, expireOps } from '../src/routing/ledger.mjs';
import { reserveCapacity, releaseCapacity, sweepReservations, reserveCascade } from '../src/routing/capacity.mjs';
import { putCached, getCached, sweepCache, cacheKeyFor } from '../src/routing/cache.mjs';
import { decideRoute } from '../src/routing/decide.mjs';

const NOW = 1760000000000;
const ENV = {
  ROUTING_ADVICE_ENABLED: '1',
  ROUTING_ADVICE_ALLOWANCE_MS: '2000',
  ROUTING_ADVICE_PER_HOUR: '100',
  ROUTING_ADVICE_GLOBAL_PER_HOUR: '1000',
};

async function seed(t) {
  const now = new Date(NOW).toISOString();
  const rows = [
    ['r1', 'u_alice', '["text-generation"]'],
    ['r2', 'u_alice', '["text-generation"]'],
    ['rb', 'u_bob', '["text-generation","fast-path"]'],
    ['rc', 'u_bob', '["text-generation"]'],
  ];
  for (const [id, owner, caps] of rows) {
    await t.DB.prepare('INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated, online, usable, heartbeat_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, owner, `Box ${id}`, 'local', 'rack', 'cpu', '', caps, 1, 1, 1, 1, now, new Date().toISOString()).run();
  }
  const g = async (id, res, maxJ, maxT, usedJ, usedT, revoked) => t.DB.prepare(
    'INSERT INTO grants (id, resource_id, owner_id, grantee_id, max_jobs, max_tokens, used_jobs, used_tokens, inference_only, created_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, res, 'u_bob', 'u_alice', maxJ, maxT, usedJ, usedT, 1, new Date().toISOString(), revoked).run();
  await g('g_rb', 'rb', 10, 50000, 0, 0, null);
  await g('g_rc', 'rc', 1, 100, 0, 0, null);
}

function rankResponse(rankedIds) {
  return {
    id: 'resp_rank', model: 'muse-spark-1.3',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ version: 'route-rank/v1', rankedIds, reasonCodes: ['load'], note: 'ok' }) }] }],
    usage: { input_tokens: 100, output_tokens: 30 },
  };
}

test('routing ledger: claim, finalize, replay, steal, expiry', async () => {
  const t = await createTestEnv({});
  const c1 = await claimRequest(t.DB, { opId: 'op_1', tenant: 'u_alice', requestId: 'req_1', nowMs: NOW });
  assert.equal(c1.outcome, 'leader');
  await assert.rejects(claimRequest(t.DB, { opId: 'op_2', tenant: 'u_alice', requestId: 'req_1', nowMs: NOW }), (e) => e.code === 'ROUTE_OP_IN_FLIGHT');
  const fin = await finalizeDecision(t.DB, { opId: 'op_1', tenant: 'u_alice', requestId: 'req_1', ranking: ['r1'], source: 'fallback', digests: { featureDigest: 'f', candidateDigest: 'c' }, nowMs: NOW });
  assert.equal(fin.state, 'admitted');
  const replay = await claimRequest(t.DB, { opId: 'op_3', tenant: 'u_alice', requestId: 'req_1', nowMs: NOW });
  assert.equal(replay.outcome, 'replay');
  assert.equal(replay.op.id, 'op_1');
  assert.deepEqual(JSON.parse(replay.op.ranking_json).ranking, ['r1']);
  assert.equal(await getOpByRequest(t.DB, 'u_bob', 'req_1'), null);
  await claimRequest(t.DB, { opId: 'op_4', tenant: 'u_alice', requestId: 'req_2', nowMs: NOW });
  const steal = await claimRequest(t.DB, { opId: 'op_5', tenant: 'u_alice', requestId: 'req_2', nowMs: NOW + 61000 });
  assert.equal(steal.outcome, 'leader');
  assert.equal(steal.op.id, 'op_5');
  assert.equal(await expireOps(t.DB, NOW + 3600 * 1000 + 1), 2);
});

test('routing capacity: reserve, overdraw, revoke, release, double-release', async () => {
  const t = await createTestEnv({});
  await seed(t);
  const used = async () => ({ ...(await t.DB.prepare('SELECT used_jobs, used_tokens FROM grants WHERE id = ?').bind('g_rc').first()) });
  const r = await reserveCapacity(t.DB, { opId: 'op_r', tenant: 'u_alice', grantId: 'g_rc', jobs: 1, tokens: 100, nowMs: NOW });
  assert.equal(r.state, 'held');
  assert.deepEqual(await used(), { used_jobs: 1, used_tokens: 100 });
  await assert.rejects(reserveCapacity(t.DB, { opId: 'op_r2', tenant: 'u_alice', grantId: 'g_rc', jobs: 1, tokens: 1, nowMs: NOW }), (e) => e.code === 'ROUTE_CAPACITY_EXHAUSTED');
  assert.deepEqual(await used(), { used_jobs: 1, used_tokens: 100 });
  await t.DB.prepare("UPDATE grants SET revoked_at = ? WHERE id = 'g_rc'").bind(new Date().toISOString()).run();
  await assert.rejects(reserveCapacity(t.DB, { opId: 'op_r3', tenant: 'u_alice', grantId: 'g_rc', jobs: 1, tokens: 1, nowMs: NOW }), (e) => e.code === 'ROUTE_CAPACITY_REVOKED');
  await releaseCapacity(t.DB, { opId: 'op_r', reason: 'cancel' });
  assert.deepEqual(await used(), { used_jobs: 0, used_tokens: 0 });
  await releaseCapacity(t.DB, { opId: 'op_r', reason: 'cancel' });
  assert.deepEqual(await used(), { used_jobs: 0, used_tokens: 0 });
  await releaseCapacity(t.DB, { opId: 'op_missing', reason: 'cancel' });
});

test('routing capacity: concurrent racers cannot overdraw', async () => {
  const t = await createTestEnv({});
  await seed(t);
  const mk = (opId) => reserveCapacity(t.DB, { opId, tenant: 'u_alice', grantId: 'g_rc', jobs: 1, tokens: 100, nowMs: NOW });
  const rs = await Promise.allSettled([mk('op_c1'), mk('op_c2'), mk('op_c3')]);
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(rs.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'ROUTE_CAPACITY_EXHAUSTED'));
  const u = { ...(await t.DB.prepare('SELECT used_jobs, used_tokens FROM grants WHERE id = ?').bind('g_rc').first()) };
  assert.deepEqual(u, { used_jobs: 1, used_tokens: 100 });
  assert.equal(await sweepReservations(t.DB, NOW + 3600 * 1000), 1);
  const u2 = { ...(await t.DB.prepare('SELECT used_jobs, used_tokens FROM grants WHERE id = ?').bind('g_rc').first()) };
  assert.deepEqual(u2, { used_jobs: 0, used_tokens: 0 });
});

test('routing cache: hit, miss, ttl, cap, isolation, sweep', async () => {
  const t = await createTestEnv({});
  const key = cacheKeyFor('u_alice', 'f1', 'c1', 'route/v1', 'standard');
  assert.equal(await getCached(t.DB, key, NOW), null);
  await putCached(t.DB, { key, tenant: 'u_alice', response: { rankedIds: ['r2'] }, ttlMs: 60000, nowMs: NOW });
  assert.deepEqual((await getCached(t.DB, key, NOW + 1000)).response, { rankedIds: ['r2'] });
  assert.equal((await getCached(t.DB, key, NOW + 1000)).stale, false);
  assert.equal(await getCached(t.DB, key, NOW + 61000), null);
  assert.equal((await getCached(t.DB, key, NOW + 61000, { allowStale: true })).stale, true);
  assert.equal(await getCached(t.DB, key, NOW + 3600 * 1000, { allowStale: true }), null);
  // Tenant isolation: same digests, other tenant, no read.
  const bobKey = cacheKeyFor('u_bob', 'f1', 'c1', 'route/v1', 'standard');
  assert.notEqual(bobKey, key);
  assert.equal(await getCached(t.DB, bobKey, NOW + 1000), null);
  // Per-tenant cap evicts oldest first.
  for (let i = 0; i < 5; i++) {
    await putCached(t.DB, { key: `u_alice|k${i}`, tenant: 'u_alice', response: { i }, ttlMs: 60000, capPerTenant: 3, nowMs: NOW + i });
  }
  const n = await t.DB.prepare('SELECT COUNT(*) n FROM routing_advice_cache WHERE tenant_id = ?').bind('u_alice').first();
  assert.equal(Number(n.n), 3);
  assert.equal(await sweepCache(t.DB, NOW + 3600 * 1000), 3);
});

test('routing decide: advice path reserves the top granted pick', async () => {
  const t = await createTestEnv(ENV);
  await seed(t);
  const fetchImpl = async () => new Response(JSON.stringify(rankResponse(['r3', 'r1', 'r2'])), { status: 200 });
  const out = await decideRoute({ db: t.DB, env: t.env, tenant: 'u_alice', features: { model: 'fast-path', maxTokens: 500 }, fetchImpl, nowMs: NOW });
  assert.equal(out.source, 'advice');
  assert.deepEqual(out.ranking, ['r3', 'r1', 'r2']);
  assert.equal(out.route.resourceId, 'rb');
  assert.equal(out.route.reservation.state, 'held');
  assert.equal(out.executable, false);
  assert.equal(out.dispatchDisabled, true);
  const u = { ...(await t.DB.prepare('SELECT used_jobs, used_tokens FROM grants WHERE id = ?').bind('g_rb').first()) };
  assert.deepEqual(u, { used_jobs: 1, used_tokens: 500 });
  // Idempotent replay by caller request id: no second reservation, no call.
  let calls = 0;
  const again = await decideRoute({ db: t.DB, env: t.env, tenant: 'u_alice', features: { model: 'fast-path', maxTokens: 500, requestId: out.receipt.requestId }, fetchImpl: async () => { calls += 1; throw new Error('must not call'); }, nowMs: NOW });
  assert.equal(again.replay, true);
  assert.equal(calls, 0);
  const u2 = { ...(await t.DB.prepare('SELECT used_jobs, used_tokens FROM grants WHERE id = ?').bind('g_rb').first()) };
  assert.deepEqual(u2, { used_jobs: 1, used_tokens: 500 });
});

test('routing decide: cached, fallback, degraded-stale, and empty paths', async () => {
  // Cached: second identical decision makes no provider call.
  {
    const t = await createTestEnv(ENV);
    await seed(t);
    const ok = async () => new Response(JSON.stringify(rankResponse(['r2', 'r1'])), { status: 200 });
    const first = await decideRoute({ db: t.DB, env: t.env, tenant: 'u_alice', features: { model: 'm', kinds: ['local'] }, fetchImpl: ok, nowMs: NOW });
    assert.equal(first.source, 'advice');
    let calls = 0;
    const second = await decideRoute({ db: t.DB, env: t.env, tenant: 'u_alice', features: { model: 'm', kinds: ['local'] }, fetchImpl: async () => { calls += 1; throw new Error('must not call'); }, nowMs: NOW + 1000 });
    assert.equal(second.source, 'cached');
    assert.equal(calls, 0);
    assert.deepEqual(second.ranking, ['r2', 'r1', 'r3', 'r4']);
  }
  // Fallback: provider failure keeps the deterministic order.
  {
    const t = await createTestEnv(ENV);
    await seed(t);
    const out = await decideRoute({ db: t.DB, env: t.env, tenant: 'u_alice', features: { model: 'm' }, fetchImpl: async () => new Response('{}', { status: 500 }), nowMs: NOW });
    assert.equal(out.source, 'fallback');
    assert.equal(out.failure.code, 'ADVICE_UPSTREAM');
    assert.ok(out.ranking.length > 0);
    assert.equal(out.executable, false);
  }
  // Degraded-stale: failure plus servable stale cache plus flag.
  {
    const t = await createTestEnv({ ...ENV, ROUTING_ADVICE_SERVE_STALE: '1' });
    await seed(t);
    const ok = async () => new Response(JSON.stringify(rankResponse(['r2', 'r1'])), { status: 200 });
    await decideRoute({ db: t.DB, env: t.env, tenant: 'u_alice', features: { model: 'm', kinds: ['local'] }, fetchImpl: ok, nowMs: NOW });
    const stale = await decideRoute({ db: t.DB, env: t.env, tenant: 'u_alice', features: { model: 'm', kinds: ['local'] }, fetchImpl: async () => new Response('{}', { status: 500 }), nowMs: NOW + 61000 });
    assert.equal(stale.source, 'degraded-stale');
    assert.equal(stale.degraded, true);
    assert.deepEqual(stale.ranking, ['r2', 'r1', 'r3', 'r4']);
  }
  // Empty: no eligible candidates commits a rejection, no call.
  {
    const t = await createTestEnv(ENV);
    await seed(t);
    let calls = 0;
    const out = await decideRoute({ db: t.DB, env: t.env, tenant: 'u_alice', features: { model: 'm', kinds: ['cluster'] }, fetchImpl: async () => { calls += 1; throw new Error('must not call'); }, nowMs: NOW });
    assert.equal(out.source, 'none');
    assert.equal(out.failure.code, 'NO_CANDIDATES');
    assert.equal(calls, 0);
  }
});

test('routing capacity: concurrent releases refund exactly once, no row on reject', async () => {
  const t = await createTestEnv({});
  await seed(t);
  await reserveCapacity(t.DB, { opId: 'op_x1', tenant: 'u_alice', grantId: 'g_rb', jobs: 1, tokens: 100, nowMs: NOW });
  await reserveCapacity(t.DB, { opId: 'op_x2', tenant: 'u_alice', grantId: 'g_rb', jobs: 1, tokens: 100, nowMs: NOW });
  const [a, b] = await Promise.all([
    releaseCapacity(t.DB, { opId: 'op_x1' }),
    releaseCapacity(t.DB, { opId: 'op_x1' }),
  ]);
  assert.deepEqual([a, b].sort(), [0, 1]);
  const u = { ...(await t.DB.prepare('SELECT used_jobs, used_tokens FROM grants WHERE id = ?').bind('g_rb').first()) };
  assert.deepEqual(u, { used_jobs: 1, used_tokens: 100 });
  await assert.rejects(reserveCapacity(t.DB, { opId: 'op_x3', tenant: 'u_alice', grantId: 'g_rc', jobs: 99, tokens: 99, nowMs: NOW }), (e) => e.code === 'ROUTE_CAPACITY_EXHAUSTED');
  const rows = await t.DB.prepare('SELECT COUNT(*) n FROM routing_reservations WHERE op_id = ?').bind('op_x3').first();
  assert.equal(Number(rows.n), 0);
});

test('routing decide: concurrent same-request callers cause one provider call', async () => {
  const t = await createTestEnv(ENV);
  await seed(t);
  let release, park;
  const gate = new Promise((res) => { release = res; });
  const parked = new Promise((res) => { park = res; });
  let calls = 0;
  const fetchImpl = async () => { calls += 1; park(); await gate; return new Response(JSON.stringify(rankResponse(['r1', 'r2'])), { status: 200 }); };
  const feat = { model: 'm', kinds: ['local'], requestId: 'req_race' };
  const winner = decideRoute({ db: t.DB, env: t.env, tenant: 'u_alice', features: feat, fetchImpl, nowMs: NOW });
  await parked;
  const loser = await decideRoute({ db: t.DB, env: t.env, tenant: 'u_alice', features: feat, fetchImpl, nowMs: NOW });
  assert.equal(loser.failure.code, 'ROUTE_OP_IN_FLIGHT');
  assert.equal(loser.source, 'none');
  release();
  const won = await winner;
  assert.equal(won.source, 'advice');
  assert.equal(calls, 1);
  const replay = await decideRoute({ db: t.DB, env: t.env, tenant: 'u_alice', features: feat, fetchImpl, nowMs: NOW });
  assert.equal(replay.replay, true);
  assert.equal(calls, 1);
});

test('routing decide: live clock in production, scripted clock proves rechecks', async () => {
  // Production shape: no clock injected, real timestamps, fresh heartbeats.
  {
    const t = await createTestEnv(ENV);
    await seed(t);
    await t.DB.prepare('UPDATE resources SET heartbeat_at = ?').bind(new Date().toISOString()).run();
    const out = await decideRoute({ db: t.DB, env: t.env, tenant: 'u_alice', features: { model: 'm' }, fetchImpl: async () => new Response(JSON.stringify(rankResponse(['r1', 'r2'])), { status: 200 }) });
    assert.equal(out.source, 'advice');
    assert.equal(out.executable, false);
  }
  // Scripted clock: time jumps past the absolute deadline after eligibility,
  // so the orchestrator falls back without calling. Call positions: claim,
  // request, eligibility, cache-get, advice-recheck, then the rest lapsed.
  {
    const t = await createTestEnv(ENV);
    await seed(t);
    const script = [NOW, NOW, NOW, NOW, NOW + 999999];
    let i = 0;
    const clock = () => script[Math.min(i++, script.length - 1)];
    let calls = 0;
    const out = await decideRoute({ db: t.DB, env: t.env, tenant: 'u_alice', features: { model: 'm' }, fetchImpl: async () => { calls += 1; throw new Error('must not call'); }, clock });
    assert.equal(out.source, 'fallback');
    assert.equal(out.failure.code, 'DEADLINE_EXCEEDED');
    assert.equal(calls, 0);
  }
});

test('routing capacity: failed refunds leave the hold recoverable', async () => {
  const t = await createTestEnv({});
  await seed(t);
  await reserveCapacity(t.DB, { opId: 'op_f', tenant: 'u_alice', grantId: 'g_rc', jobs: 1, tokens: 100, nowMs: NOW });
  const failDb = {
    ...t.DB,
    prepare: (sql) => {
      if (!sql.includes('UPDATE grants')) return t.DB.prepare(sql);
      return {
        bind: (...p) => {
          const real = t.DB.prepare(sql).bind(...p);
          return { ...real, run: async () => { throw new Error('injected refund failure'); } };
        },
      };
    },
  };
  await assert.rejects(releaseCapacity(failDb, { opId: 'op_f', nowMs: NOW }), /injected/);
  const row = await t.DB.prepare('SELECT state FROM routing_reservations WHERE op_id = ?').bind('op_f').first();
  assert.match(row.state, /^releasing:/);
  // A plain retry finds no held row; the sweeper reaps the aged token.
  assert.equal(await releaseCapacity(t.DB, { opId: 'op_f', nowMs: NOW }), 0);
  assert.equal(await sweepReservations(t.DB, NOW + 120000), 1);
  const u = { ...(await t.DB.prepare('SELECT used_jobs, used_tokens FROM grants WHERE id = ?').bind('g_rc').first()) };
  assert.deepEqual(u, { used_jobs: 0, used_tokens: 0 });
});

test('routing ledger: concurrent stealers elect exactly one leader', async () => {
  const t = await createTestEnv({});
  await claimRequest(t.DB, { opId: 'op_s0', tenant: 'u_alice', requestId: 'req_s', nowMs: NOW });
  const a = claimRequest(t.DB, { opId: 'op_s1', tenant: 'u_alice', requestId: 'req_s', nowMs: NOW + 61000 });
  const b = claimRequest(t.DB, { opId: 'op_s2', tenant: 'u_alice', requestId: 'req_s', nowMs: NOW + 61000 });
  const rs = await Promise.allSettled([a, b]);
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  const denied = rs.filter((r) => r.status === 'rejected');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].reason.code, 'ROUTE_OP_IN_FLIGHT');
});

test('routing decide: cached admission respects the absolute deadline', async () => {
  const t = await createTestEnv(ENV);
  await seed(t);
  const ok = async () => new Response(JSON.stringify(rankResponse(['r1', 'r2'])), { status: 200 });
  await decideRoute({ db: t.DB, env: t.env, tenant: 'u_alice', features: { model: 'm', kinds: ['local'] }, fetchImpl: ok, nowMs: NOW });
  // Positions: claim, request, eligibility, cache-get, cascade-recheck.
  const script = [NOW, NOW, NOW, NOW, NOW + 999999];
  let i = 0;
  const out = await decideRoute({ db: t.DB, env: t.env, tenant: 'u_alice', features: { model: 'm', kinds: ['local'] }, fetchImpl: ok, clock: () => script[Math.min(i++, script.length - 1)] });
  assert.equal(out.source, 'cached');
  assert.equal(out.route, null);
  assert.equal(out.degraded, true);
  assert.equal(out.failure.code, 'DEADLINE_EXCEEDED');
});

test('routing decide: cascade skips raced quota, dispatch stays 501', async () => {
  const t = await createTestEnv(ENV);
  await seed(t);
  // Pre-exhaust rb's grant AFTER eligibility would pass: cascade must move on.
  const picks = [
    { alias: 'r1', resourceId: 'rb', via: {}, grantId: 'g_rb' },
    { alias: 'r2', resourceId: 'r1', via: { owned: true }, grantId: null },
  ];
  await t.DB.prepare('UPDATE grants SET used_jobs = 10 WHERE id = ?').bind('g_rb').run();
  const win = await reserveCascade(t.DB, { opId: 'op_cas', tenant: 'u_alice', picks, jobs: 1, tokens: 100, nowMs: NOW });
  assert.equal(win.resourceId, 'r1');
  assert.equal(win.reservation, null);
  // Gate 1 guard pinned in this lane: no route executes.
  const res = await readJson(await t.call('/api/jobs', { method: 'POST', headers: { ...t.csrf, ...t.as(t.alice) }, body: { resourceId: 'r1' } }));
  assert.equal(res.status, 501);
  assert.equal(res.json.code, 'INFERENCE_DISABLED');
});

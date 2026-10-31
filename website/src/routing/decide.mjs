/* Built with Meta Muse. */
// decideRoute: the full Gate-1 decision path. Eligibility (shared
// authority) -> deterministic scoring -> advice-or-cache ranking ->
// durable op commit -> capacity cascade. Cache hits revalidate against the
// CURRENT alias set and still reserve fresh; reservations never survive
// past their TTL without the sweeper. NOTHING HERE EXECUTES: every outcome
// carries executable:false + dispatchDisabled:true until Milestone E wires
// a qualified transport behind its own gates (POST /api/jobs stays 501).
import { rid } from '../lib/store.js';
import { listEligible } from './eligibility.mjs';
import {
  ROUTING_POLICY_VERSION, scoreCandidates, routingDigests, newRoutingRequest,
} from './policy.mjs';
import { requestAdvice, resolveAdvicePolicy } from './advise.mjs';
import { commitDecision, getOpByRequest } from './ledger.mjs';
import { reserveCascade, releaseCapacity } from './capacity.mjs';
import { cacheKeyFor, getCached, putCached, ROUTING_CACHE_TTL_MS, ROUTING_CACHE_STALE_MAX_MS, ROUTING_CACHE_MAX_PER_TENANT } from './cache.mjs';
import { completeRanking } from './ranking.mjs';

const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

function serveCached(validatedIds, ranked) {
  const current = new Set(ranked.map((r) => r.alias));
  const kept = validatedIds.filter((a) => current.has(a));
  if (kept.length === 0) return null;
  return completeRanking(kept, ranked.map((r) => r.alias));
}

/**
 * Run one routing decision end to end.
 * features: {model?, maxTokens?, kinds?, requestId?}
 * @returns {source, ranking, completed, route:{resourceId,alias,reservation,
 *   capacityUnknown}|null, degraded, failure, executable:false,
 *   dispatchDisabled:true, replay, receipt:{opId,requestId,digests,...}}
 */
export async function decideRoute({ db, env = {}, tenant, features = {}, tenantPolicy = null, fetchImpl = fetch, apiKey = null, nowMs = null } = {}) {
  if (!db || typeof tenant !== 'string' || !tenant) throw new Error('db and tenant required.');
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const f = features && typeof features === 'object' ? features : {};
  if (f.requestId !== undefined && f.requestId !== null && !ID_SHAPE.test(f.requestId)) throw new Error('requestId must be id-shaped.');
  const requestId = f.requestId || rid('route_req_');

  const stored = await getOpByRequest(db, tenant, requestId);
  if (stored) {
    const body = JSON.parse(stored.ranking_json);
    return { ...body.outcome, replay: true, receipt: { ...body.outcome.receipt, opId: stored.id } };
  }

  const request = newRoutingRequest({ model: f.model, maxTokens: f.maxTokens, kinds: f.kinds, nowMs: now });
  const eligible = await listEligible(db, tenant, { nowMs: now, kinds: f.kinds || undefined, maxTokens: f.maxTokens || undefined, model: request.model || undefined });
  const scored = scoreCandidates(eligible.eligible, { model: request.model, maxTokens: request.maxTokens });
  const digests = await routingDigests({ model: request.model, maxTokens: request.maxTokens, kinds: request.kinds }, scored.ranked);
  const policy = resolveAdvicePolicy(env, tenantPolicy);
  const opId = rid('route_op_');

  const finish = async (outcome) => {
    const full = {
      ...outcome,
      executable: false,
      dispatchDisabled: true,
      replay: false,
      receipt: { opId, requestId, policyVersion: ROUTING_POLICY_VERSION, digests, ...(outcome.receipt || {}) },
    };
    const served = { ...full };
    delete served.receipt;
    served.receipt = { requestId, policyVersion: ROUTING_POLICY_VERSION, digests };
    const c = await commitDecision(db, {
      opId, tenant, requestId, ranking: full.ranking, source: full.source,
      failure: full.failure, outcome: served, digests, policyVersion: ROUTING_POLICY_VERSION, nowMs: now,
    });
    if (c.outcome === 'replay') {
      // Lost a same-request race after reserving: release our holds and
      // serve the winner's stored outcome.
      await releaseCapacity(db, { opId, reason: 'replay-lost-race' }).catch(() => {});
      const body = JSON.parse(c.op.ranking_json);
      return { ...body.outcome, replay: true, receipt: { ...body.outcome.receipt, opId: c.op.id } };
    }
    return full;
  };

  if (scored.ranked.length === 0) {
    return finish({ source: 'none', ranking: [], completed: false, route: null, degraded: false, failure: { code: 'NO_CANDIDATES', status: 200 } });
  }

  const key = cacheKeyFor(tenant, digests.featureDigest, digests.candidateDigest, ROUTING_POLICY_VERSION, policy.mode);
  const serveStale = env.ROUTING_ADVICE_SERVE_STALE === '1';
  const cached = await getCached(db, key, now, { allowStale: serveStale });
  if (cached) {
    const served = serveCached(cached.response.rankedIds || [], scored.ranked);
    if (served) {
      const route = await cascadeFor(db, tenant, opId, served.ranking, scored.ranked, request, now);
      return finish({
        source: cached.stale ? 'degraded-stale' : 'cached',
        ranking: served.ranking, completed: served.completed, route,
        degraded: cached.stale || route === null,
        failure: route === null ? { code: 'ROUTE_CAPACITY_EXHAUSTED', status: 429 } : null,
      });
    }
  }

  const advice = await requestAdvice({ db, env, tenant, request, ranked: scored, tenantPolicy, fetchImpl, apiKey, nowMs: now });
  if (advice.outcome === 'advice') {
    await putCached(db, {
      key, tenant, response: { rankedIds: advice.ranking }, ttlMs: cacheTtl(env), capPerTenant: cacheCap(env), nowMs: now,
    }).catch(() => { /* cache is advisory; a failed write must not fail the route */ });
  }
  const route = await cascadeFor(db, tenant, opId, advice.ranking, scored.ranked, request, now);
  // A committed route that later proves unusable releases through the
  // op-scoped release (Milestone E dispatch wiring); nothing executes here.
  return finish({
    source: advice.outcome === 'advice' ? 'advice' : 'fallback',
    ranking: advice.ranking, completed: !!advice.completed, route,
    degraded: route === null,
    failure: advice.failure || (route === null ? { code: 'ROUTE_CAPACITY_EXHAUSTED', status: 429 } : null),
  });
}

async function cascadeFor(db, tenant, opId, ranking, scored, request, now) {
  const byAlias = new Map(scored.map((r) => [r.alias, r.candidate]));
  const picks = ranking.map((a) => {
    const c = byAlias.get(a);
    if (!c) return null;
    return { alias: a, resourceId: c.resourceId, grantId: c.via && c.via.grantId ? c.via.grantId : null };
  }).filter(Boolean);
  return reserveCascade(db, {
    opId, tenant, picks, jobs: 1,
    tokens: Number.isSafeInteger(request.maxTokens) && request.maxTokens > 0 ? request.maxTokens : 0,
    nowMs: now,
  });
}

function cacheTtl(env) {
  const n = Number(env.ROUTING_ADVICE_CACHE_TTL_MS);
  return Number.isSafeInteger(n) && n > 0 ? n : ROUTING_CACHE_TTL_MS;
}

function cacheCap(env) {
  const n = Number(env.ROUTING_ADVICE_CACHE_MAX);
  return Number.isSafeInteger(n) && n > 0 ? n : ROUTING_CACHE_MAX_PER_TENANT;
}

export { releaseCapacity };
export const ROUTING_STALE_MAX_MS = ROUTING_CACHE_STALE_MAX_MS;

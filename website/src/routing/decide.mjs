/* Built with Meta Muse. */
// decideRoute: the full Gate-1 decision path. Request identity is claimed
// BEFORE any side effect (budget charge, provider call, reservation), so
// duplicate callers replay or back off instead of duplicating spend.
// Production runs on a LIVE clock: pinned time exists only for explicitly
// injected test clocks, and the absolute deadline is rechecked before the
// advice call and before capacity admission. NOTHING HERE EXECUTES: every
// outcome carries executable:false + dispatchDisabled:true until
// Milestone E wires a qualified transport behind its own gates
// (POST /api/jobs stays 501).
import { rid } from '../lib/store.js';
import { listEligible } from './eligibility.mjs';
import {
  ROUTING_POLICY_VERSION, scoreCandidates, routingDigests, newRoutingRequest,
} from './policy.mjs';
import { requestAdvice, resolveAdvicePolicy } from './advise.mjs';
import { claimRequest, finalizeDecision, cancelClaim } from './ledger.mjs';
import { reserveCascade, releaseCapacity } from './capacity.mjs';
import { cacheKeyFor, getCached, putCached, ROUTING_CACHE_TTL_MS, ROUTING_CACHE_MAX_PER_TENANT } from './cache.mjs';
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
 * clock: () => ms. Omit in production (live); inject in tests (pinned or
 * scripted). Timers (abort) always use real time.
 * @returns {source, ranking, completed, route, degraded, failure,
 *   executable:false, dispatchDisabled:true, replay, receipt}
 */
export async function decideRoute({ db, env = {}, tenant, features = {}, tenantPolicy = null, fetchImpl = fetch, apiKey = null, nowMs = null, clock = null } = {}) {
  if (!db || typeof tenant !== 'string' || !tenant) throw new Error('db and tenant required.');
  const clockFn = typeof clock === 'function' ? clock : (Number.isFinite(nowMs) ? () => nowMs : () => Date.now());
  const injected = typeof clock === 'function' || Number.isFinite(nowMs);
  const now = () => clockFn();
  const f = features && typeof features === 'object' ? features : {};
  if (f.requestId !== undefined && f.requestId !== null && !ID_SHAPE.test(f.requestId)) throw new Error('requestId must be id-shaped.');
  const requestId = f.requestId || rid('route_req_');
  const opId = rid('route_op_');

  // Claim identity before ANY side effect: duplicates replay the stored
  // outcome or back off while the winner runs. No budget, provider, cache
  // write or reservation happens before this line returns leader.
  let claim;
  try {
    claim = await claimRequest(db, { opId, tenant, requestId, nowMs: now() });
  } catch (e) {
    if (e && e.code === 'ROUTE_OP_IN_FLIGHT') {
      return {
        source: 'none', ranking: [], completed: false, route: null, degraded: false,
        failure: { code: 'ROUTE_OP_IN_FLIGHT', status: 429 },
        executable: false, dispatchDisabled: true, replay: false,
        receipt: { opId: null, requestId, policyVersion: ROUTING_POLICY_VERSION, digests: null },
      };
    }
    throw e;
  }
  if (claim.outcome === 'replay') {
    const body = JSON.parse(claim.op.ranking_json);
    return { ...body.outcome, replay: true, receipt: { ...body.outcome.receipt, opId: claim.op.id } };
  }

  try {
    const request = newRoutingRequest({ model: f.model, maxTokens: f.maxTokens, kinds: f.kinds, nowMs: now() });
    const eligible = await listEligible(db, tenant, { nowMs: now(), kinds: f.kinds || undefined, maxTokens: f.maxTokens || undefined, model: request.model || undefined });
    const scored = scoreCandidates(eligible.eligible, { model: request.model, maxTokens: request.maxTokens });
    const digests = await routingDigests({ model: request.model, maxTokens: request.maxTokens, kinds: request.kinds }, scored.ranked);
    const policy = resolveAdvicePolicy(env, tenantPolicy);

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
      await finalizeDecision(db, {
        opId, tenant, requestId, ranking: full.ranking, source: full.source,
        failure: full.failure, outcome: served, digests, policyVersion: ROUTING_POLICY_VERSION, nowMs: now(),
      });
      return full;
    };

    if (scored.ranked.length === 0) {
      return finish({ source: 'none', ranking: [], completed: false, route: null, degraded: false, failure: { code: 'NO_CANDIDATES', status: 200 } });
    }

    const key = cacheKeyFor(tenant, digests.featureDigest, digests.candidateDigest, ROUTING_POLICY_VERSION, policy.mode);
    const serveStale = env.ROUTING_ADVICE_SERVE_STALE === '1';
    const cached = await getCached(db, key, now(), { allowStale: serveStale });
    if (cached) {
      const served = serveCached(cached.response.rankedIds || [], scored.ranked);
      if (served) {
        const route = await cascadeFor(db, tenant, opId, served.ranking, scored.ranked, request, now());
        return finish({
          source: cached.stale ? 'degraded-stale' : 'cached',
          ranking: served.ranking, completed: served.completed, route,
          degraded: cached.stale || route === null,
          failure: route === null ? { code: 'ROUTE_CAPACITY_EXHAUSTED', status: 429 } : null,
        });
      }
    }

    // Recheck the absolute deadline after the (possibly slow) eligibility
    // and cache reads: a lapsed request falls back without calling.
    let advice;
    if (request.deadlineMs <= now()) {
      advice = { outcome: 'fallback', ranking: scored.ranked.map((r) => r.alias), completed: false, failure: { code: 'DEADLINE_EXCEEDED', status: 200 } };
    } else {
      advice = await requestAdvice({ db, env, tenant, request, ranked: scored, tenantPolicy, fetchImpl, apiKey, nowMs: injected ? now() : null });
    }
    if (advice.outcome === 'advice') {
      await putCached(db, {
        key, tenant, response: { rankedIds: advice.ranking }, ttlMs: cacheTtl(env), capPerTenant: cacheCap(env), nowMs: now(),
      }).catch(() => { /* cache is advisory; a failed write must not fail the route */ });
    }
    // Recheck before admission: capacity holds must not start past deadline.
    if (request.deadlineMs <= now()) {
      return finish({
        source: advice.outcome === 'advice' ? 'advice' : 'fallback',
        ranking: advice.ranking, completed: !!advice.completed, route: null, degraded: true,
        failure: advice.failure || { code: 'DEADLINE_EXCEEDED', status: 200 },
      });
    }
    const route = await cascadeFor(db, tenant, opId, advice.ranking, scored.ranked, request, now());
    return finish({
      source: advice.outcome === 'advice' ? 'advice' : 'fallback',
      ranking: advice.ranking, completed: !!advice.completed, route,
      degraded: route === null,
      failure: advice.failure || (route === null ? { code: 'ROUTE_CAPACITY_EXHAUSTED', status: 429 } : null),
    });
  } catch (e) {
    // Leader error path: release any holds and free the claim promptly so
    // retries replay instead of wedging on our corpse for 60s.
    await releaseCapacity(db, { opId, reason: 'leader-error' }).catch(() => {});
    await cancelClaim(db, { opId, tenant, requestId, nowMs: now() }).catch(() => {});
    throw e;
  }
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

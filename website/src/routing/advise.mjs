/* Built with Meta Muse. */
// Advice orchestrator: at most ONE bounded advice attempt per routing
// decision, only for explicitly enabled tie-break/shadow with 2+ eligible
// candidates. Default is no call: disabled policy, contributor without
// opt-in, exhausted budget, expired deadline, single candidate, oversize
// envelope, or missing credentials all fall back WITHOUT dispatching.
// Failures never throw to the caller: every path returns either a validated
// ranking or the deterministic fallback with a typed failure receipt.
// No retries, no hidden replays: a timeout falls back once (Milestone C
// adds breaker/cache semantics; durable op ledger too).
import { rid } from '../lib/store.js';
import { callRoutingAdvice } from './adapter.mjs';
import { META_PRICES, RANK_OUTPUT_MAX_TOKENS, RANK_ENVELOPE_MAX, estimateTokens, spendFor } from './adapters/meta.mjs';
import { validateRanking, completeRanking } from './ranking.mjs';
import { toEnvelopeCandidate } from './policy.mjs';
import { claimAdviceBudget } from './budgets.mjs';

const intOr = (v, fb, lo, hi) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) return fb;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * Resolve the effective advice policy. Contributor mode needs BOTH the
 * deployment flag and an explicit tenant opt-in; anything else stays on
 * standard or is disallowed. (Durable per-tenant policy: Milestone C.)
 */
export function resolveAdvicePolicy(env = {}, tenantPolicy = null) {
  const enabled = env.ROUTING_ADVICE_ENABLED === '1';
  const wantContributor = env.ROUTING_ADVICE_MODE === 'contributor';
  const contributorAllowed = wantContributor
    && env.ROUTING_ADVICE_ALLOW_CONTRIBUTOR === '1'
    && !!(tenantPolicy && tenantPolicy.contributorOptIn === true);
  const mode = wantContributor ? 'contributor' : 'standard';
  return {
    enabled,
    mode,
    contributorAllowed: wantContributor ? contributorAllowed : true,
    model: (META_PRICES[mode] || META_PRICES.standard).model,
    allowanceMs: intOr(env.ROUTING_ADVICE_ALLOWANCE_MS, 2000, 100, 20000),
    minCandidates: intOr(env.ROUTING_ADVICE_MIN_CANDIDATES, 2, 2, 200),
    adapter: typeof env.ROUTING_ADAPTER === 'string' && env.ROUTING_ADAPTER ? env.ROUTING_ADAPTER : 'meta',
  };
}

/**
 * Request one advice ranking. Never throws for advice-path failures.
 * @returns {outcome:'advice'|'fallback', ranking:string[], completed:boolean,
 *   failure:{code,status}|null, receipt:{opId,mode,model,usage,spendUsdEst,
 *   latencyMs,priceRef,attempted:boolean}}
 */
export async function requestAdvice({ db, env = {}, tenant, request, ranked, tenantPolicy = null, fetchImpl = fetch, apiKey = null, nowMs = null } = {}) {
  if (!db || typeof tenant !== 'string' || !tenant) throw new Error('db and tenant required.');
  if (!request || typeof request.requestId !== 'string' || !Number.isSafeInteger(request.deadlineMs)) throw new Error('valid request required.');
  const list = ranked && Array.isArray(ranked.ranked) ? ranked.ranked : null;
  if (!list) throw new Error('ranked candidates required.');
  const pinned = Number.isFinite(nowMs);
  const now = () => (pinned ? nowMs : Date.now());
  const t0 = now();
  const policy = resolveAdvicePolicy(env, tenantPolicy);
  const fallbackOrder = list.map((r) => r.alias);
  const base = (failure, attempted, spendUsdEst, usage) => ({
    outcome: 'fallback',
    ranking: [...fallbackOrder],
    completed: false,
    failure,
    receipt: {
      opId: request.requestId, mode: policy.mode, model: policy.model,
      usage: usage || { inputTokens: null, outputTokens: null, source: 'none' },
      spendUsdEst, latencyMs: now() - t0,
      priceRef: { version: META_PRICES.version, source: META_PRICES.source },
      attempted,
    },
  });
  if (list.length === 0) return base({ code: 'NO_CANDIDATES', status: 200 }, false, 0);
  if (!policy.enabled) return base({ code: 'ADVICE_DISALLOWED', status: 200 }, false, 0);
  if (!policy.contributorAllowed) return base({ code: 'ADVICE_DISALLOWED', status: 200 }, false, 0);
  if (list.length < policy.minCandidates) return base({ code: 'ADVICE_SKIPPED', status: 200 }, false, 0);
  if (request.deadlineMs <= now()) return base({ code: 'DEADLINE_EXCEEDED', status: 200 }, false, 0);

  const envelope = list.map(toEnvelopeCandidate);
  const payload = JSON.stringify(envelope);
  if (payload.length > RANK_ENVELOPE_MAX) return base({ code: 'ADVICE_ENVELOPE_TOO_LARGE', status: 200 }, false, 0);
  const key = apiKey || env.MODEL_API_KEY || null;
  const realFetch = fetchImpl === fetch;
  if (!key && realFetch) return base({ code: 'ADVICE_UNCONFIGURED', status: 200 }, false, 0);

  const inputTokens = estimateTokens(payload);
  try {
    await claimAdviceBudget(db, tenant, { inputTokens, outputTokens: RANK_OUTPUT_MAX_TOKENS, env, clock: () => new Date(now()) });
  } catch (e) {
    return base({ code: (e && e.code) || 'ROUTE_ADVICE_REQUEST_BUDGET', status: 429 }, false, 0);
  }

  const remaining = Math.min(request.deadlineMs, now() + policy.allowanceMs) - now();
  if (remaining <= 0) return base({ code: 'DEADLINE_EXCEEDED', status: 200 }, false, 0);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  let attempted = false;
  try {
    attempted = true;
    const { data, usage } = await callRoutingAdvice({
      adapter: policy.adapter, fetchImpl, apiKey: key, envelope,
      mode: policy.mode, maxOutputTokens: RANK_OUTPUT_MAX_TOKENS, signal: controller.signal,
    });
    const aliasSet = new Set(fallbackOrder);
    const valid = validateRanking(data, aliasSet);
    const { ranking, completed } = completeRanking(valid.rankedIds, fallbackOrder);
    const rep = usage.inputTokens !== null && usage.outputTokens !== null;
    const finalUsage = rep
      ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, source: 'reported' }
      : { inputTokens: inputTokens, outputTokens: RANK_OUTPUT_MAX_TOKENS, source: 'estimated' };
    return {
      outcome: 'advice',
      ranking,
      completed,
      failure: null,
      receipt: {
        opId: request.requestId, mode: policy.mode, model: policy.model, usage: finalUsage,
        spendUsdEst: spendFor(finalUsage.inputTokens, finalUsage.outputTokens, policy.mode),
        latencyMs: now() - t0,
        priceRef: { version: META_PRICES.version, source: META_PRICES.source },
        attempted: true,
      },
    };
  } catch (e) {
    const code = (e && e.code) || 'ADVICE_UPSTREAM';
    const status = (e && Number.isSafeInteger(e.status)) ? e.status : 502;
    return base({ code, status }, attempted, spendFor(inputTokens, RANK_OUTPUT_MAX_TOKENS, policy.mode));
  } finally {
    clearTimeout(timer);
  }
}

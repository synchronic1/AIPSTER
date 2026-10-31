/* Built with Meta Muse. */
// Routing policy route/v1: versioned deterministic scoring over eligible
// candidates. Hard eligibility lives in eligibility.mjs; everything here is
// a soft preference with an explicit point contribution, so any ranking is
// explainable and reproducible. Stable tie-break: score desc, alias asc
// (numeric-aware). Bounded: at most ROUTING_CANDIDATE_MAX candidates are
// evaluated per decision; the rest are reported truncated, never silently
// dropped without the flag.
//
// Re-evaluation triggers: any change in request features, candidate set,
// policy version, or deadline expiry invalidates a ranking. A ranking never
// authorizes execution: admission revalidates everything (Milestone C).
import { rid } from '../lib/store.js';
import { canonicalDigest } from '../lib/digest.js';
import { filterCapTokens } from '../lib/caps.js';

export const ROUTING_POLICY_VERSION = 'route/v1';
export const ROUTING_CANDIDATE_MAX = 200;
export const ROUTING_DEFAULT_DEADLINE_MS = 5000;
export const ROUTING_SCORE = {
  EXACT_TOKEN: 50,
  ONLINE: 30,
  FRESHNESS_MAX: 20,
  OWNED: 10,
  HEADROOM: 5,
};

/**
 * Immutable routing request identity. deadlineMs is an absolute epoch-ms
 * instant; admission and any model call must refuse work past it.
 */
export function newRoutingRequest({ model = null, maxTokens = null, kinds = null, deadlineMs = null, nowMs = null } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const deadline = deadlineMs === null || deadlineMs === undefined ? now + ROUTING_DEFAULT_DEADLINE_MS : deadlineMs;
  if (!Number.isSafeInteger(deadline) || deadline <= now) throw new Error('deadlineMs must be a future instant.');
  return Object.freeze({
    requestId: rid('route_'),
    policyVersion: ROUTING_POLICY_VERSION,
    model: typeof model === 'string' && model.length >= 1 && model.length <= 128 ? model : null,
    maxTokens: Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : null,
    kinds: Array.isArray(kinds) ? Object.freeze([...kinds]) : null,
    deadlineMs: deadline,
  });
}

/**
 * Canonical server-side candidate descriptor. Carries provenance
 * (owner/grant/source row) for audit; the model envelope (Milestone B)
 * derives from this via toEnvelopeCandidate, which strips every
 * server-only fact. No names, hosts, or free-form text anywhere here.
 */
export function buildDescriptor({ resource, grant, trusted, liveness, nowMs, model }) {
  const caps = filterCapTokens(resource.capabilities_json);
  const seen = trusted.heartbeatAt ? Date.parse(trusted.heartbeatAt) : NaN;
  const lastSeenAgeMs = (liveness === 'online' || liveness === 'stale') && Number.isFinite(seen)
    ? Math.max(0, nowMs - seen)
    : null;
  return {
    alias: null, // assigned by eligibility in resource-id order.
    resourceId: resource.id,
    ownerId: resource.owner_id,
    kind: resource.kind,
    modelCompat: 'unverified', // no model registry exists; never claimed.
    exactTokenMatch: model !== null && caps.includes(model),
    caps,
    liveness,
    lastSeenAgeMs,
    usable: trusted.usable,
    capacity: grant
      ? { jobsRemaining: Number(grant.max_jobs) - Number(grant.used_jobs), tokensRemaining: Number(grant.max_tokens) - Number(grant.used_tokens) }
      : null, // owned rows have no counters: unknown, never zero.
    via: grant ? { grantId: grant.id } : { owned: true },
    provenance: { policyVersion: ROUTING_POLICY_VERSION, evaluatedAt: new Date(nowMs).toISOString() },
  };
}

function compareAlias(a, b) {
  const pa = /^([a-z]*)(\d+)$/.exec(a) || [null, a, ''];
  const pb = /^([a-z]*)(\d+)$/.exec(b) || [null, b, ''];
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  return Number(pa[2] || 0) - Number(pb[2] || 0);
}

/**
 * Deterministically rank eligible candidates. Pure function of its inputs:
 * same candidates + features always yield the same order and scores.
 */
export function scoreCandidates(candidates, { model = null, maxTokens = null } = {}) {
  const input = Array.isArray(candidates) ? candidates : [];
  const truncated = input.length > ROUTING_CANDIDATE_MAX;
  const ranked = input.slice(0, ROUTING_CANDIDATE_MAX).map((c) => {
    const contributions = [];
    const give = (feature, points, detail) => contributions.push({ feature, points, detail });
    give('exactTokenMatch', c.exactTokenMatch ? ROUTING_SCORE.EXACT_TOKEN : 0, c.exactTokenMatch ? 'model string equals a capability token' : 'no exact token match');
    give('online', c.liveness === 'online' ? ROUTING_SCORE.ONLINE : 0, `liveness=${c.liveness}`);
    const fresh = c.lastSeenAgeMs === null ? 0 : Math.max(0, ROUTING_SCORE.FRESHNESS_MAX - Math.floor(c.lastSeenAgeMs / 60000));
    give('freshness', fresh, c.lastSeenAgeMs === null ? 'no heartbeat age' : `heartbeat age ${c.lastSeenAgeMs}ms`);
    const owned = !!(c.via && c.via.owned);
    give('owned', owned ? ROUTING_SCORE.OWNED : 0, owned ? 'owner-direct, no grant hop' : 'via grant');
    const remaining = c.capacity ? c.capacity.tokensRemaining : null;
    const headroom = remaining !== null && Number.isSafeInteger(maxTokens) && maxTokens > 0 && remaining >= 2 * maxTokens;
    give('headroom', headroom ? ROUTING_SCORE.HEADROOM : 0, remaining === null ? 'capacity unknown' : `tokensRemaining=${remaining}`);
    return {
      alias: c.alias,
      resourceId: c.resourceId,
      policyVersion: ROUTING_POLICY_VERSION,
      score: contributions.reduce((s, x) => s + x.points, 0),
      contributions,
      flags: [...(c.liveness === 'stale' ? ['stale-telemetry'] : []), ...(c.modelCompat !== 'verified' ? ['model-unverified'] : [])],
      candidate: c,
    };
  });
  ranked.sort((a, b) => (b.score - a.score) || compareAlias(a.alias, b.alias));
  return { policyVersion: ROUTING_POLICY_VERSION, ranked, truncated };
}

/**
 * Model-visible candidate: alias plus comparable facts only. No resource
 * ids, owner ids, grant ids, names, hosts, or credentials — the server
 * maps aliases back after validating the model's response.
 */
export function toEnvelopeCandidate(ranked) {
  const c = ranked.candidate;
  return {
    id: ranked.alias,
    kind: c.kind,
    modelCompat: c.modelCompat,
    exactTokenMatch: c.exactTokenMatch,
    liveness: c.liveness,
    lastSeenAgeMs: c.lastSeenAgeMs,
    usable: c.usable,
    caps: [...c.caps],
    tokensRemaining: c.capacity ? c.capacity.tokensRemaining : null,
    score: ranked.score,
    policyVersion: ranked.policyVersion,
  };
}

/** Pin request features and the candidate snapshot; any change re-digests. */
export async function routingDigests(features, ranked) {
  const f = features && typeof features === 'object' ? features : {};
  const featureDigest = await canonicalDigest({
    model: typeof f.model === 'string' ? f.model : null,
    maxTokens: Number.isSafeInteger(f.maxTokens) ? f.maxTokens : null,
    kinds: Array.isArray(f.kinds) ? [...f.kinds].sort() : null,
  });
  const candidateDigest = await canonicalDigest((Array.isArray(ranked) ? ranked : []).map((r) => [r.alias, r.resourceId, r.score, r.policyVersion]));
  return { featureDigest, candidateDigest };
}

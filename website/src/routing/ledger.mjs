/* Built with Meta Muse. */
// Durable routing-op ledger with leader election per request id. States:
// proposed (claimed, side effects in flight) -> admitted (a ranking
// exists) | rejected (no candidates) | expired (past TTL). Same (tenant,
// requestId) always serves one outcome: the claim winner performs budget
// charges, provider calls and reservations; duplicates replay the stored
// outcome or get ROUTE_OP_IN_FLIGHT while the winner runs. A claim whose
// leader dies expires quickly and becomes stealable, so no request id
// wedges permanently.
import { httpError } from '../lib/validate.js';
import { first, run } from '../lib/store.js';

export const ROUTING_OP_TTL_MS = 3600 * 1000;
export const ROUTING_CLAIM_TTL_MS = 60000;

const SOURCES = ['advice', 'cached', 'fallback', 'degraded-stale', 'none'];

/**
 * Claim one request id. Exactly one caller becomes leader; the rest get
 * the stored outcome (replay) or ROUTE_OP_IN_FLIGHT while it runs.
 * @returns {{outcome:'leader'|'replay', op:object}}
 * @throws 429 ROUTE_OP_IN_FLIGHT when the winner is still running.
 */
export async function claimRequest(db, { opId, tenant, requestId, nowMs = null } = {}) {
  if (typeof opId !== 'string' || !opId) throw new Error('opId required.');
  if (typeof tenant !== 'string' || !tenant) throw new Error('tenant required.');
  if (typeof requestId !== 'string' || !requestId) throw new Error('requestId required.');
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const at = new Date(now).toISOString();
  const ins = await run(db,
    `INSERT INTO routing_ops (id, tenant_id, request_id, state, source, ranking_json, failure_code, feature_digest, candidate_digest, policy_version, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, 'proposed', 'none', ?, NULL, NULL, NULL, 'route/v1', ?, ?, ?)
     ON CONFLICT (tenant_id, request_id) DO NOTHING`,
    opId, tenant, requestId, JSON.stringify({ ranking: [], source: 'none', failure: null, outcome: null }),
    at, at, new Date(now + ROUTING_CLAIM_TTL_MS).toISOString());
  if (Number(ins.meta.changes) === 1) return { outcome: 'leader', op: await getOpByRequest(db, tenant, requestId) };
  const row = await getOpByRequest(db, tenant, requestId);
  if (!row) throw httpError(429, 'Another route decision is running for this request. Retry with the same request id.', 'ROUTE_OP_IN_FLIGHT');
  if (row.state === 'admitted' || row.state === 'rejected') return { outcome: 'replay', op: row };
  // Proposed or expired: steal only when the claim lapsed, else back off.
  // The takeover predicate carries the OBSERVED owner and expiry: two
  // concurrent stealers race the same predicate and exactly one wins,
  // because the winner's renewal invalidates the loser's predicate.
  const lapsed = row.state === 'expired' || Date.parse(row.expires_at) <= now;
  if (!lapsed) throw httpError(429, 'Another route decision is running for this request. Retry with the same request id.', 'ROUTE_OP_IN_FLIGHT');
  const steal = await run(db,
    "UPDATE routing_ops SET id = ?, state = 'proposed', updated_at = ?, expires_at = ? WHERE tenant_id = ? AND request_id = ? AND state IN ('proposed','expired') AND id = ? AND expires_at = ?",
    opId, at, new Date(now + ROUTING_CLAIM_TTL_MS).toISOString(), tenant, requestId, row.id, row.expires_at);
  if (Number(steal.meta.changes) === 1) return { outcome: 'leader', op: await getOpByRequest(db, tenant, requestId) };
  const again = await getOpByRequest(db, tenant, requestId);
  if (again && (again.state === 'admitted' || again.state === 'rejected')) return { outcome: 'replay', op: again };
  throw httpError(429, 'Another route decision is running for this request. Retry with the same request id.', 'ROUTE_OP_IN_FLIGHT');
}

/**
 * Finalize the leader's claim with the served outcome. Only the owning
 * proposed row moves; anything else means the claim lapsed mid-flight.
 * Read-before-write: the row is selected BEFORE the commit UPDATE and the
 * committed values are returned from memory, so there is no fallible step
 * after the commit that could falsely trigger rollback-style cleanup of an
 * admitted decision.
 */
export async function finalizeDecision(db, { opId, tenant, requestId, ranking, source, failure = null, outcome = null, digests = {}, policyVersion = 'route/v1', ttlMs = ROUTING_OP_TTL_MS, nowMs = null } = {}) {
  if (!SOURCES.includes(source)) throw new Error('unknown source.');
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const at = new Date(now).toISOString();
  const row = {
    ranking: Array.isArray(ranking) ? ranking : [],
    source,
    failure: failure ? { code: failure.code || 'UNKNOWN', status: failure.status || 502 } : null,
    outcome: outcome && typeof outcome === 'object' ? outcome : null,
  };
  const prev = await getOpByRequest(db, tenant, requestId);
  const state = row.ranking.length > 0 ? 'admitted' : 'rejected';
  const rankingJson = JSON.stringify(row);
  const failureCode = row.failure ? row.failure.code : null;
  const featureDigest = digests.featureDigest || null;
  const candidateDigest = digests.candidateDigest || null;
  const expiresAt = new Date(now + ttlMs).toISOString();
  const res = await run(db,
    `UPDATE routing_ops SET state = ?, source = ?, ranking_json = ?, failure_code = ?, feature_digest = ?, candidate_digest = ?, policy_version = ?, updated_at = ?, expires_at = ?
     WHERE tenant_id = ? AND request_id = ? AND id = ? AND state = 'proposed'`,
    state, source, rankingJson, failureCode, featureDigest, candidateDigest,
    policyVersion, at, expiresAt, tenant, requestId, opId);
  if (Number(res.meta.changes) !== 1) throw httpError(503, 'Routing claim lapsed before commit.', 'ROUTE_OP_SUPERSEDED');
  return {
    ...(prev || {}), id: opId, tenant_id: tenant, request_id: requestId, state, source,
    ranking_json: rankingJson, failure_code: failureCode, feature_digest: featureDigest,
    candidate_digest: candidateDigest, policy_version: policyVersion, updated_at: at, expires_at: expiresAt,
  };
}

/** Best-effort cancel of our own pending claim (leader error path). */
export async function cancelClaim(db, { opId, tenant, requestId, nowMs = null } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  await run(db,
    "UPDATE routing_ops SET state = 'expired', updated_at = ? WHERE tenant_id = ? AND request_id = ? AND id = ? AND state = 'proposed'",
    new Date(now).toISOString(), tenant, requestId, opId);
}

export async function getOpByRequest(db, tenant, requestId) {
  return first(db, 'SELECT * FROM routing_ops WHERE tenant_id = ? AND request_id = ?', tenant, requestId);
}

/** Flip past-TTL rows (including stale claims) to expired. Returns count. */
export async function expireOps(db, nowMs = null) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const res = await run(db,
    "UPDATE routing_ops SET state = 'expired', updated_at = ? WHERE state IN ('proposed','admitted','rejected') AND expires_at < ?",
    new Date(now).toISOString(), new Date(now).toISOString());
  return Number(res.meta.changes);
}

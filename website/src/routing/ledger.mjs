/* Built with Meta Muse. */
// Durable routing-op ledger: every routing decision commits exactly one op
// row (or replays the stored one). States: admitted (a ranking exists,
// whatever its source), rejected (no candidates), expired (past TTL).
// Same (tenant, requestId) always returns the stored op: retries never
// duplicate decisions, reservations, or provider calls.
import { first, run } from '../lib/store.js';

export const ROUTING_OP_TTL_MS = 3600 * 1000;

const SOURCES = ['advice', 'cached', 'fallback', 'degraded-stale', 'none'];

/**
 * Commit a decision or replay the stored one for this request id.
 * @returns {{outcome:'committed'|'replay', op:object}}
 */
export async function commitDecision(db, { opId, tenant, requestId, ranking, source, failure = null, outcome = null, digests = {}, policyVersion = 'route/v1', ttlMs = ROUTING_OP_TTL_MS, nowMs = null } = {}) {
  if (typeof opId !== 'string' || !opId) throw new Error('opId required.');
  if (typeof tenant !== 'string' || !tenant) throw new Error('tenant required.');
  if (typeof requestId !== 'string' || !requestId) throw new Error('requestId required.');
  if (!SOURCES.includes(source)) throw new Error('unknown source.');
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const at = new Date(now).toISOString();
  const row = {
    ranking: Array.isArray(ranking) ? ranking : [],
    source,
    failure: failure ? { code: failure.code || 'UNKNOWN', status: failure.status || 502 } : null,
    outcome: outcome && typeof outcome === 'object' ? outcome : null,
  };
  const res = await run(db,
    `INSERT INTO routing_ops (id, tenant_id, request_id, state, source, ranking_json, failure_code, feature_digest, candidate_digest, policy_version, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, request_id) DO NOTHING`,
    opId, tenant, requestId, row.ranking.length > 0 ? 'admitted' : 'rejected', source,
    JSON.stringify(row), row.failure ? row.failure.code : null,
    digests.featureDigest || null, digests.candidateDigest || null, policyVersion,
    at, at, new Date(now + ttlMs).toISOString());
  if (Number(res.meta.changes) === 1) {
    return { outcome: 'committed', op: await getOpByRequest(db, tenant, requestId) };
  }
  return { outcome: 'replay', op: await getOpByRequest(db, tenant, requestId) };
}

export async function getOpByRequest(db, tenant, requestId) {
  return first(db, 'SELECT * FROM routing_ops WHERE tenant_id = ? AND request_id = ?', tenant, requestId);
}

/** Flip past-TTL admitted/rejected ops to expired. Returns rows flipped. */
export async function expireOps(db, nowMs = null) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const res = await run(db,
    "UPDATE routing_ops SET state = 'expired', updated_at = ? WHERE state IN ('admitted','rejected') AND expires_at < ?",
    new Date(now).toISOString(), new Date(now).toISOString());
  return Number(res.meta.changes);
}

/* Built with Meta Muse. */
// Bounded advice cache: validated rankings keyed by (tenant, feature
// digest, candidate digest, policy, mode). Tenant is part of the key, so
// entries can never serve across tenants. Fresh entries serve within TTL;
// expired entries serve only when the caller explicitly allows stale AND
// the entry is inside the stale horizon; anything older is gone. Writes
// prune expired rows and enforce a per-tenant cap (oldest first), so the
// table cannot grow without bound. Cached rankings are re-validated
// against the CURRENT alias set on serve: stale ids can never escape.
export const ROUTING_CACHE_TTL_MS = 60000;
export const ROUTING_CACHE_STALE_MAX_MS = 300000;
export const ROUTING_CACHE_MAX_PER_TENANT = 100;

export function cacheKeyFor(tenant, featureDigest, candidateDigest, policyVersion, mode) {
  return [tenant, featureDigest, candidateDigest, policyVersion, mode].map((s) => String(s)).join('|');
}

export async function putCached(db, { key, tenant, response, ttlMs = ROUTING_CACHE_TTL_MS, capPerTenant = ROUTING_CACHE_MAX_PER_TENANT, nowMs = null } = {}) {
  if (typeof key !== 'string' || !key) throw new Error('key required.');
  if (typeof tenant !== 'string' || !tenant) throw new Error('tenant required.');
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const at = new Date(now).toISOString();
  await db.prepare('INSERT OR REPLACE INTO routing_advice_cache (cache_key, tenant_id, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(key, tenant, JSON.stringify(response), at, new Date(now + ttlMs).toISOString()).run();
  await db.prepare('DELETE FROM routing_advice_cache WHERE tenant_id = ? AND expires_at < ?').bind(tenant, at).run();
  await db.prepare(
    `DELETE FROM routing_advice_cache WHERE tenant_id = ? AND cache_key NOT IN
     (SELECT cache_key FROM routing_advice_cache WHERE tenant_id = ? ORDER BY created_at DESC, cache_key DESC LIMIT ?)`
  ).bind(tenant, tenant, capPerTenant).run();
}

/**
 * @returns null on miss, else {response, stale:boolean}.
 * allowStale serves expired rows inside the stale horizon only.
 */
export async function getCached(db, key, nowMs = null, { allowStale = false, staleMaxMs = ROUTING_CACHE_STALE_MAX_MS } = {}) {
  if (typeof key !== 'string' || !key) return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const row = await db.prepare('SELECT * FROM routing_advice_cache WHERE cache_key = ?').bind(key).first();
  if (!row) return null;
  const exp = Date.parse(row.expires_at);
  if (Number.isFinite(exp) && exp > now) return { response: JSON.parse(row.response_json), stale: false };
  if (!allowStale) return null;
  if (!Number.isFinite(exp) || now - exp > staleMaxMs) return null;
  return { response: JSON.parse(row.response_json), stale: true };
}

/** Delete rows past the stale horizon. Returns rows deleted. */
export async function sweepCache(db, nowMs = null, staleMaxMs = ROUTING_CACHE_STALE_MAX_MS) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const res = await db.prepare('DELETE FROM routing_advice_cache WHERE expires_at < ?')
    .bind(new Date(now - staleMaxMs).toISOString()).run();
  return Number(res.meta.changes);
}

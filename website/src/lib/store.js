/* Built with Meta Muse. */
// D1 access helpers + row mapping. API shapes mirror the local backend so the
// control-panel UI ports without contract changes (except identity: Better
// Auth user {id, name, email} replaces local {id, username, displayName}).
import { resourceLiveness } from './status.mjs';

export const nowIso = () => new Date().toISOString();

export function rid(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// 128-bit random ids (Codex-sec-P2): attempt/asset ids guard pre-commit
// object writes that the D1 primary key only backstops after the fact, so
// a 32-bit birthday collision is reachable and would let one attempt
// overwrite or reclaim another tenant's live blobs. 16 bytes keeps random
// collision infeasible; the reservation gate + reclaim fence in the
// finalizer handle the remainder. Tests force collisions through the
// override (same __-hook convention as the fixture stores).
let rid16Override = null;
export function __setRid16ForTest(fn) { rid16Override = fn || null; }
export function rid16(prefix) {
  if (rid16Override) return rid16Override(prefix);
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function all(db, sql, ...params) {
  const res = await db.prepare(sql).bind(...params).all();
  return res.results || [];
}

export async function first(db, sql, ...params) {
  return db.prepare(sql).bind(...params).first();
}

export async function run(db, sql, ...params) {
  return db.prepare(sql).bind(...params).run();
}

export async function pageQuery(db, { select, from, params = [], order, limit, offset }) {
  const totalRow = await first(db, `SELECT COUNT(*) AS n ${from}`, ...params);
  const total = Number(totalRow ? totalRow.n : 0);
  const items = await all(db, `${select} ${from} ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
  return { items, total, limit, offset };
}

const asJson = (text, fallback) => {
  try { const v = JSON.parse(text || ''); return v ?? fallback; } catch { return fallback; }
};

export function cardFor(r, ownerName, nowMs = Date.now()) {
  // Displayed liveness derives from heartbeat freshness at READ time, using
  // the same resourceLiveness/STALE_AFTER_MS rule as GET /api/status — never
  // from the persisted online flag alone. A row whose flag claims online
  // with a stale/missing heartbeat renders offline here, exactly as the
  // status strip reports it. No background job rewrites the stored flag.
  const liveness = resourceLiveness(
    { online: Number(r.online) === 1, heartbeatAt: r.heartbeat_at ?? null },
    Number.isFinite(nowMs) ? nowMs : Date.now(),
  );
  const online = liveness === 'online';
  // usable is shown only while the resource is online: a stale usable=true
  // must not imply readiness the strip denies.
  const usable = online && Number(r.usable) === 1;
  // Terminal rung is reachability, not execution readiness: a usable:true
  // heartbeat proves the worker is reachable and willing, never inference
  // acceptance (/api/jobs is disabled). 'ready' returns only behind an
  // independently established execution signal.
  const status = !r.configured ? 'unconfigured' : !r.authenticated ? 'unauthenticated' : !online ? 'offline' : !usable ? 'unusable' : 'reachable';
  return {
    id: r.id, name: r.name, kind: r.kind, origin: r.origin,
    owner: { id: r.owner_id, name: ownerName },
    compute: { cpu: r.cpu, gpu: r.gpu }, capabilities: asJson(r.capabilities_json, []),
    state: { configured: !!r.configured, authenticated: !!r.authenticated, online, usable, status },
    heartbeatAt: r.heartbeat_at || null, limits: asJson(r.limits_json, {}), scope: r.scope,
    verification: asJson(r.verification_json, {}),
    credits: r.credits_json ? asJson(r.credits_json, null) : null, // informational only
    createdAt: r.created_at
  };
}

export function mapGrant(g) {
  return {
    id: g.id, resourceId: g.resource_id, ownerId: g.owner_id, granteeId: g.grantee_id,
    quotas: { maxJobs: g.max_jobs, maxTokens: g.max_tokens },
    usedJobs: g.used_jobs, usedTokens: g.used_tokens,
    inferenceOnly: !!g.inference_only, createdAt: g.created_at, revokedAt: g.revoked_at || null
  };
}

export function mapKey(k) {
  const { verifier, salt, ...rest } = {
    id: k.id, ownerId: k.owner_id, name: k.name, scope: k.scope,
    resourceId: k.resource_id || null,
    verifier: k.verifier, salt: k.salt, prefix: k.prefix,
    expiresAt: k.expires_at || null, metadata: k.metadata || '',
    createdAt: k.created_at, lastUsedAt: k.last_used_at || null, revokedAt: k.revoked_at || null
  };
  return rest;
}

export function mapJob(j) {
  return {
    id: j.id, ownerId: j.owner_id, resourceId: j.resource_id, grantId: j.grant_id || null,
    adapter: j.adapter, model: j.model, status: j.status,
    tokensIn: j.tokens_in, tokensOut: j.tokens_out, costSource: j.cost_source,
    createdAt: j.created_at, updatedAt: j.updated_at
  };
}

export function mapUsage(u) {
  return {
    id: u.id, ownerId: u.owner_id, kind: u.kind, requests: u.requests,
    tokensIn: u.tokens_in, tokensOut: u.tokens_out,
    modelCostUsd: u.model_cost_usd === null || u.model_cost_usd === undefined ? null : Number(u.model_cost_usd),
    executionCostUsd: u.execution_cost_usd === null || u.execution_cost_usd === undefined ? null : Number(u.execution_cost_usd),
    costSource: u.cost_source, at: u.at
  };
}

export function auditRow(actorId, action, target, detail = '') {
  return { id: rid('a_'), at: nowIso(), actorId: actorId || null, action, target, detail: String(detail).slice(0, 300) };
}

export async function audit(db, actorId, action, target, detail = '') {
  const a = auditRow(actorId, action, target, detail);
  await run(db, 'INSERT INTO audit (id, at, actor_id, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)',
    a.id, a.at, a.actorId, a.action, a.target, a.detail);
}

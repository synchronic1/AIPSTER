/* Built with Meta Muse. */
// Shared resource-access authority: owner or active same-side grant with
// remaining quota. Moved here verbatim from worker.js so the app routes and
// the routing eligibility path judge access through ONE implementation that
// cannot drift. Quota reads are NET usage (gross charges on grants.used_*
// minus routing_refunds receipts): every enforcement and display path must
// use grantUsage, never the raw counters, or refunded quota stays spent.
import { first } from './store.js';

/** Effective (net) usage of one grant: gross charges minus refund receipts. */
export async function grantUsage(db, grantId) {
  const row = await first(db,
    `SELECT used_jobs - (SELECT COALESCE(SUM(jobs), 0) FROM routing_refunds WHERE grant_id = ?) AS used_jobs,
            used_tokens - (SELECT COALESCE(SUM(tokens), 0) FROM routing_refunds WHERE grant_id = ?) AS used_tokens
     FROM grants WHERE id = ?`, grantId, grantId, grantId);
  if (!row) return { used_jobs: 0, used_tokens: 0 };
  return { used_jobs: Math.max(0, row.used_jobs), used_tokens: Math.max(0, row.used_tokens) };
}

export async function canUseResource(db, userId, resource) {
  if (resource.owner_id === userId) return { ok: true, grantId: null, grant: null };
  const g = await first(db, 'SELECT * FROM grants WHERE resource_id = ? AND grantee_id = ? AND revoked_at IS NULL', resource.id, userId);
  if (!g) return { ok: false, reason: 'No grant gives you access to this resource.' };
  if (!(await grantPartiesSameSide(db, g))) return { ok: false, reason: 'No grant gives you access to this resource.' };
  const net = await grantUsage(db, g.id);
  if (net.used_jobs >= g.max_jobs) return { ok: false, reason: 'Grant job quota exhausted.' };
  if (net.used_tokens >= g.max_tokens) return { ok: false, reason: 'Grant token quota exhausted.' };
  // Downstream readers (eligibility remaining, descriptor capacity) see the
  // same net counters this gate enforced: one truth, no drift.
  return { ok: true, grantId: g.id, grant: { ...g, used_jobs: net.used_jobs, used_tokens: net.used_tokens } };
}

export async function grantPartiesSameSide(db, grant) {
  // Grants never cross the demo sandbox boundary in either direction, and
  // legacy/stale cross-boundary rows authorize nothing.
  const o = await first(db, 'SELECT demo FROM "user" WHERE id = ?', grant.owner_id);
  const g = await first(db, 'SELECT demo FROM "user" WHERE id = ?', grant.grantee_id);
  if (!o || !g) return false;
  return Number(o.demo || 0) === Number(g.demo || 0);
}

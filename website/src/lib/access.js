/* Built with Meta Muse. */
// Shared resource-access authority: owner or active same-side grant with
// remaining quota. Moved here verbatim from worker.js so the app routes and
// the routing eligibility path judge access through ONE implementation that
// cannot drift. Behavior-preserving: same queries, same order, same reasons.
import { first } from './store.js';

export async function canUseResource(db, userId, resource) {
  if (resource.owner_id === userId) return { ok: true, grantId: null, grant: null };
  const g = await first(db, 'SELECT * FROM grants WHERE resource_id = ? AND grantee_id = ? AND revoked_at IS NULL', resource.id, userId);
  if (!g) return { ok: false, reason: 'No grant gives you access to this resource.' };
  if (!(await grantPartiesSameSide(db, g))) return { ok: false, reason: 'No grant gives you access to this resource.' };
  if (g.used_jobs >= g.max_jobs) return { ok: false, reason: 'Grant job quota exhausted.' };
  if (g.used_tokens >= g.max_tokens) return { ok: false, reason: 'Grant token quota exhausted.' };
  return { ok: true, grantId: g.id, grant: g };
}

export async function grantPartiesSameSide(db, grant) {
  // Grants never cross the demo sandbox boundary in either direction, and
  // legacy/stale cross-boundary rows authorize nothing.
  const o = await first(db, 'SELECT demo FROM "user" WHERE id = ?', grant.owner_id);
  const g = await first(db, 'SELECT demo FROM "user" WHERE id = ?', grant.grantee_id);
  if (!o || !g) return false;
  return Number(o.demo || 0) === Number(g.demo || 0);
}

/* Built with Meta Muse. */
// Atomic capacity holds on grant quotas. A reservation is a conditional
// UPDATE (revoked/headroom checked in the same statement that charges),
// so concurrent racers cannot overdraw and revocation wins immediately.
// Every hold has a ledger row and a TTL: explicit release, op-scoped
// release, and time-based sweep all converge on the same end state, and
// double release is a no-op (only held rows move).
// Gate 1 honesty: holds exist for a dispatch path that stays 501-disabled;
// they prove the mechanism, they do not execute anything.
import { httpError } from '../lib/validate.js';
import { first, run } from '../lib/store.js';
import { rid } from '../lib/store.js';
import { grantPartiesSameSide } from '../lib/access.js';

export const ROUTING_RESERVE_TTL_MS = 300000;
// Stuck refund-tokens (a crash between token claim and finalize) become
// stealable after this age; the sweeper completes exactly one refund.
export const ROUTING_TOKEN_REAP_MS = 60000;

function exhausted() {
  return httpError(429, 'Grant capacity exhausted for this route.', 'ROUTE_CAPACITY_EXHAUSTED');
}

/**
 * Hold jobs+tokens on one grant for one op. The conditional charge UPDATE
 * is the single atomic decision point (concurrent racers serialize on it;
 * the winner is read from its own meta.changes, never from cross-statement
 * changes() chaining, which concurrent batches can interleave). A crash
 * between charge and row insert leaks quota conservatively (fail-closed);
 * the op ledger records every hold for audit. Rejected gates insert no row.
 * @returns the held reservation row.
 * @throws ROUTE_CAPACITY_REVOKED / ROUTE_CAPACITY_EXHAUSTED.
 */
export async function reserveCapacity(db, { opId, tenant, grantId, jobs, tokens, ttlMs = ROUTING_RESERVE_TTL_MS, nowMs = null } = {}) {
  if (typeof opId !== 'string' || !opId) throw new Error('opId required.');
  if (typeof tenant !== 'string' || !tenant) throw new Error('tenant required.');
  if (typeof grantId !== 'string' || !grantId) throw new Error('grantId required.');
  if (!Number.isSafeInteger(jobs) || jobs <= 0 || !Number.isSafeInteger(tokens) || tokens < 0) throw new Error('jobs/tokens must be positive integers.');
  const g = await first(db, 'SELECT * FROM grants WHERE id = ?', grantId);
  if (!g || g.revoked_at !== null) throw httpError(409, 'Grant revoked or missing.', 'ROUTE_CAPACITY_REVOKED');
  if (g.grantee_id !== tenant) throw httpError(403, 'Grant is not yours.', 'ROUTE_CAPACITY_REVOKED');
  if (!(await grantPartiesSameSide(db, g))) throw httpError(409, 'Grant crosses the demo boundary.', 'ROUTE_CAPACITY_REVOKED');
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const id = rid('rsv_');
  const at = new Date(now).toISOString();
  const charge = await run(db,
    `UPDATE grants SET used_jobs = used_jobs + ?, used_tokens = used_tokens + ?
     WHERE id = ? AND revoked_at IS NULL AND used_jobs + ? <= max_jobs AND used_tokens + ? <= max_tokens`,
    jobs, tokens, grantId, jobs, tokens);
  if (Number(charge.meta.changes) !== 1) {
    const again = await first(db, 'SELECT revoked_at FROM grants WHERE id = ?', grantId);
    if (!again || again.revoked_at !== null) throw httpError(409, 'Grant revoked or missing.', 'ROUTE_CAPACITY_REVOKED');
    throw exhausted();
  }
  await run(db,
    'INSERT INTO routing_reservations (id, op_id, tenant_id, grant_id, jobs, tokens, state, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, opId, tenant, grantId, jobs, tokens, 'held', at, at, new Date(now + ttlMs).toISOString());
  return { id, opId, tenant, grantId, jobs, tokens, state: 'held' };
}

/**
 * Release every held reservation for one op. Each refund claims its row
 * under a per-call token, refunds conditional on that token, then
 * finalizes — three self-sufficient statements, no batch, no
 * cross-statement changes() chaining — so concurrent releasers refund
 * exactly once under any interleave (only the claim winner's token ever
 * matches). A failure between claim and finalize leaves a stuck token;
 * the sweeper reaps those after ROUTING_TOKEN_REAP_MS. Idempotent.
 * Returns count of rows this call moved out of held.
 */
export async function releaseCapacity(db, { opId, reason = 'release', nowMs = null } = {}) {
  if (typeof opId !== 'string' || !opId) throw new Error('opId required.');
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const held = await db.prepare("SELECT * FROM routing_reservations WHERE op_id = ? AND state = 'held'").bind(opId).all();
  let n = 0;
  for (const r of (held.results || [])) {
    n += await flipAndRefund(db, r.id, r.grant_id, r.jobs, r.tokens, 'released', now);
  }
  return n;
}

/**
 * Release held reservations past their TTL, and complete refunds for
 * refund-tokens stuck by a mid-refund failure (older than the reap age).
 * Returns rows moved.
 */
export async function sweepReservations(db, nowMs = null) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const iso = new Date(now).toISOString();
  const stale = await db.prepare("SELECT * FROM routing_reservations WHERE state = 'held' AND expires_at < ?").bind(iso).all();
  let n = 0;
  for (const r of (stale.results || [])) {
    n += await flipAndRefund(db, r.id, r.grant_id, r.jobs, r.tokens, 'expired', now);
  }
  const cutoff = new Date(now - ROUTING_TOKEN_REAP_MS).toISOString();
  const stuck = await db.prepare("SELECT * FROM routing_reservations WHERE state LIKE 'releasing:%' AND updated_at < ?").bind(cutoff).all();
  for (const r of (stuck.results || [])) {
    n += await reapToken(db, r, now);
  }
  return n;
}

async function flipAndRefund(db, id, grantId, jobs, tokens, toState, now) {
  const claiming = `releasing:${rid('rel_')}`;
  const iso = new Date(now).toISOString();
  const flip = await run(db, 'UPDATE routing_reservations SET state = ?, updated_at = ? WHERE id = ? AND state = \'held\'', claiming, iso, id);
  if (Number(flip.meta.changes) !== 1) return 0;
  await run(db,
    `UPDATE grants SET used_jobs = MAX(0, used_jobs - ?), used_tokens = MAX(0, used_tokens - ?)
     WHERE id = ? AND EXISTS (SELECT 1 FROM routing_reservations WHERE id = ? AND state = ?)`,
    jobs, tokens, grantId, id, claiming);
  await run(db, 'UPDATE routing_reservations SET state = ?, updated_at = ? WHERE id = ? AND state = ?', toState, iso, id, claiming);
  return 1;
}

// Complete a stuck token: steal it under a fresh token (conditional on the
// exact observed state, so racing reapers elect one winner), then refund
// and finalize conditional on the new token.
async function reapToken(db, row, now) {
  const claiming = `releasing:${rid('rel_')}`;
  const iso = new Date(now).toISOString();
  const flip = await run(db, 'UPDATE routing_reservations SET state = ?, updated_at = ? WHERE id = ? AND state = ?', claiming, iso, row.id, row.state);
  if (Number(flip.meta.changes) !== 1) return 0;
  await run(db,
    `UPDATE grants SET used_jobs = MAX(0, used_jobs - ?), used_tokens = MAX(0, used_tokens - ?)
     WHERE id = ? AND EXISTS (SELECT 1 FROM routing_reservations WHERE id = ? AND state = ?)`,
    row.jobs, row.tokens, row.grant_id, row.id, claiming);
  await run(db, 'UPDATE routing_reservations SET state = ?, updated_at = ? WHERE id = ? AND state = ?', 'expired', iso, row.id, claiming);
  return 1;
}

/**
 * Reserve down an ordered pick list: first reservable candidate wins.
 * Owned picks (grantId null) win without counters. Returns
 * {resourceId, alias, reservation|null} or null when nothing holds.
 */
export async function reserveCascade(db, { opId, tenant, picks, jobs, tokens, maxPicks = 3, ttlMs = ROUTING_RESERVE_TTL_MS, nowMs = null } = {}) {
  const list = Array.isArray(picks) ? picks.slice(0, maxPicks) : [];
  for (const p of list) {
    if (!p || typeof p.resourceId !== 'string') continue;
    if (!p.grantId) return { resourceId: p.resourceId, alias: p.alias || null, reservation: null, capacityUnknown: true };
    try {
      const reservation = await reserveCapacity(db, { opId, tenant, grantId: p.grantId, jobs, tokens, ttlMs, nowMs });
      return { resourceId: p.resourceId, alias: p.alias || null, reservation, capacityUnknown: false };
    } catch (e) {
      if (e && (e.code === 'ROUTE_CAPACITY_EXHAUSTED' || e.code === 'ROUTE_CAPACITY_REVOKED')) continue;
      throw e;
    }
  }
  return null;
}

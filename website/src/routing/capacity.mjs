/* Built with Meta Muse. */
// Atomic capacity holds on grant quotas. A reservation is a conditional
// UPDATE (revoked/headroom checked in the same statement that charges),
// so concurrent racers cannot overdraw and revocation wins immediately.
// Accounting is gross charges on grants.used_* minus durable refund
// receipts (routing_refunds, one row per reservation at most): a refund is
// an INSERT OR IGNORE, so it applies at most once across crashes, retries,
// and concurrent releasers by construction — no trigger, no batch, no
// token dance. Every hold has a ledger row and a TTL: explicit release,
// op-scoped release, and time-based sweep all converge on the same end
// state, and double release is a no-op (only held rows move).
// Gate 1 honesty: holds exist for a dispatch path that stays 501-disabled;
// they prove the mechanism, they do not execute anything.
import { httpError } from '../lib/validate.js';
import { first, run } from '../lib/store.js';
import { rid } from '../lib/store.js';
import { grantPartiesSameSide, grantUsage } from '../lib/access.js';

export { grantUsage };

export const ROUTING_RESERVE_TTL_MS = 300000;

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
     WHERE id = ? AND revoked_at IS NULL
     AND used_jobs - (SELECT COALESCE(SUM(jobs), 0) FROM routing_refunds WHERE grant_id = ?) + ? <= max_jobs
     AND used_tokens - (SELECT COALESCE(SUM(tokens), 0) FROM routing_refunds WHERE grant_id = ?) + ? <= max_tokens`,
    jobs, tokens, grantId, grantId, jobs, grantId, tokens);
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
 * Release every held reservation for one op. Each refund is an INSERT OR
 * IGNORE receipt (the quota effect, idempotent by primary key) followed by
 * the terminal state flip (the bookkeeping). A crash before the receipt
 * leaves a fully charged held row; a crash after it leaves a refunded row
 * a retry completes without re-applying; concurrent releasers share the
 * one receipt and elect one flip winner. The receipt row is the durable
 * recovery evidence: net usage is always gross minus receipts, so state
 * and counters can never disagree twice. Idempotent. Returns rows moved.
 */
export async function releaseCapacity(db, { opId, reason = 'release', nowMs = null } = {}) {
  if (typeof opId !== 'string' || !opId) throw new Error('opId required.');
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const iso = new Date(now).toISOString();
  const held = await db.prepare("SELECT * FROM routing_reservations WHERE op_id = ? AND state = 'held'").bind(opId).all();
  let n = 0;
  for (const r of (held.results || [])) {
    n += await receiptAndFlip(db, r, 'released', iso);
  }
  return n;
}

/**
 * Release held reservations past their TTL. Same receipt-then-flip as
 * release; racing release and sweep share one receipt. Returns rows moved.
 */
export async function sweepReservations(db, nowMs = null) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const iso = new Date(now).toISOString();
  const stale = await db.prepare("SELECT * FROM routing_reservations WHERE state = 'held' AND expires_at < ?").bind(iso).all();
  let n = 0;
  for (const r of (stale.results || [])) {
    n += await receiptAndFlip(db, r, 'expired', iso);
  }
  return n;
}

async function receiptAndFlip(db, r, toState, iso) {
  await run(db, 'INSERT OR IGNORE INTO routing_refunds (reservation_id, grant_id, jobs, tokens, created_at) VALUES (?, ?, ?, ?, ?)',
    r.id, r.grant_id, r.jobs, r.tokens, iso);
  const flip = await run(db, 'UPDATE routing_reservations SET state = ?, updated_at = ? WHERE id = ? AND state = \'held\'', toState, iso, r.id);
  return Number(flip.meta.changes) === 1 ? 1 : 0;
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

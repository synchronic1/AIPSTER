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

function exhausted() {
  return httpError(429, 'Grant capacity exhausted for this route.', 'ROUTE_CAPACITY_EXHAUSTED');
}

/**
 * Atomically hold jobs+tokens on one grant for one op.
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
  const res = await run(db,
    `UPDATE grants SET used_jobs = used_jobs + ?, used_tokens = used_tokens + ?
     WHERE id = ? AND revoked_at IS NULL AND used_jobs + ? <= max_jobs AND used_tokens + ? <= max_tokens`,
    jobs, tokens, grantId, jobs, tokens);
  if (Number(res.meta.changes) !== 1) {
    const again = await first(db, 'SELECT revoked_at FROM grants WHERE id = ?', grantId);
    if (!again || again.revoked_at !== null) throw httpError(409, 'Grant revoked or missing.', 'ROUTE_CAPACITY_REVOKED');
    throw exhausted();
  }
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const id = rid('rsv_');
  await run(db,
    'INSERT INTO routing_reservations (id, op_id, tenant_id, grant_id, jobs, tokens, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, opId, tenant, grantId, jobs, tokens, 'held', new Date(now).toISOString(), new Date(now + ttlMs).toISOString());
  return { id, opId, tenant, grantId, jobs, tokens, state: 'held' };
}

/** Release every held reservation for one op. Idempotent. Returns count. */
export async function releaseCapacity(db, { opId, reason = 'release' } = {}) {
  if (typeof opId !== 'string' || !opId) throw new Error('opId required.');
  const held = await db.prepare("SELECT * FROM routing_reservations WHERE op_id = ? AND state = 'held'").bind(opId).all();
  let n = 0;
  for (const r of (held.results || [])) {
    await run(db, 'UPDATE grants SET used_jobs = MAX(0, used_jobs - ?), used_tokens = MAX(0, used_tokens - ?) WHERE id = ?', r.jobs, r.tokens, r.grant_id);
    await run(db, "UPDATE routing_reservations SET state = 'released' WHERE id = ? AND state = 'held'", r.id);
    n += 1;
  }
  return n;
}

/** Release held reservations past their TTL. Returns rows released. */
export async function sweepReservations(db, nowMs = null) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const iso = new Date(now).toISOString();
  const stale = await db.prepare("SELECT * FROM routing_reservations WHERE state = 'held' AND expires_at < ?").bind(iso).all();
  let n = 0;
  for (const r of (stale.results || [])) {
    await run(db, 'UPDATE grants SET used_jobs = MAX(0, used_jobs - ?), used_tokens = MAX(0, used_tokens - ?) WHERE id = ?', r.jobs, r.tokens, r.grant_id);
    await run(db, "UPDATE routing_reservations SET state = 'expired' WHERE id = ? AND state = 'held'", r.id);
    n += 1;
  }
  return n;
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

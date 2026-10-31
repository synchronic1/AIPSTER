/* Built with Meta Muse. */
// Per-user write quotas for public registration: a fixed hourly write
// budget plus per-object caps, so one account cannot exhaust shared D1
// storage/quota. Admission is atomic: the budget claim is ONE conditional
// UPDATE (increment only if under the limit), so concurrent racers
// serialize in SQLite/D1 and exactly LIMIT claims succeed — no
// check-then-act race. Rejections are read-only (a spent budget throws
// before any write; a lost racer mutates nothing). Callers enforce object
// caps the same way with conditional INSERT...SELECT (see worker.js).
// Bucket cleanup runs only when a request opens a fresh hourly bucket
// (once per user per hour), never on the rejection path.
import { first, run } from './store.js';
import { httpError } from './validate.js';

export const WRITE_BUDGET_PER_HOUR = 120;
export const MAX_RESOURCES_PER_USER = 100;
export const MAX_KEYS_PER_USER = 20; // active (non-revoked)
export const MAX_GRANTS_PER_USER = 100; // active (non-revoked), outgoing
export const MAX_ACTIVE_UPLOADS_PER_USER = 20; // uploading/quarantined/validating sessions

export function budgetWindow(now = new Date()) {
  return now.toISOString().slice(0, 13); // UTC hour bucket: '2026-10-28T16'
}

// ---- heartbeat intake budgets (docs/heartbeat-quotas.md) ----
// Per-owner AND deployment-wide hourly ceilings on ACCEPTED heartbeats.
// Admission is ONE D1 batch (a transaction): the resource UPDATE carries
// both cap checks, and each counter upsert is conditional on changes() = 1
// from the statement before it. A request is either accepted and charged to
// both buckets exactly once, or rejected with zero rows written; nothing is
// ever claimed and refunded. Counters live in SEPARATE buckets: the
// window key prefix keeps heartbeat counters apart from the 120/hour
// write_budget rows even though they share the write_budget TABLE, so no
// migration is needed and neither budget draws from the other.
// PLACEHOLDER defaults: production numbers are chosen by the user +
// release review, never by this change. Env overrides (positive integers):
// HEARTBEAT_OWNER_PER_HOUR, HEARTBEAT_GLOBAL_PER_HOUR.
export const HEARTBEAT_OWNER_PER_HOUR_PLACEHOLDER = 500;
export const HEARTBEAT_GLOBAL_PER_HOUR_PLACEHOLDER = 1000;
// Reserved write_budget.user_id for the deployment-wide bucket. Real user
// ids never contain ':', so this row cannot collide with a tenant bucket.
export const HEARTBEAT_GLOBAL_ID = 'heartbeat:global';

export function heartbeatWindow(now = new Date()) {
  return 'hb/' + budgetWindow(now);
}

function parseBudget(raw, fallback) {
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function heartbeatBudgets(env) {
  return {
    owner: parseBudget(env && env.HEARTBEAT_OWNER_PER_HOUR, HEARTBEAT_OWNER_PER_HOUR_PLACEHOLDER),
    global: parseBudget(env && env.HEARTBEAT_GLOBAL_PER_HOUR, HEARTBEAT_GLOBAL_PER_HOUR_PLACEHOLDER),
  };
}

export function secondsUntilNextHour(nowMs = Date.now()) {
  const next = new Date(nowMs);
  next.setUTCMinutes(60, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - nowMs) / 1000));
}

// Cap predicate for the resource UPDATE inside the admission batch. Binds:
// owner id, window, owner cap, window, global cap.
export const HEARTBEAT_CAPS_SQL =
  `COALESCE((SELECT count FROM write_budget WHERE user_id = ? AND window = ?), 0) < ?
   AND COALESCE((SELECT count FROM write_budget WHERE user_id = '${HEARTBEAT_GLOBAL_ID}' AND window = ?), 0) < ?`;

// The two counter statements that follow the resource UPDATE in the same
// batch. Each runs only when the statement before it changed exactly one
// row, so the counters move together with an accepted heartbeat or not at
// all. The upsert creates the hourly bucket on first use. `unconditional`
// drops the changes() gate; the worker uses it only to complete the charge
// of a heartbeat the batch has already committed.
export function heartbeatCounterStatements(db, ownerId, window, { unconditional = false } = {}) {
  const upsert = `INSERT INTO write_budget (user_id, window, count) SELECT ?, ?, 1 WHERE ${unconditional ? '1' : 'changes() = 1'}
     ON CONFLICT (user_id, window) DO UPDATE SET count = count + 1`;
  return [db.prepare(upsert).bind(ownerId, window), db.prepare(upsert).bind(HEARTBEAT_GLOBAL_ID, window)];
}

// Drop past hourly heartbeat buckets. Called only while the current global
// bucket does not exist yet, i.e. before the first accepted heartbeat of the
// hour; it deletes zero rows on every later call in that state.
export async function pruneHeartbeatBuckets(db, window) {
  await run(db, "DELETE FROM write_budget WHERE window LIKE 'hb/%' AND window < ?", window);
}

// Read-only bucket count (null when the bucket does not exist yet). Used
// for fast-path rejections and to name the reason after a lost admission;
// the batch still decides races.
export async function heartbeatBucketCount(db, id, window) {
  const row = await first(db, 'SELECT count FROM write_budget WHERE user_id = ? AND window = ?', id, window);
  return row ? Number(row.count) : null;
}

export async function checkWriteBudget(db, userId) {
  const window = budgetWindow();
  const row = await first(db, 'SELECT count FROM write_budget WHERE user_id = ? AND window = ?', userId, window);
  if (row && Number(row.count) >= WRITE_BUDGET_PER_HOUR) {
    // Spent budget: read-only rejection, no D1 write.
    throw httpError(429, 'Too many changes in the last hour. Try again later.', 'WRITE_RATE_LIMITED');
  }
  if (!row) {
    // Fresh hourly bucket: OR IGNORE keeps a concurrent opener from
    // erroring, and cleanup runs here (once per user per hour).
    await run(db, 'INSERT OR IGNORE INTO write_budget (user_id, window, count) VALUES (?, ?, 0)', userId, window);
    await run(db, 'DELETE FROM write_budget WHERE window < ?', budgetWindow(new Date(Date.now() - 3600 * 1000)));
  }
  // Atomic claim: increment and limit test in ONE statement. Concurrent
  // racers serialize; losers get changes = 0 and mutate nothing.
  const claim = await run(db, 'UPDATE write_budget SET count = count + 1 WHERE user_id = ? AND window = ? AND count < ?', userId, window, WRITE_BUDGET_PER_HOUR);
  if (Number(claim.meta.changes) !== 1) {
    throw httpError(429, 'Too many changes in the last hour. Try again later.', 'WRITE_RATE_LIMITED');
  }
}

// Cap errors for conditional inserts: callers run INSERT...SELECT...WHERE
// (SELECT COUNT...) < LIMIT and throw the matching error when the insert
// claims zero rows. The count test lives inside the single mutating
// statement, so parallel creates cannot overshoot the cap.
export function capError(kind) {
  if (kind === 'key') return httpError(409, `Active API key limit reached (${MAX_KEYS_PER_USER} per user). Revoke an old key first.`, 'KEY_LIMIT');
  if (kind === 'grant') return httpError(409, `Active grant limit reached (${MAX_GRANTS_PER_USER} per user).`, 'GRANT_LIMIT');
  if (kind === 'upload') return httpError(409, `Active upload session limit reached (${MAX_ACTIVE_UPLOADS_PER_USER} per user). Finish or expire one first.`, 'UPLOAD_LIMIT');
  return httpError(409, `Resource limit reached (${MAX_RESOURCES_PER_USER} per user).`, 'RESOURCE_LIMIT');
}

export function assertClaimed(res, kind) {
  if (!res || Number(res.meta.changes) !== 1) throw capError(kind);
}

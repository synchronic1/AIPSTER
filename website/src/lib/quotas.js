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

export function budgetWindow(now = new Date()) {
  return now.toISOString().slice(0, 13); // UTC hour bucket: '2026-10-28T16'
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
  return httpError(409, `Resource limit reached (${MAX_RESOURCES_PER_USER} per user).`, 'RESOURCE_LIMIT');
}

export function assertClaimed(res, kind) {
  if (!res || Number(res.meta.changes) !== 1) throw capError(kind);
}

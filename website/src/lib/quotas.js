/* Built with Meta Muse. */
// Per-user write quotas for public registration: a fixed hourly write
// budget plus per-object caps, so one account cannot exhaust shared D1
// storage/quota. Best-effort abuse throttles, not billing: a rejected
// request performs no D1 write at all (check-first on a plain SELECT),
// while admitted requests may slightly over-admit under concurrency (two
// racers can both pass the same under-limit read). Bucket cleanup runs
// only when a request opens a fresh hourly bucket (once per user per
// hour), never on the rejection path.
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
    // Rejection path: a read only, no D1 write, so hammering a spent
    // budget cannot itself consume database writes.
    throw httpError(429, 'Too many changes in the last hour. Try again later.', 'WRITE_RATE_LIMITED');
  }
  if (!row) {
    // Fresh hourly bucket: OR IGNORE keeps a concurrent opener from
    // erroring, and cleanup runs here (once per user per hour).
    await run(db, 'INSERT OR IGNORE INTO write_budget (user_id, window, count) VALUES (?, ?, 0)', userId, window);
    await run(db, 'DELETE FROM write_budget WHERE window < ?', budgetWindow(new Date(Date.now() - 3600 * 1000)));
  }
  await run(db, 'UPDATE write_budget SET count = count + 1 WHERE user_id = ? AND window = ?', userId, window);
}

export async function checkObjectCap(db, kind, ownerId) {
  if (kind === 'resource') {
    const row = await first(db, 'SELECT COUNT(*) AS n FROM resources WHERE owner_id = ?', ownerId);
    if (row && Number(row.n) >= MAX_RESOURCES_PER_USER) {
      throw httpError(409, `Resource limit reached (${MAX_RESOURCES_PER_USER} per user).`, 'RESOURCE_LIMIT');
    }
  } else if (kind === 'key') {
    const row = await first(db, 'SELECT COUNT(*) AS n FROM key_verifiers WHERE owner_id = ? AND revoked_at IS NULL', ownerId);
    if (row && Number(row.n) >= MAX_KEYS_PER_USER) {
      throw httpError(409, `Active API key limit reached (${MAX_KEYS_PER_USER} per user). Revoke an old key first.`, 'KEY_LIMIT');
    }
  } else if (kind === 'grant') {
    const row = await first(db, 'SELECT COUNT(*) AS n FROM grants WHERE owner_id = ? AND revoked_at IS NULL', ownerId);
    if (row && Number(row.n) >= MAX_GRANTS_PER_USER) {
      throw httpError(409, `Active grant limit reached (${MAX_GRANTS_PER_USER} per user).`, 'GRANT_LIMIT');
    }
  }
}

/* Built with Meta Muse. */
// Per-user write quotas for public registration: a fixed hourly write
// budget plus per-object caps, so one account cannot exhaust shared D1
// storage/quota. Best-effort abuse throttles, not billing: increments are
// atomic (single UPSERT) but the limit check is approximate under
// concurrency (slight over-admission possible, never under-).
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
  await run(db, `INSERT INTO write_budget (user_id, window, count) VALUES (?, ?, 1)
    ON CONFLICT (user_id, window) DO UPDATE SET count = count + 1`, userId, window);
  // Opportunistic cleanup: keep only the current and previous buckets.
  await run(db, 'DELETE FROM write_budget WHERE window < ?', budgetWindow(new Date(Date.now() - 3600 * 1000)));
  const row = await first(db, 'SELECT count FROM write_budget WHERE user_id = ? AND window = ?', userId, window);
  if (row && Number(row.count) > WRITE_BUDGET_PER_HOUR) {
    throw httpError(429, 'Too many changes in the last hour. Try again later.', 'WRITE_RATE_LIMITED');
  }
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

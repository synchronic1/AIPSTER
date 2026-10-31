/* Built with Meta Muse. */
// Routing advice budgets: atomic tenant/global hourly rate + token budgets
// on write_budget route/ + route-tok/ prefixes. Same staleness-validated
// pattern as the adviser gate (no timestamp survives pre-batch async work):
// the gate refuses any hour older than the newest bucket present, pruning
// runs only after admission, and stale decisions retry bounded or fail
// closed. No op table here: advice calls are read-only rankings, budgets
// charge conservative maxima, and reservations are never refunded.
// (Durable op ledger arrives with Milestone C admission.)
import { httpError } from '../lib/validate.js';
import { first, run } from '../lib/store.js';

const num = (v, fb) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : fb);

export function routeBudgets(env = {}) {
  return {
    reqOwner: num(env.ROUTING_ADVICE_PER_HOUR, 10),
    reqGlobal: num(env.ROUTING_ADVICE_GLOBAL_PER_HOUR, 100),
    tokOwner: num(env.ROUTING_ADVICE_TOKENS_PER_HOUR, 20000),
    tokGlobal: num(env.ROUTING_ADVICE_GLOBAL_TOKENS_PER_HOUR, 200000),
  };
}

export const routeWindow = (d) => `route/${d.toISOString().slice(0, 13)}`;
export const routeTokWindow = (d) => `route-tok/${d.toISOString().slice(0, 13)}`;

function chargeStmt(db, id, win, amount) {
  return db.prepare(
    `INSERT INTO write_budget (user_id, window, count) SELECT ?, ?, ? WHERE changes() = 1
     ON CONFLICT (user_id, window) DO UPDATE SET count = count + excluded.count`
  ).bind(id, win, amount);
}

/**
 * Atomically admit one advice call: all four tenant/global request/token
 * charges commit together or none do. Throws 429 on exhaustion/staleness.
 */
export async function claimAdviceBudget(db, tenant, { inputTokens = 0, outputTokens = 0, env = null, clock = null } = {}) {
  if (typeof tenant !== 'string' || tenant.length === 0) throw new Error('tenant required.');
  const clockFn = typeof clock === 'function' ? clock : () => new Date();
  const budgets = routeBudgets(env || {});
  const reserve = (Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? inputTokens : 0)
    + (Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? outputTokens : 0);
  for (let attempt = 0; attempt < 3; attempt++) {
    const at = clockFn();
    const reqWin = routeWindow(at);
    const tokWin = routeTokWindow(at);
    // The first charge doubles as the gate: budget checks, same-hour
    // freshness (no newer buckets), then the charge itself — atomic.
    const gate = db.prepare(
      `INSERT INTO write_budget (user_id, window, count) SELECT ?, ?, 1 WHERE
       COALESCE((SELECT count FROM write_budget WHERE user_id = ? AND window = ?), 0) < ?
       AND COALESCE((SELECT count FROM write_budget WHERE user_id = 'route:global' AND window = ?), 0) < ?
       AND COALESCE((SELECT count FROM write_budget WHERE user_id = ? AND window = ?), 0) + ? <= ?
       AND COALESCE((SELECT count FROM write_budget WHERE user_id = 'route:global' AND window = ?), 0) + ? <= ?
       AND NOT EXISTS (SELECT 1 FROM write_budget WHERE window LIKE 'route/%' AND window > ?)
       AND NOT EXISTS (SELECT 1 FROM write_budget WHERE window LIKE 'route-tok/%' AND window > ?)
       ON CONFLICT (user_id, window) DO UPDATE SET count = count + 1`
    ).bind(tenant, reqWin, tenant, reqWin, budgets.reqOwner, reqWin, budgets.reqGlobal,
      tenant, tokWin, reserve, budgets.tokOwner, tokWin, reserve, budgets.tokGlobal, reqWin, tokWin);
    let results;
    try {
      results = await db.batch([gate,
        chargeStmt(db, 'route:global', reqWin, 1),
        chargeStmt(db, tenant, tokWin, reserve),
        chargeStmt(db, 'route:global', tokWin, reserve)]);
    } catch {
      results = null;
    }
    if (results && Number(results[0].meta.changes) === 1) {
      try {
        await run(db, "DELETE FROM write_budget WHERE window LIKE 'route/%' AND window < ?", reqWin);
        await run(db, "DELETE FROM write_budget WHERE window LIKE 'route-tok/%' AND window < ?", tokWin);
      } catch { /* hygiene only; next admission re-prunes */ }
      return { outcome: 'claimed' };
    }
    const newer = await first(db, "SELECT 1 AS x FROM write_budget WHERE (window LIKE 'route/%' AND window > ?) OR (window LIKE 'route-tok/%' AND window > ?) LIMIT 1", reqWin, tokWin);
    if (newer) {
      if (attempt < 2) continue;
      throw httpError(429, 'Advice budgets rolled to a new hour during admission. Retry.', 'ROUTE_ADVICE_STALE');
    }
    const spent = async (id, win, cap, add) => {
      const r = await first(db, 'SELECT count FROM write_budget WHERE user_id = ? AND window = ?', id, win);
      return Number(r ? r.count : 0) + add > cap;
    };
    if (await spent(tenant, tokWin, budgets.tokOwner, reserve) || await spent('route:global', tokWin, budgets.tokGlobal, reserve)) {
      throw httpError(429, 'Advice token budget for this hour is exhausted.', 'ROUTE_ADVICE_TOKEN_BUDGET');
    }
    throw httpError(429, 'Advice request budget for this hour is exhausted.', 'ROUTE_ADVICE_REQUEST_BUDGET');
  }
  throw httpError(429, 'Advice budgets rolled to a new hour during admission. Retry.', 'ROUTE_ADVICE_STALE');
}

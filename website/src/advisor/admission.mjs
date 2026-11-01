/* Built with Meta Muse. */
// Fabric adviser admission: atomic tenant+deployment request/token budgets
// plus the op state machine (idempotency + uncertain outcomes). No migration
// beyond advisor_ops: counters reuse write_budget with dedicated window
// prefixes, mirroring the heartbeat precedent (separate buckets, same
// table). One D1 batch commits the op claim together with every charge — a
// request is admitted and charged exactly once, or rejected with zero rows
// written. Nothing is ever claimed and refunded.
//
// Per-tenant rows stay bounded: hourly request budgets cap new rows, and
// every claim prunes own terminal rows older than 24h plus leaked
// reserved/fetching rows older than 1h (no legitimate call lives that
// long; live calls cap at 20s). Uncertain rows are never auto-pruned: the
// no-duplicate-charge guarantee for lost live responses is durable.
// write_budget buckets are created only by admitted claims (the charging
// upsert) and every ADMITTED claim prunes expired adv/ + adv-tok/ buckets,
// so the shared table cannot grow without bound from rejected or idle
// hours. Pruning after (never before) the gate is load-bearing: the gate
// refuses any hour older than the newest bucket present, which is exactly
// the set a prune could have deleted — so a judged hour's counters are
// always intact, and stale decisions retry instead of misreading zeros.
import { first, run, nowIso } from '../lib/store.js';
import { httpError } from '../lib/validate.js';
import { budgetWindow } from '../lib/quotas.js';

export const ADVISOR_GLOBAL_ID = 'advisor:global';
// PLACEHOLDER defaults: production numbers are chosen by the release
// review, never by this change. Env overrides (positive integers):
// ADVISOR_OWNER_PER_HOUR, ADVISOR_GLOBAL_PER_HOUR,
// ADVISOR_OWNER_TOKENS_PER_HOUR, ADVISOR_GLOBAL_TOKENS_PER_HOUR.
export const ADVISOR_OWNER_PER_HOUR_PLACEHOLDER = 20;
export const ADVISOR_GLOBAL_PER_HOUR_PLACEHOLDER = 200;
export const ADVISOR_OWNER_TOKENS_PER_HOUR_PLACEHOLDER = 50000;
export const ADVISOR_GLOBAL_TOKENS_PER_HOUR_PLACEHOLDER = 500000;
export const ADVISOR_RECEIPT_MAX = 4096;
const OP_TTL_MS = 24 * 3600 * 1000;
const LEAK_TTL_MS = 3600 * 1000;

export function advisorWindow(now = new Date()) {
  return 'adv/' + budgetWindow(now);
}

export function advisorTokWindow(now = new Date()) {
  return 'adv-tok/' + budgetWindow(now);
}

function parseBudget(raw, fallback) {
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function advisorBudgets(env) {
  const e = env || {};
  return {
    reqOwner: parseBudget(e.ADVISOR_OWNER_PER_HOUR, ADVISOR_OWNER_PER_HOUR_PLACEHOLDER),
    reqGlobal: parseBudget(e.ADVISOR_GLOBAL_PER_HOUR, ADVISOR_GLOBAL_PER_HOUR_PLACEHOLDER),
    tokOwner: parseBudget(e.ADVISOR_OWNER_TOKENS_PER_HOUR, ADVISOR_OWNER_TOKENS_PER_HOUR_PLACEHOLDER),
    tokGlobal: parseBudget(e.ADVISOR_GLOBAL_TOKENS_PER_HOUR, ADVISOR_GLOBAL_TOKENS_PER_HOUR_PLACEHOLDER),
  };
}

/** Production spend cap in USD. Defaults to zero: live calls need explicit budget. */
export function advisorSpendCapUsd(env) {
  const raw = env ? env.ADVISOR_SPEND_CAP_USD : undefined;
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function chargeStmt(db, id, window, amount) {
  // Chained on changes() = 1 like the heartbeat counters: the charge lands
  // only when the statement before it (gate, then each prior charge)
  // changed exactly one row, so all charges commit with an admitted op or
  // none do. The upsert creates the hourly bucket on first admitted use,
  // so rejections write nothing — not even empty rows.
  return db.prepare(
    `INSERT INTO write_budget (user_id, window, count) SELECT ?, ?, ? WHERE changes() = 1
     ON CONFLICT (user_id, window) DO UPDATE SET count = count + excluded.count`
  ).bind(id, window, amount);
}

async function existingOp(db, tenant, opKey) {
  return first(db, 'SELECT op_key, input_digest, state, receipt_json FROM advisor_ops WHERE tenant_id = ? AND op_key = ?', tenant, opKey);
}

function fromRow(row, digest) {
  if (row.input_digest !== digest) throw httpError(409, 'Idempotency key was already used with a different request.', 'CHANGED_REPLAY');
  if (row.state === 'delivered' || row.state === 'failed') {
    let receipt = null;
    try { receipt = row.receipt_json ? JSON.parse(row.receipt_json) : null; } catch { receipt = null; }
    return { outcome: 'replay', state: row.state, receipt };
  }
  if (row.state === 'uncertain') {
    let receipt = null;
    try { receipt = row.receipt_json ? JSON.parse(row.receipt_json) : null; } catch { receipt = null; }
    return { outcome: 'uncertain', receipt };
  }
  return { outcome: 'in-progress' };
}

/**
 * Claim an adviser operation: atomic op-row insert plus tenant/global
 * request and token charges. inputTokens is the conservative input
 * estimate; outputTokens reserves the provider output maximum.
 * Returns {outcome:'claimed'} or a replay/in-progress/uncertain outcome;
 * throws 409/429 otherwise. Never double-charges, never refunds.
 *
 * Rollover safety: no timestamp survives the async work before the atomic
 * batch, so the gate VALIDATES its own window instead of trusting one
 * computed earlier. The gate admits in hour H only when no newer advisor
 * bucket exists; bucket pruning runs only after a successful admission.
 * Together: pruned hours always have newer buckets present, so a decision
 * can never judge deleted (zero-read) counters — it goes stale and retries
 * with a fresh instant (bounded), or fails closed. `clock` supplies the
 * decision instant per attempt (tests pin it); without one, pinned `now`
 * is reused every attempt.
 */
export async function claimOp(db, tenant, opKey, digest, { inputTokens = 0, outputTokens = 0, env = null, now = new Date(), clock = null } = {}) {
  const found = await existingOp(db, tenant, opKey);
  if (found) return fromRow(found, digest);
  const clockFn = typeof clock === 'function' ? clock : () => now;
  const budgets = advisorBudgets(env);
  const reserve = (Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? inputTokens : 0)
    + (Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? outputTokens : 0);
  for (let attempt = 0; attempt < 3; attempt++) {
    const atDate = clockFn();
    const reqWin = advisorWindow(atDate);
    const tokWin = advisorTokWindow(atDate);
    // Bounded op hygiene before claiming (see module header). Bucket
    // pruning deliberately runs only AFTER admission (below): a pre-gate
    // prune could delete the hour a concurrent gate is judging.
    await run(db, "DELETE FROM advisor_ops WHERE tenant_id = ? AND state IN ('delivered','failed') AND created_at < ?",
      tenant, new Date(atDate.getTime() - OP_TTL_MS).toISOString());
    await run(db, "DELETE FROM advisor_ops WHERE tenant_id = ? AND state IN ('reserved','fetching') AND created_at < ?",
      tenant, new Date(atDate.getTime() - LEAK_TTL_MS).toISOString());
    const gate = db.prepare(
      `INSERT INTO advisor_ops (tenant_id, op_key, input_digest, state, receipt_json, created_at, updated_at)
       SELECT ?, ?, ?, 'reserved', NULL, ?, ? WHERE
       COALESCE((SELECT count FROM write_budget WHERE user_id = ? AND window = ?), 0) < ?
       AND COALESCE((SELECT count FROM write_budget WHERE user_id = '${ADVISOR_GLOBAL_ID}' AND window = ?), 0) < ?
       AND COALESCE((SELECT count FROM write_budget WHERE user_id = ? AND window = ?), 0) + ? <= ?
       AND COALESCE((SELECT count FROM write_budget WHERE user_id = '${ADVISOR_GLOBAL_ID}' AND window = ?), 0) + ? <= ?
       AND NOT EXISTS (SELECT 1 FROM advisor_ops WHERE tenant_id = ? AND op_key = ?)
       AND NOT EXISTS (SELECT 1 FROM advisor_ops WHERE tenant_id = ? AND state IN ('reserved','fetching'))
       AND NOT EXISTS (SELECT 1 FROM write_budget WHERE window LIKE 'adv/%' AND window > ?)
       AND NOT EXISTS (SELECT 1 FROM write_budget WHERE window LIKE 'adv-tok/%' AND window > ?)`
    ).bind(tenant, opKey, digest, atDate.toISOString(), atDate.toISOString(),
      tenant, reqWin, budgets.reqOwner,
      reqWin, budgets.reqGlobal,
      tenant, tokWin, reserve, budgets.tokOwner,
      tokWin, reserve, budgets.tokGlobal,
      tenant, opKey, tenant,
      reqWin, tokWin);
    let results;
    try {
      results = await db.batch([gate,
        chargeStmt(db, tenant, reqWin, 1),
        chargeStmt(db, ADVISOR_GLOBAL_ID, reqWin, 1),
        chargeStmt(db, tenant, tokWin, reserve),
        chargeStmt(db, ADVISOR_GLOBAL_ID, tokWin, reserve)]);
    } catch {
      // Lost a concurrent race (PK or otherwise): fall through to the same
      // disambiguation as a clean gate miss. No partial rows survive: the
      // batch is atomic and every charge chains on the gate.
      results = null;
    }
    if (results && Number(results[0].meta.changes) === 1) {
      // Admitted: now prune hours older than the judged hour. Best-effort
      // on purpose — admission already committed, so a prune failure must
      // not fail the claim; the next admitted claim re-prunes. Each prefix
      // is bounded by its own window ('adv-tok/…' sorts before 'adv/…').
      try {
        await run(db, "DELETE FROM write_budget WHERE window LIKE 'adv/%' AND window < ?", reqWin);
        await run(db, "DELETE FROM write_budget WHERE window LIKE 'adv-tok/%' AND window < ?", tokWin);
      } catch { /* hygiene only; next admission re-prunes */ }
      return { outcome: 'claimed' };
    }
    // Gate missed: map the cause with best-effort reads. Every mapping is
    // a 409/429 that never duplicates a charge; races may mislabel which
    // bound bit, never whether the call may proceed. Staleness is checked
    // before any budget read: a stale hour's counters may be pruned, so
    // only the op-table checks (key/sibling, never pruned by the hour)
    // may precede it.
    const raced = await existingOp(db, tenant, opKey);
    if (raced) return fromRow(raced, digest);
    const flying = await first(db, "SELECT op_key FROM advisor_ops WHERE tenant_id = ? AND state IN ('reserved','fetching')", tenant);
    if (flying) throw httpError(429, 'Another advice request is already in flight. Retry shortly with the same key.', 'OP_IN_FLIGHT');
    const newer = await first(db, "SELECT 1 AS x FROM write_budget WHERE (window LIKE 'adv/%' AND window > ?) OR (window LIKE 'adv-tok/%' AND window > ?) LIMIT 1", reqWin, tokWin);
    if (newer) {
      if (attempt < 2) continue;
      throw httpError(429, 'Advice budgets rolled to a new hour during admission. Retry.', 'STALE_ADMISSION_WINDOW');
    }
    const spent = async (id, win, cap, add) => {
      const r = await first(db, 'SELECT count FROM write_budget WHERE user_id = ? AND window = ?', id, win);
      return Number(r ? r.count : 0) + add > cap;
    };
    if (await spent(tenant, tokWin, budgets.tokOwner, reserve) || await spent(ADVISOR_GLOBAL_ID, tokWin, budgets.tokGlobal, reserve)) {
      throw httpError(429, 'Advice token budget for this hour is exhausted.', 'TOKEN_BUDGET');
    }
    throw httpError(429, 'Advice request budget for this hour is exhausted.', 'REQUEST_BUDGET');
  }
  throw httpError(429, 'Advice budgets rolled to a new hour during admission. Retry.', 'STALE_ADMISSION_WINDOW');
}

/** Conditional state transition; only the listed from-states may move. */
export async function markOp(db, tenant, opKey, fromStates, to, receipt = null) {
  const blob = receipt === null || receipt === undefined ? null : JSON.stringify(receipt);
  if (blob !== null && blob.length > ADVISOR_RECEIPT_MAX) throw httpError(500, 'Receipt exceeds storage bound.', 'RECEIPT_TOO_LARGE');
  const res = await run(db,
    `UPDATE advisor_ops SET state = ?, receipt_json = COALESCE(?, receipt_json), updated_at = ?
     WHERE tenant_id = ? AND op_key = ? AND state IN (${fromStates.map(() => '?').join(',')})`,
    to, blob, nowIso(), tenant, opKey, ...fromStates);
  return { ok: Number(res.meta.changes) === 1 };
}

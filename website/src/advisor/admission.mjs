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
// upsert) and every claim prunes expired adv/ + adv-tok/ buckets, so the
// shared table cannot grow without bound from rejected or idle hours.
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
 */
export async function claimOp(db, tenant, opKey, digest, { inputTokens = 0, outputTokens = 0, env = null, now = new Date() } = {}) {
  const found = await existingOp(db, tenant, opKey);
  if (found) return fromRow(found, digest);
  const at = now.toISOString();
  const budgets = advisorBudgets(env);
  const reqWin = advisorWindow(now);
  const tokWin = advisorTokWindow(now);
  const reserve = (Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? inputTokens : 0)
    + (Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? outputTokens : 0);
  // Bounded hygiene before claiming (see module header): stale ops plus
  // expired advisor buckets. Each prefix is bounded by its own current
  // window ('adv-tok/…' sorts before 'adv/…', so one bound cannot cover
  // both). The current hour is never pruned.
  await run(db, "DELETE FROM advisor_ops WHERE tenant_id = ? AND state IN ('delivered','failed') AND created_at < ?",
    tenant, new Date(now.getTime() - OP_TTL_MS).toISOString());
  await run(db, "DELETE FROM advisor_ops WHERE tenant_id = ? AND state IN ('reserved','fetching') AND created_at < ?",
    tenant, new Date(now.getTime() - LEAK_TTL_MS).toISOString());
  await run(db, "DELETE FROM write_budget WHERE window LIKE 'adv/%' AND window < ?", reqWin);
  await run(db, "DELETE FROM write_budget WHERE window LIKE 'adv-tok/%' AND window < ?", tokWin);
  const gate = db.prepare(
    `INSERT INTO advisor_ops (tenant_id, op_key, input_digest, state, receipt_json, created_at, updated_at)
     SELECT ?, ?, ?, 'reserved', NULL, ?, ? WHERE
     COALESCE((SELECT count FROM write_budget WHERE user_id = ? AND window = ?), 0) < ?
     AND COALESCE((SELECT count FROM write_budget WHERE user_id = '${ADVISOR_GLOBAL_ID}' AND window = ?), 0) < ?
     AND COALESCE((SELECT count FROM write_budget WHERE user_id = ? AND window = ?), 0) + ? <= ?
     AND COALESCE((SELECT count FROM write_budget WHERE user_id = '${ADVISOR_GLOBAL_ID}' AND window = ?), 0) + ? <= ?
     AND NOT EXISTS (SELECT 1 FROM advisor_ops WHERE tenant_id = ? AND op_key = ?)
     AND NOT EXISTS (SELECT 1 FROM advisor_ops WHERE tenant_id = ? AND state IN ('reserved','fetching'))`
  ).bind(tenant, opKey, digest, at, at,
    tenant, reqWin, budgets.reqOwner,
    reqWin, budgets.reqGlobal,
    tenant, tokWin, reserve, budgets.tokOwner,
    tokWin, reserve, budgets.tokGlobal,
    tenant, opKey, tenant);
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
  if (results && Number(results[0].meta.changes) === 1) return { outcome: 'claimed' };
  // Gate missed: map the cause with best-effort reads. Every mapping is a
  // 409/429 that never duplicates a charge; races may mislabel which bound
  // bit, never whether the call may proceed.
  const raced = await existingOp(db, tenant, opKey);
  if (raced) return fromRow(raced, digest);
  const flying = await first(db, "SELECT op_key FROM advisor_ops WHERE tenant_id = ? AND state IN ('reserved','fetching')", tenant);
  if (flying) throw httpError(429, 'Another advice request is already in flight. Retry shortly with the same key.', 'OP_IN_FLIGHT');
  const spent = async (id, win, cap, add) => {
    const r = await first(db, 'SELECT count FROM write_budget WHERE user_id = ? AND window = ?', id, win);
    return Number(r ? r.count : 0) + add > cap;
  };
  if (await spent(tenant, tokWin, budgets.tokOwner, reserve) || await spent(ADVISOR_GLOBAL_ID, tokWin, budgets.tokGlobal, reserve)) {
    throw httpError(429, 'Advice token budget for this hour is exhausted.', 'TOKEN_BUDGET');
  }
  throw httpError(429, 'Advice request budget for this hour is exhausted.', 'REQUEST_BUDGET');
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

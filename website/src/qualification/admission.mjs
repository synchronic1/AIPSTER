/* Built with Meta Muse. Meta-qualification lane (meta-qual). */
/* Atomic admission: the reservation INSERT carries every quota condition, so
   concurrent distinct keys cannot bypass caps; all charges are gated off the
   successful reservation in the same D1 batch. A request is admitted and
   charged exactly once, or rejected with zero spend rows written. Counter
   probes are classification-only: any probe failure refuses closed. */
import { first, nowIso } from '../lib/store.js';
import { httpError } from '../lib/validate.js';
import { budgetWindow } from '../lib/quotas.js';
import {
  QUAL_CATALOG_VERSION, QUAL_OUTPUT_MAX_TOKENS, QUAL_PROMPT_VERSION,
  QUAL_RECEIPT_MAX, USD_MICRO, worstCaseSpendMicroUsd,
} from './constants.mjs';

export const QUAL_GLOBAL_ID = 'qualification:global';
export const QUAL_OWNER_PER_HOUR_PLACEHOLDER = 10;
export const QUAL_GLOBAL_PER_HOUR_PLACEHOLDER = 100;
export const QUAL_OWNER_TOKENS_PER_HOUR_PLACEHOLDER = 20000;
export const QUAL_GLOBAL_TOKENS_PER_HOUR_PLACEHOLDER = 200000;
const OP_TTL_MS = 24 * 3600 * 1000;
const LEAK_TTL_MS = 3600 * 1000;

export function qualWindow(now = new Date()) {
  return 'qual/' + budgetWindow(now);
}

export function qualTokWindow(now = new Date()) {
  return 'qual-tok/' + budgetWindow(now);
}

/**
 * Fixture request window. Fixture (and demo) assessments are free: they
 * draw from this owner-scoped bucket only, so demo traffic can never spend
 * the live per-owner/global request budgets or block live calls.
 */
export function qualFixtureWindow(now = new Date()) {
  return 'qual-fixture/' + budgetWindow(now);
}

function parseBudget(raw, fallback) {
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function qualBudgets(env) {
  const e = env || {};
  return {
    reqOwner: parseBudget(e.QUAL_OWNER_PER_HOUR, QUAL_OWNER_PER_HOUR_PLACEHOLDER),
    reqGlobal: parseBudget(e.QUAL_GLOBAL_PER_HOUR, QUAL_GLOBAL_PER_HOUR_PLACEHOLDER),
    tokOwner: parseBudget(e.QUAL_OWNER_TOKENS_PER_HOUR, QUAL_OWNER_TOKENS_PER_HOUR_PLACEHOLDER),
    tokGlobal: parseBudget(e.QUAL_GLOBAL_TOKENS_PER_HOUR, QUAL_GLOBAL_TOKENS_PER_HOUR_PLACEHOLDER),
  };
}

/** Production spend cap in USD for one call. Defaults to zero: live calls need explicit budget. */
export function qualSpendCapUsd(env) {
  const raw = env ? env.QUAL_SPEND_CAP_USD : undefined;
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseSpendMicro(raw) {
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n * USD_MICRO);
}

/**
 * Aggregate spend caps (per-owner and deployment-global, micro-USD).
 * Defaults are zero: without explicit aggregate budget no live call is
 * admitted. QUAL_OWNER_SPEND_CAP_USD / QUAL_GLOBAL_SPEND_CAP_USD.
 */
export function qualSpendCaps(env) {
  const e = env || {};
  return {
    owner: parseSpendMicro(e.QUAL_OWNER_SPEND_CAP_USD),
    global: parseSpendMicro(e.QUAL_GLOBAL_SPEND_CAP_USD),
  };
}

function chargeStmt(db, id, window, amount) {
  // Chained on changes() = 1 like the heartbeat counters: the charge lands
  // only when the reservation INSERT changed exactly one row, so all charges
  // commit with an admitted op or none do. Rejections write nothing.
  return db.prepare(
    'INSERT INTO write_budget (user_id, window, count) SELECT ?, ?, ? WHERE changes() = 1\n'
    + '     ON CONFLICT (user_id, window) DO UPDATE SET count = count + excluded.count',
  ).bind(id, window, amount);
}

function spendChargeStmt(db, id, micro, at) {
  return db.prepare(
    'INSERT INTO qualification_spend (owner_id, usd_micro, updated_at) SELECT ?, ?, ? WHERE changes() = 1\n'
    + '     ON CONFLICT (owner_id) DO UPDATE SET usd_micro = usd_micro + excluded.usd_micro, updated_at = excluded.updated_at',
  ).bind(id, micro, at);
}

async function existingOp(db, tenant, opKey) {
  return first(db, 'SELECT op_key, input_digest, state, receipt_json FROM qualification_recommendations WHERE owner_id = ? AND op_key = ?', tenant, opKey);
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
 * Convert stale reserved/fetching ops to uncertain (retained, never resent,
 * never deleted). Runs before admission checks so a stuck op blocks later
 * keys as uncertain rather than hanging them as in-progress forever.
 */
export async function sweepQualStale(db, tenant, now = new Date()) {
  const leakBefore = new Date(now.getTime() - LEAK_TTL_MS).toISOString();
  const receipt = JSON.stringify({ error: 'QUAL_STALE_OP', status: 409 });
  await db.prepare(
    'UPDATE qualification_recommendations SET state = \'uncertain\', receipt_json = COALESCE(receipt_json, ?), updated_at = ? WHERE owner_id = ? AND state IN (\'reserved\',\'fetching\') AND updated_at < ?',
  ).bind(receipt, nowIso(now), tenant, leakBefore).run();
}

/** An uncertain op for the same cache identity blocks new keys: no bypass. */
export async function findUncertain(db, tenant, { nodeId, profileDigest, catalogVersion = QUAL_CATALOG_VERSION, promptVersion = QUAL_PROMPT_VERSION, mode }) {
  return first(db,
    'SELECT op_key, receipt_json FROM qualification_recommendations WHERE owner_id = ? AND node_id = ? AND profile_digest = ? AND catalog_version = ? AND prompt_version = ? AND mode = ? AND state = \'uncertain\' ORDER BY updated_at DESC LIMIT 1',
    tenant, nodeId, profileDigest, catalogVersion, promptVersion, mode);
}

/** A reserved/fetching op for the same identity: a new key must wait, not duplicate. */
export async function findInflight(db, tenant, { nodeId, profileDigest, catalogVersion = QUAL_CATALOG_VERSION, promptVersion = QUAL_PROMPT_VERSION, mode }) {
  return first(db,
    'SELECT op_key FROM qualification_recommendations WHERE owner_id = ? AND node_id = ? AND profile_digest = ? AND catalog_version = ? AND prompt_version = ? AND mode = ? AND state IN (\'reserved\',\'fetching\') ORDER BY created_at ASC LIMIT 1',
    tenant, nodeId, profileDigest, catalogVersion, promptVersion, mode);
}

/** Latest delivered op for the same identity: a new key replays it, never resends. */
export async function findDelivered(db, tenant, { nodeId, profileDigest, catalogVersion = QUAL_CATALOG_VERSION, promptVersion = QUAL_PROMPT_VERSION, mode }) {
  return first(db,
    'SELECT op_key, advice_json, receipt_json FROM qualification_recommendations WHERE owner_id = ? AND node_id = ? AND profile_digest = ? AND catalog_version = ? AND prompt_version = ? AND mode = ? AND state = \'delivered\' ORDER BY updated_at DESC LIMIT 1',
    tenant, nodeId, profileDigest, catalogVersion, promptVersion, mode);
}

/**
 * Settled identity state after a declined reservation, checked in safety
 * order: uncertain first (it wins over any older delivery — billing unknown
 * must reconcile, never replay as clean), then the stable cache (the durable
 * replay source, matching the pre-claim path), then a delivered row (crash
 * window: delivered but its cache row never landed). Returns
 * { kind, adviceJson, receiptJson } or null.
 */
export async function findSettled(db, tenant, identity) {
  const uncertain = await findUncertain(db, tenant, identity);
  if (uncertain) return { kind: 'uncertain', adviceJson: null, receiptJson: uncertain.receipt_json || null };
  const cached = await findCache(db, tenant, identity);
  if (cached) return { kind: 'cached', adviceJson: cached.advice_json || null, receiptJson: cached.receipt_json || null };
  const delivered = await findDelivered(db, tenant, identity);
  if (delivered) return { kind: 'delivered', adviceJson: delivered.advice_json || null, receiptJson: delivered.receipt_json || null };
  return null;
}

export async function findCache(db, tenant, { nodeId, profileDigest, catalogVersion = QUAL_CATALOG_VERSION, promptVersion = QUAL_PROMPT_VERSION, mode }) {
  return first(db,
    'SELECT advice_json, receipt_json FROM qualification_cache WHERE owner_id = ? AND node_id = ? AND profile_digest = ? AND catalog_version = ? AND prompt_version = ? AND mode = ?',
    tenant, nodeId, profileDigest, catalogVersion, promptVersion, mode);
}

export async function saveCache(db, tenant, { nodeId, profileDigest, catalogVersion = QUAL_CATALOG_VERSION, promptVersion = QUAL_PROMPT_VERSION, mode, adviceJson, receiptJson }) {
  const now = nowIso();
  await db.prepare(
    'INSERT INTO qualification_cache (owner_id, node_id, profile_digest, catalog_version, prompt_version, mode, advice_json, receipt_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    + ' ON CONFLICT (owner_id, node_id, profile_digest, catalog_version, prompt_version, mode) DO UPDATE SET advice_json = excluded.advice_json, receipt_json = excluded.receipt_json, updated_at = excluded.updated_at',
  ).bind(tenant, nodeId, profileDigest, catalogVersion, promptVersion, mode, adviceJson, receiptJson, now, now).run();
}

async function probeCount(db, id, window) {
  try {
    const row = await first(db, 'SELECT count FROM write_budget WHERE user_id = ? AND window = ?', id, window);
    return row ? row.count : 0;
  } catch {
    // Fail closed: an unreadable counter refuses rather than reads as zero.
    throw httpError(429, 'Qualification budget state is unreadable; refusing closed.', 'QUAL_QUOTA');
  }
}

async function probeSpend(db, id) {
  try {
    const row = await first(db, 'SELECT usd_micro FROM qualification_spend WHERE owner_id = ?', id);
    return row ? row.usd_micro : 0;
  } catch {
    throw httpError(429, 'Qualification spend state is unreadable; refusing closed.', 'QUAL_QUOTA');
  }
}

/** Classify which quota refused, for an actionable error. Probes fail closed. */
async function classifyRefusal(db, tenant, win, tokWin, totalTokens, spendMicro, budgets, caps, live) {
  const [reqOwn, ownTok, globTok, ownSpend, globSpend] = await Promise.all([
    probeCount(db, tenant, win),
    probeCount(db, tenant, tokWin), probeCount(db, QUAL_GLOBAL_ID, tokWin),
    probeSpend(db, tenant), probeSpend(db, QUAL_GLOBAL_ID),
  ]);
  if (reqOwn >= budgets.reqOwner) throw httpError(429, live ? 'Qualification request budget for this owner is spent for the hour.' : 'Qualification fixture budget for this owner is spent for the hour.', live ? 'QUAL_OWNER_QUOTA' : 'QUAL_FIXTURE_QUOTA');
  if (live) {
    const reqGlob = await probeCount(db, QUAL_GLOBAL_ID, win);
    if (reqGlob >= budgets.reqGlobal) throw httpError(429, 'Deployment qualification budget is spent for the hour.', 'QUAL_GLOBAL_QUOTA');
  }
  if (ownTok + totalTokens > budgets.tokOwner) throw httpError(429, 'Qualification token budget for this owner is spent for the hour.', 'QUAL_OWNER_TOKENS');
  if (globTok + totalTokens > budgets.tokGlobal) throw httpError(429, 'Deployment qualification token budget is spent for the hour.', 'QUAL_GLOBAL_TOKENS');
  if (spendMicro > 0 && ownSpend + spendMicro > caps.owner) throw httpError(402, 'Qualification aggregate spend cap for this owner is exhausted.', 'QUAL_SPEND_CAP');
  if (spendMicro > 0 && globSpend + spendMicro > caps.global) throw httpError(402, 'Deployment qualification aggregate spend cap is exhausted.', 'QUAL_SPEND_CAP');
  throw httpError(409, 'A qualification for this node profile is already running. Retry shortly with the same key.', 'OP_IN_PROGRESS');
}

/**
 * Claim a qualification operation. The reservation INSERT embeds every
 * quota/spend condition plus the same-identity settled guard, so
 * concurrent distinct keys are judged on the same committed state: exactly
 * one winner per remaining budget, and never two chargeable calls for one
 * identity — even when the first completes (delivered/cached/uncertain)
 * between the second's pre-checks and its reservation. Fixture ops draw
 * from an owner-scoped fixture window only and never touch live/global
 * buckets. Failed rows never block: fixture failures stay retryable with a
 * new key, while live errors land uncertain (never failed), so no paid call
 * is ever silently repeated. Returns claimed/replay/in-progress/uncertain/
 * settled-replay; throws 402/409/429 otherwise. Never double-charges, never
 * refunds, never fails open.
 */
export async function assertQualKeyNotRetired(db, tenant, opKey) {
  const row = await first(db, "SELECT record_key FROM qualification_retired_records WHERE owner_id=? AND kind='recommendation' AND record_key=?", tenant, opKey);
  if (row) throw httpError(409, 'This qualification operation belongs to a retired worker.', 'QUAL_OPERATION_RETIRED');
}

export async function claimQualOp(db, tenant, nodeId, profileDigest, opKey, digest, { inputTokens = 0, outputTokens = QUAL_OUTPUT_MAX_TOKENS, spendMicro = 0, mode = 'fixture', env = null, clock = null } = {}) {
  const found = await existingOp(db, tenant, opKey);
  if (found) return fromRow(found, digest);
  await assertQualKeyNotRetired(db, tenant, opKey);
  const live = mode === 'live';
  const at = typeof clock === 'function' ? clock() : new Date();
  const win = live ? qualWindow(at) : qualFixtureWindow(at);
  const tokWin = qualTokWindow(at);
  const budgets = qualBudgets(env);
  const caps = qualSpendCaps(env);
  const totalTokens = inputTokens + outputTokens;
  const created = nowIso(at);
  const statements = [
    db.prepare(
      'INSERT INTO qualification_recommendations (owner_id, node_id, profile_digest, catalog_version, prompt_version, mode, op_key, input_digest, state, receipt_json, created_at, updated_at) '
      + 'SELECT ?, ?, ?, ?, ?, ?, ?, ?, \'reserved\', NULL, ?, ? '
      // SUM (not a bare column) so an empty bucket yields one NULL row that
      // COALESCE turns into 0 instead of an empty set that voids the gate.
      + 'WHERE EXISTS (SELECT 1 FROM resources r JOIN "user" u ON u.id=r.owner_id WHERE r.id=? AND r.owner_id=? AND u.disabled=0) '
      + "AND NOT EXISTS (SELECT 1 FROM qualification_retired_records WHERE owner_id=? AND kind='recommendation' AND record_key=?) "
      + 'AND NOT EXISTS (SELECT 1 FROM qualification_recommendations WHERE owner_id = ? AND op_key = ?) '
      // Same identity already inflight under another key: wait, never duplicate.
      + 'AND NOT EXISTS (SELECT 1 FROM qualification_recommendations WHERE owner_id = ? AND node_id = ? AND profile_digest = ? AND catalog_version = ? AND prompt_version = ? AND mode = ? AND state IN (\'reserved\',\'fetching\')) '
      // Same identity already settled under another key: a delivery or an
      // uncertain terminal that landed after our pre-checks still blocks the
      // reservation atomically — replay or reconcile, never a second call.
      + 'AND NOT EXISTS (SELECT 1 FROM qualification_recommendations WHERE owner_id = ? AND node_id = ? AND profile_digest = ? AND catalog_version = ? AND prompt_version = ? AND mode = ? AND state IN (\'delivered\',\'uncertain\')) '
      + 'AND NOT EXISTS (SELECT 1 FROM qualification_cache WHERE owner_id = ? AND node_id = ? AND profile_digest = ? AND catalog_version = ? AND prompt_version = ? AND mode = ?) '
      + 'AND (SELECT COALESCE(SUM(count), 0) FROM write_budget WHERE user_id = ? AND window = ?) + 1 <= ? '
      + (live ? 'AND (SELECT COALESCE(SUM(count), 0) FROM write_budget WHERE user_id = ? AND window = ?) + 1 <= ? ' : 'AND 1 = 1 ')
      + 'AND (SELECT COALESCE(SUM(count), 0) FROM write_budget WHERE user_id = ? AND window = ?) + ? <= ? '
      + 'AND (SELECT COALESCE(SUM(count), 0) FROM write_budget WHERE user_id = ? AND window = ?) + ? <= ? '
      + 'AND (? = 0 OR (SELECT COALESCE(SUM(usd_micro), 0) FROM qualification_spend WHERE owner_id = ?) + ? <= ?) '
      + 'AND (? = 0 OR (SELECT COALESCE(SUM(usd_micro), 0) FROM qualification_spend WHERE owner_id = ?) + ? <= ?)',
    ).bind(tenant, nodeId, profileDigest, QUAL_CATALOG_VERSION, QUAL_PROMPT_VERSION, mode, opKey, digest, created, created,
      nodeId, tenant, tenant, opKey, tenant, opKey,
      tenant, nodeId, profileDigest, QUAL_CATALOG_VERSION, QUAL_PROMPT_VERSION, mode,
      tenant, nodeId, profileDigest, QUAL_CATALOG_VERSION, QUAL_PROMPT_VERSION, mode,
      tenant, nodeId, profileDigest, QUAL_CATALOG_VERSION, QUAL_PROMPT_VERSION, mode,
      tenant, win, budgets.reqOwner,
      ...(live ? [QUAL_GLOBAL_ID, win, budgets.reqGlobal] : []),
      tenant, tokWin, totalTokens, budgets.tokOwner,
      QUAL_GLOBAL_ID, tokWin, totalTokens, budgets.tokGlobal,
      spendMicro, tenant, spendMicro, caps.owner,
      spendMicro, QUAL_GLOBAL_ID, spendMicro, caps.global),
    chargeStmt(db, tenant, win, 1),
  ];
  if (live) statements.push(chargeStmt(db, QUAL_GLOBAL_ID, win, 1));
  statements.push(
    chargeStmt(db, tenant, tokWin, totalTokens),
    chargeStmt(db, QUAL_GLOBAL_ID, tokWin, totalTokens),
  );
  if (spendMicro > 0) statements.push(
    spendChargeStmt(db, tenant, spendMicro, created),
    spendChargeStmt(db, QUAL_GLOBAL_ID, spendMicro, created),
  );
  const out = await db.batch(statements);
  if (Number(out[0].meta.changes) === 1) {
    // Admission won: prune aged terminal ops (delivered/failed only) behind
    // the committed reservation, never as part of the admission judgement.
    // Seven days, matching the migration comment; uncertain rows and the
    // stable cache are never pruned.
    const cutoff = new Date(at.getTime() - 7 * OP_TTL_MS).toISOString();
    await db.prepare('DELETE FROM qualification_recommendations WHERE owner_id = ? AND state IN (\'delivered\',\'failed\') AND updated_at < ?').bind(tenant, cutoff).run();
    return { outcome: 'claimed' };
  }
  const again = await existingOp(db, tenant, opKey);
  if (again) return fromRow(again, digest);
  await assertQualKeyNotRetired(db, tenant, opKey);
  const resource = await first(db, 'SELECT r.id FROM resources r JOIN "user" u ON u.id=r.owner_id WHERE r.id=? AND r.owner_id=? AND u.disabled=0', nodeId, tenant);
  if (!resource) throw httpError(404, 'Resource not found or not yours.', 'RESOURCE_NOT_FOUND');
  const identity = { nodeId, profileDigest, mode };
  const inflight = await findInflight(db, tenant, identity);
  if (inflight) return { outcome: 'in-progress' };
  // Reclassify: a completion, cache fill, or uncertain terminal for this
  // identity that landed after our pre-checks. Replay or reconcile — the
  // declined reservation wrote no charges, so reclassification is free.
  const settled = await findSettled(db, tenant, identity);
  if (settled) {
    if (settled.kind === 'uncertain') return { outcome: 'uncertain', receipt: settled.receiptJson };
    return { outcome: 'settled-replay', from: settled.kind, adviceJson: settled.adviceJson, receiptJson: settled.receiptJson };
  }
  return classifyRefusal(db, tenant, win, tokWin, totalTokens, spendMicro, budgets, caps, live);
}

/** Move an op between states; only legal transitions write. */
export async function markQualOp(db, tenant, opKey, from, to, receipt) {
  const payload = receipt ? JSON.stringify(receipt).slice(0, QUAL_RECEIPT_MAX) : null;
  const states = Array.isArray(from) ? from : [from];
  const placeholders = states.map(() => '?').join(',');
  const out = await db.prepare(
    `UPDATE qualification_recommendations SET state = ?, receipt_json = COALESCE(?, receipt_json), updated_at = ? WHERE owner_id = ? AND op_key = ? AND state IN (${placeholders})`,
  ).bind(to, payload, nowIso(), tenant, opKey, ...states).run();
  return Number(out.meta.changes) === 1;
}

export { worstCaseSpendMicroUsd };

/* Built with Meta Muse. */
// Shared operation helpers for the federation state layer (F1R3):
// stable op identity, the single cross-action approval claim,
// attempt-fencing helpers, replay redaction, and idempotent
// post-commit completions (history + audit). store.mjs and router.mjs
// share these; probes keep calling store.mjs entry points.
import { first } from '../lib/store.js';
import { digestJson } from './canonical.mjs';
import { httpError } from '../lib/validate.js';

const randHex = (n) => [...globalThis.crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

// Stable per-operation digest: identical for every attempt of one
// router operation (actor + path + key), fresh randomness for direct
// store calls that carry no idempotency context.
export async function opDigest(actor, op) {
  if (op && typeof op.key === 'string' && op.key && typeof op.path === 'string' && op.path) {
    return digestJson(`${actor.kind}:${actor.user.id}:${op.path}:${op.key}`);
  }
  return `direct${randHex(8)}`;
}

export const isCommitFailure = (path, status) => status >= 400 && status < 500 && status !== 401 && status !== 403
  && claimActionForPath(path) === 'grant.commit';
export const pendingCommit = () => ({ status: 503, body: {
  error: 'Commit outcome is not recorded; retry reconciliation or use a fresh approval.', code: 'COMMIT_UNCERTAIN'
} });

// Claim-bearing action per router path, REST or MCP. Terminal ledger
// failures and delayed approval claims serialize as a pair per action:
// failure first forbids a delayed claim; claim first forbids a terminal
// failure. Commit, resume and revision share this fence.
export const claimActionForPath = (path) => {
  if (path === '/v1/fabric/grants' || path === '/v1/fabric/mcp:fabric.commit_grant') return 'grant.commit';
  if (path === '/v1/fabric/mcp:fabric.revise_grant'
    || (typeof path === 'string' && /^\/v1\/fabric\/grants\/[^/]+\/revise$/.test(path))) return 'grant.revise';
  if (path === '/v1/fabric/mcp:fabric.resume_grant'
    || (typeof path === 'string' && /^\/v1\/fabric\/grants\/[^/]+\/resume$/.test(path))) return 'grant.resume';
  return null;
};

export const pendingClaim = (action) => action === 'grant.revise' ? { status: 503, body: {
  error: 'Revision outcome is not recorded; retry reconciliation or re-approve a fresh operation.', code: 'REVISION_UNCERTAIN'
} } : action === 'grant.resume' ? { status: 503, body: {
  error: 'Resume outcome is not recorded; retry reconciliation or re-approve a fresh operation.', code: 'RESUME_UNCERTAIN'
} } : pendingCommit();

// Stable router operations carry their ledger identity so a recorded
// terminal failure vetoes a delayed claim. Calls without any stable op
// identity are independent operations.
export const ledgerFor = (actor, op) => (op && typeof op.key === 'string' && op.key && typeof op.path === 'string' && op.path)
  ? { actor: `${actor.kind}:${actor.user.id}`, key: op.key, path: op.path } : null;

// Veto fragment for claim writes: a recorded terminal failure for this
// router operation forbids a delayed claim, even one using its old
// timestamp. A processing/uncertain takeover is deliberately not a veto.
export const ledgerVeto = (ledger) => ledger ? {
  clause: ` AND NOT EXISTS(SELECT 1 FROM idempotency_records
    WHERE actor = ? AND idem_key = ? AND path = ? AND method = 'POST'
    AND (status = 'quarantined' OR (status = 'completed' AND response_code >= 400)))`,
  binds: [ledger.actor, ledger.key, ledger.path],
} : { clause: '', binds: [] };

// THE approval claim, shared by commit/revise/resume. Exactly one
// claimant wins per approval, ever: the UPDATE commits before any
// effect runs, so losers change nothing. A win followed by an effect
// failure leaves the approval spent (fail-closed reapproval).
// Returns true iff this caller won the claim.
export async function claimApproval(db, { id, action, target, op, now, ledger = null }) {
  // A claim and its terminal ledger failure serialize in opposite order:
  // once a failure wins, an old delayed claim must never create access.
  // A processing/uncertain takeover is deliberately not a veto: an already
  // authorized old attempt may still finish and be reconciled by the new one.
  const veto = ledgerVeto(ledger);
  const r = await db.prepare(`UPDATE approvals SET consumed_at = ?, consumed_by_op = ?, consumed_action = ?, consumed_target = ?
    WHERE id = ? AND consumed_at IS NULL AND decision = 'approved' AND expiry > ?${veto.clause}`)
    .bind(now, op, action, target, id, now, ...veto.binds).run();
  return Number(r.meta.changes) === 1;
}

const slug = (s, n) => String(s).replace(/[^a-z0-9]+/gi, '').slice(0, n) || 'op';

// Deterministic audit id per (operation, action): post-commit audit
// completion and every reconcile path converge on one row.
export function auditIdFor(op, action) {
  return `aud_${slug(op, 40)}_${slug(action, 24)}`;
}

export async function ensureAudit(db, { op, action, actorId, target, detail, now }) {
  await db.prepare('INSERT OR IGNORE INTO audit (id, at, actor_id, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(auditIdFor(op, action), now, actorId, action, target, detail).run();
}

// A restriction's effect, immutable response and audit commit together. Reading
// its own receipt precedes fresh version/state checks: a later transition must
// not erase the outcome of an already-applied operation. The router also binds
// its ledger request; this digest protects direct callers carrying an op context.
export async function restrictionContext(db, actor, op, action, target, input, prior = null) {
  // A direct call has a fresh random identity, but its own unknown batch
  // response still reconciles against that same identity within this call.
  const operationId = prior ? prior.operationId : await opDigest(actor, op), requestHash = await digestJson(input);
  const row = await first(db, 'SELECT * FROM fabric_restriction_receipts WHERE operation_id = ?', operationId);
  if (row && (row.actor_id !== actor.user.id || row.action !== action || row.target_id !== target || row.request_hash !== requestHash)) {
    throw httpError(409, 'Restriction operation was already applied to a different request.', 'IDEMPOTENCY_CONFLICT');
  }
  return { operationId, requestHash, replay: row ? { status: 200, body: JSON.parse(row.response_body) } : null };
}

// Append immediately after a successful chained effect (changes() = 1).
// A receipt collision is an error and rolls back the whole effect; do not
// ignore it. A lost batch response is recovered solely from this receipt.
export function restrictionCompletion(actor, ctx, action, target, body, now, detail = '') {
  const via = actor.kind === 'key' ? ` via key ${actor.keyId || 'unknown'}${actor.delegate?.length ? ' (agent)' : ''}` : ' via session';
  return [
    [`INSERT INTO fabric_restriction_receipts (operation_id, actor_id, action, target_id, request_hash, response_body, applied_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
      ctx.operationId, actor.user.id, action, target, ctx.requestHash, JSON.stringify(body), now],
    [`INSERT OR IGNORE INTO audit (id, at, actor_id, action, target, detail)
      SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
      auditIdFor(ctx.operationId, action), now, actor.user.id, action, target, (detail + via).slice(0, 300)]
  ];
}

// Deterministic revision-history id per (grant, superseded version,
// approval): reconcile writes the row the failed attempt missed.
export function historyIdFor(grantId, version, approvalId) {
  return `fgr_${slug(grantId, 32)}_${Number(version)}_${slug(approvalId, 20)}`;
}

export async function ensureHistory(db, { grantId, version, termsJson, approvalId, now }) {
  await db.prepare('INSERT OR IGNORE INTO fabric_grant_revisions (id, grant_id, version, terms_json, approval_id, superseded_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(historyIdFor(grantId, version, approvalId), grantId, version, termsJson, approvalId, now).run();
}

// One-time secret fields are never persisted for replay: the metadata
// (ids, digests, errors) replays exactly, but credential material is
// shown once on the live response only.
const REPLAY_REDACTED = new Set(['nodeSecret', 'token', 'secret']);
export function redactForReplay(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  let redacted = false;
  const out = { ...body };
  for (const k of Object.keys(out)) {
    if (REPLAY_REDACTED.has(k)) { delete out[k]; redacted = true; }
  }
  if (redacted) out.replayNote = 'Secret fields are shown once and are not stored for replay.';
  return out;
}

export function freshAttempt() {
  return `att_${randHex(12)}`;
}

// The router calls this immediately after a successful gate claim to
// learn the attempt token fencing its finalize/release. Safe: only
// the unique claimer/reclaimer reaches this point, and a fresh claim
// is never stealable before its first finalize.
export async function readAttempt(db, actorKey, key) {
  const row = await first(db, 'SELECT attempt FROM idempotency_records WHERE idem_key = ? AND actor = ?', key, actorKey);
  return row ? row.attempt : null;
}

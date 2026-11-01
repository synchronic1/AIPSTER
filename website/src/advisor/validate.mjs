/* Built with Meta Muse. */
// Fabric adviser contracts: input bounds, redacted snapshots, output
// validation. Pure functions only: no I/O, no fetch, no dispatch.
// The snapshot is the ONLY provider-bound data shape. It carries
// request-local aliases, allowlisted typed capability facts, freshness
// categories and server-known restrictions — never names, hostnames,
// owner/user IDs, addresses, keys, credits, paths, prompts, or free-form
// origin/verification/catalog metadata. Unknown measurements stay unknown:
// missing facts must never be fabricated into compatibility or latency.
import { httpError, isId } from '../lib/validate.js';
import { resourceLiveness, parseStatusRow } from '../lib/status.mjs';

export const ADVISOR_SCHEMA = 'advisor/v1';
export const ADVISOR_TASK_MAX = 1000;
export const ADVISOR_REFS_MAX = 20;
export const ADVISOR_BODY_MAX = 16 * 1024;
export const ADVISOR_ENVELOPE_MAX = 32 * 1024;
export const ADVISOR_SUMMARY_MAX = 2000;
export const ADVISOR_RECS_MAX = 3;
export const ADVISOR_WHY_MAX = 1000;
export const ADVISOR_UNKNOWNS_MAX = 8;
export const ADVISOR_UNKNOWN_MAX = 500;
export const ADVISOR_EVIDENCE_MAX = 8;
export const ADVISOR_BLOCKED_MAX = 8;
export const ADVISOR_BLOCKED_LEN_MAX = 500;
export const ADVISOR_CAPS_MAX = 10;
import { CAP_TOKEN as SHARED_CAP_TOKEN, filterCapTokens } from '../lib/caps.js';
export const ADVISOR_CAP_TOKEN = SHARED_CAP_TOKEN;
// Deterministic restrictions, computed server-side, always attached: advice
// never implies what these deny.
export const ADVISOR_RESTRICTIONS = ['dispatch-disabled', 'model-compatibility-unknown'];

const bad = (message, code = 'BAD_ADVISOR_REQUEST') => httpError(400, message, code);

function checkString(v, name, min, max, code) {
  if (typeof v !== 'string' || v.length < min || v.length > max) throw bad(`${name} must be ${min}..${max} chars.`, code);
  return v;
}

/**
 * Validate the client POST body. The client sends a bounded task, opaque
 * resource references and an optional idempotency key — never tenant
 * identity or authoritative capabilities. Unknown fields are rejected so a
 * client cannot smuggle authoritative-looking facts into the call.
 */
export function checkAdvisorBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('JSON object required.');
  for (const k of Object.keys(body)) {
    if (!['task', 'refs', 'opKey'].includes(k)) throw bad(`Unknown field: ${k}.`);
  }
  const task = checkString(typeof body.task === 'string' ? body.task.trim() : body.task, 'task', 1, ADVISOR_TASK_MAX);
  if (!Array.isArray(body.refs) || body.refs.length < 1 || body.refs.length > ADVISOR_REFS_MAX) {
    throw bad(`refs must list 1..${ADVISOR_REFS_MAX} resource references.`);
  }
  for (const r of body.refs) {
    if (!isId(r)) throw bad('Each ref must be 1..64 id chars.');
  }
  const refs = [...new Set(body.refs)];
  let opKey = null;
  if (body.opKey !== undefined) {
    if (!isId(body.opKey)) throw bad('opKey must be 1..64 id chars.', 'BAD_IDEMPOTENCY');
    opKey = body.opKey;
  }
  return { task, refs, opKey };
}

function telemetryOf(liveness) {
  if (liveness === 'online') return 'fresh';
  if (liveness === 'stale') return 'stale';
  return 'unknown';
}

function filterCaps(raw) {
  return filterCapTokens(raw, { max: ADVISOR_CAPS_MAX, pattern: ADVISOR_CAP_TOKEN });
}

/**
 * Build the redacted provider-bound snapshot from already-authorized owned
 * rows. Malformed rows are skipped (fail-closed per row). Aliases (r1..)
 * are request-local: they reveal nothing across calls.
 */
export function buildSnapshot(rows, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const entries = [];
  const input = Array.isArray(rows) ? rows : [];
  for (const raw of input) {
    if (entries.length >= ADVISOR_REFS_MAX) break;
    const trusted = parseStatusRow(raw);
    if (!trusted) continue;
    const liveness = resourceLiveness(trusted, now);
    entries.push({
      ref: `r${entries.length + 1}`,
      kind: trusted.kind,
      liveness,
      telemetry: telemetryOf(liveness),
      caps: filterCaps(raw.capabilities_json),
      usable: trusted.usable,
    });
  }
  return {
    schema: ADVISOR_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    entries,
    restrictions: [...ADVISOR_RESTRICTIONS],
  };
}

const badAdvice = (message) => httpError(502, message, 'BAD_ADVICE');

function checkAdviceString(v, name, min, max) {
  if (typeof v !== 'string' || v.length < min || v.length > max) throw badAdvice(`${name} must be ${min}..${max} chars.`);
  return v;
}

function checkKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw badAdvice(`Unknown field in ${where}: ${k}.`);
  }
}

/**
 * Strictly validate provider/fixture output against the caller's snapshot
 * allowlist. Every reference must resolve to this call's refs; invented IDs,
 * non-null models (no candidate list exists), extra fields, tool calls and
 * over-bounds strings are all rejected. Evidence references resolve to
 * server-owned snapshot facts, never model-supplied URLs.
 */
export function validateAdvice(value, { refs }) {
  const allow = new Set(Array.isArray(refs) ? refs : []);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badAdvice('Advice must be a JSON object.');
  checkKeys(value, ['summary', 'recommendations', 'blockedReasons'], 'advice');
  checkAdviceString(value.summary, 'summary', 1, ADVISOR_SUMMARY_MAX);
  if (!Array.isArray(value.recommendations) || value.recommendations.length > ADVISOR_RECS_MAX) {
    throw badAdvice(`recommendations must list at most ${ADVISOR_RECS_MAX}.`);
  }
  for (const r of value.recommendations) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw badAdvice('Each recommendation must be an object.');
    checkKeys(r, ['resourceRef', 'modelRef', 'evidenceRefs', 'why', 'unknowns'], 'recommendation');
    if (typeof r.resourceRef !== 'string' || !allow.has(r.resourceRef)) throw badAdvice('resourceRef must name this snapshot.');
    if (r.modelRef !== null) throw badAdvice('modelRef must be null: no reviewed model contract exists.');
    if (!Array.isArray(r.evidenceRefs) || r.evidenceRefs.length > ADVISOR_EVIDENCE_MAX) {
      throw badAdvice(`evidenceRefs must list at most ${ADVISOR_EVIDENCE_MAX}.`);
    }
    for (const e of r.evidenceRefs) {
      if (typeof e !== 'string' || !allow.has(e)) throw badAdvice('evidenceRefs must name this snapshot.');
    }
    checkAdviceString(r.why, 'why', 1, ADVISOR_WHY_MAX);
    if (!Array.isArray(r.unknowns) || r.unknowns.length > ADVISOR_UNKNOWNS_MAX) {
      throw badAdvice(`unknowns must list at most ${ADVISOR_UNKNOWNS_MAX}.`);
    }
    for (const u of r.unknowns) checkAdviceString(u, 'unknowns[]', 1, ADVISOR_UNKNOWN_MAX);
  }
  if (!Array.isArray(value.blockedReasons) || value.blockedReasons.length > ADVISOR_BLOCKED_MAX) {
    throw badAdvice(`blockedReasons must list at most ${ADVISOR_BLOCKED_MAX}.`);
  }
  for (const b of value.blockedReasons) checkAdviceString(b, 'blockedReasons[]', 1, ADVISOR_BLOCKED_LEN_MAX);
  return value;
}

// Canonical digest lives in lib/digest.js (shared with routing); the
// re-export keeps existing adviser imports working unchanged.
export { canonicalDigest } from '../lib/digest.js';

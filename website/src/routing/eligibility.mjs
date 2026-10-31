/* Built with Meta Muse. */
// Routing eligibility: THE single shared authoritative path that feeds both
// deterministic scoring and any model envelope. Every candidate passes the
// same access authority the app routes use (lib/access.js: owner or active
// same-side grant with remaining quota), then routing hard filters. Anything
// rejected here never reaches scoring, the model envelope, or admission.
//
// Honesty rules (no model/capacity registry exists on the Worker):
// - Model compatibility is ALWAYS 'unverified'. An exact capability-token
//   match is a labeled soft signal for scoring, never proof of compatibility.
// - Heartbeat liveness is reachability, never inference readiness. Offline
//   and unknown rows are excluded; stale rows are admitted but flagged.
// - Owned rows have no quota counters: capacity 'unknown', never excluded
//   for capacity. Granted rows enforce remaining-jobs/tokens strictly.
// - Unknown and foreign resources are absent from the output, never
//   distinguished from each other (no oracle).
import { first } from '../lib/store.js';
import { canUseResource } from '../lib/access.js';
import { parseStatusRow, resourceLiveness } from '../lib/status.mjs';
import { buildDescriptor } from './policy.mjs';

const KINDS = ['local', 'cluster', 'provider'];

function checkKinds(kinds) {
  if (kinds === undefined || kinds === null) return null;
  if (!Array.isArray(kinds) || kinds.length === 0) throw new Error('kinds must be a non-empty array.');
  for (const k of kinds) {
    if (!KINDS.includes(k)) throw new Error(`unknown kind: ${k}.`);
  }
  return [...new Set(kinds)];
}

/**
 * List routing candidates for one tenant.
 * @param {object} db D1 database
 * @param {string} tenantId tenant user id (already authenticated)
 * @param {{nowMs?:number,kinds?:string[],maxTokens?:number,model?:string}} opts
 * @returns {{eligible:object[],rejected:{resourceId:string,reason:string}[]}}
 * Reasons: NO_GRANT, QUOTA_EXHAUSTED, KIND_EXCLUDED, UNREACHABLE,
 * NOT_USABLE, CAPACITY_INSUFFICIENT. Malformed rows are skipped silently
 * (fail-closed per row, matching the status/adviser precedent).
 */
export async function listEligible(db, tenantId, opts = {}) {
  if (typeof tenantId !== 'string' || tenantId.length === 0) throw new Error('tenantId required.');
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const kinds = checkKinds(opts.kinds);
  const maxTokens = Number.isSafeInteger(opts.maxTokens) && opts.maxTokens > 0 ? opts.maxTokens : null;
  const model = typeof opts.model === 'string' && opts.model.length >= 1 && opts.model.length <= 128 ? opts.model : null;

  const owned = await db.prepare('SELECT * FROM resources WHERE owner_id = ? ORDER BY id').bind(tenantId).all();
  const grants = await db.prepare('SELECT * FROM grants WHERE grantee_id = ? AND revoked_at IS NULL ORDER BY id').bind(tenantId).all();
  // Candidate rows in deterministic order, deduplicated by resource: owned
  // first (owner path short-circuits access), then granted rows.
  const seen = new Set();
  const rows = [];
  for (const r of (owned.results || [])) {
    if (r && !seen.has(r.id)) { seen.add(r.id); rows.push(r); }
  }
  for (const g of (grants.results || [])) {
    if (!g || seen.has(g.resource_id)) continue;
    const r = await first(db, 'SELECT * FROM resources WHERE id = ?', g.resource_id);
    if (!r) continue; // dangling grant row: nothing to route to.
    seen.add(r.id);
    rows.push(r);
  }

  const eligible = [];
  const rejected = [];
  for (const row of rows) {
    const access = await canUseResource(db, tenantId, row);
    if (!access.ok) {
      rejected.push({ resourceId: row.id, reason: /quota/i.test(access.reason) ? 'QUOTA_EXHAUSTED' : 'NO_GRANT' });
      continue;
    }
    if (access.grant && Number(access.grant.inference_only) !== 1) {
      rejected.push({ resourceId: row.id, reason: 'NO_GRANT' });
      continue;
    }
    if (kinds && !kinds.includes(row.kind)) {
      rejected.push({ resourceId: row.id, reason: 'KIND_EXCLUDED' });
      continue;
    }
    const trusted = parseStatusRow(row);
    if (!trusted) continue; // malformed row: fail closed, stay silent.
    const liveness = resourceLiveness(trusted, nowMs);
    if (liveness === 'offline' || liveness === 'unknown') {
      rejected.push({ resourceId: row.id, reason: 'UNREACHABLE' });
      continue;
    }
    if (trusted.usable !== true) {
      rejected.push({ resourceId: row.id, reason: 'NOT_USABLE' });
      continue;
    }
    if (maxTokens !== null && access.grant) {
      const remaining = Number(access.grant.max_tokens) - Number(access.grant.used_tokens);
      if (maxTokens > remaining) {
        rejected.push({ resourceId: row.id, reason: 'CAPACITY_INSUFFICIENT' });
        continue;
      }
    }
    eligible.push(buildDescriptor({ resource: row, grant: access.grant, trusted, liveness, nowMs, model }));
  }
  eligible.sort((a, b) => (a.resourceId < b.resourceId ? -1 : 1));
  eligible.forEach((c, i) => { c.alias = `r${i + 1}`; });
  return { eligible, rejected };
}

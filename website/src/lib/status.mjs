/* Built with Meta Muse. */
// Read-only resource-liveness adapter boundary. Pure functions only: no I/O,
// no fetch, no dispatch, no simulated-then-reported telemetry.
//
// Shape reference (adapted, not copied): upstream fabric worker domain.ts
// `nodeStatus` (connected flag + staleAfterMs window -> online|stale|offline)
// and contracts.ts `FabricState`/`FabricNode` summary shapes, inspected at
// upstream SHA f5223d39a4346a3fb2726be5e9b0f007861c9f0c. AIPSTER differs
// deliberately: the owner-confined heartbeat writer (POST
// /api/resources/:id/heartbeat, docs/heartbeat-intake.md) proves reachability
// only, never inference acceptance, so a fourth `unknown` arm covers "flag
// says online but no telemetry exists", and this module never reports
// readiness for execution. AIPSTER base 7b38ba071d6a6f1520140486835f9d6a01adafab.
//
// Server enforcement lives in the worker route: owner-scoped SELECT of the
// minimal columns below plus a same-side shared-grant count. This module only
// maps already-authorized rows into the public status shape, dropping every
// free-text field (cpu/gpu/origin/limits/credits) that could carry private
// addresses or credential-shaped material.

/** @typedef {'online'|'stale'|'offline'|'unknown'} AipsterLiveness */
/**
 * @typedef {object} StatusItem
 * @property {string} id
 * @property {string} name
 * @property {string} kind
 * @property {AipsterLiveness} liveness
 * @property {string|null} lastSeenAt
 * @property {number|null} lastSeenAgeMs
 * @property {boolean|null} usable
 * @property {boolean} demoFixture
 */
/**
 * @typedef {object} StatusPayload
 * @property {'aipster.status/1'} schema
 * @property {string} generatedAt
 * @property {boolean} demo
 * @property {'declared-resources'|'demo-fixture'} source
 * @property {'unavailable'} telemetry
 * @property {{total:number,online:number,stale:number,offline:number,unknown:number}} summary
 * @property {number} total
 * @property {boolean} itemsTruncated
 * @property {number} sharedWithMe
 * @property {StatusItem[]} items
 */

// Wider than the upstream 30s LAN-fabric window: AIPSTER heartbeats are sparse
// owner-pushed updates through POST /api/resources/:id/heartbeat, not a
// <=10s socket. Offline/stale derivation stays here; the intake endpoint
// only ever writes heartbeat_at/online/usable and never redefines this rule.
export const STALE_AFTER_MS = 5 * 60 * 1000;
export const MAX_STATUS_ITEMS = 50;

const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const isName = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 80;
const isKind = (v) => v === 'local' || v === 'cluster' || v === 'provider';

/**
 * Validate one authorized DB row into a trusted shape. Returns null for
 * malformed rows so the caller skips them (fail-closed per row, never fail
 * the whole endpoint, never throw caller-controlled data outward).
 */
export function parseStatusRow(row) {
  if (!row || typeof row !== 'object') return null;
  if (!isId(row.id) || !isName(row.name) || !isKind(row.kind)) return null;
  const heartbeat = row.heartbeat_at === null || row.heartbeat_at === undefined
    ? null
    : String(row.heartbeat_at);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    online: Number(row.online) === 1,
    heartbeatAt: heartbeat,
    usable: row.usable === null || row.usable === undefined ? null : Number(row.usable) === 1,
  };
}

/**
 * Derive liveness for one trusted row. Any row whose flag claims online
 * without parseable telemetry reports `unknown`, never `online`: absence of
 * evidence must not render as readiness. Liveness derives from heartbeat_at
 * freshness only; the writer's usable bit (reachability vs inference
 * acceptance, docs/heartbeat-intake.md) never promotes a row to `online`.
 */
export function resourceLiveness(trusted, nowMs) {
  if (!trusted.online) return 'offline';
  if (!trusted.heartbeatAt) return 'unknown';
  const seen = Date.parse(trusted.heartbeatAt);
  if (!Number.isFinite(seen)) return 'unknown';
  return nowMs - seen > STALE_AFTER_MS ? 'stale' : 'online';
}

function ageMs(trusted, liveness, nowMs) {
  if (liveness !== 'online' && liveness !== 'stale') return null;
  const seen = Date.parse(trusted.heartbeatAt);
  return Number.isFinite(seen) ? Math.max(0, nowMs - seen) : null;
}

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * Validate a caller-supplied aggregate summary (SQL COUNT over ALL owned
 * rows). Returns the trusted summary or null when absent/malformed, in
 * which case the caller falls back to deriving counts from the listed page.
 */
function parseAggregateSummary(summary, total) {
  if (summary === undefined && total === undefined) return null;
  if (!summary || typeof summary !== 'object') return null;
  const counts = {
    online: summary.online,
    stale: summary.stale,
    offline: summary.offline,
    unknown: summary.unknown,
  };
  if (!Object.values(counts).every(isCount) || !isCount(total)) return null;
  return { total, ...counts };
}

/**
 * Build the public status payload from already-authorized rows.
 *
 * `rows` is the capped page (at most MAX_STATUS_ITEMS) used for the listed
 * items only. `summary`+`total` is the SQL aggregate over ALL owned rows and
 * is the only source of the reported counts, so summary.total always equals
 * the Overview inventory total even when the list is truncated. Callers that
 * omit the aggregate get the legacy derivation from the listed page.
 *
 * @param {{rows: unknown[], summary?: {online:number,stale:number,offline:number,unknown:number}, total?: number, sharedWithMe: number, demo: boolean, nowMs: number}} input
 * @returns {StatusPayload}
 */
export function buildStatus({ rows, summary, total, sharedWithMe, demo, nowMs }) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  /** @type {StatusItem[]} */
  const items = [];
  const page = { total: 0, online: 0, stale: 0, offline: 0, unknown: 0 };
  const input = Array.isArray(rows) ? rows : [];
  for (const raw of input.slice(0, MAX_STATUS_ITEMS)) {
    const trusted = parseStatusRow(raw);
    if (!trusted) continue;
    const liveness = resourceLiveness(trusted, now);
    page[liveness] += 1;
    items.push({
      id: trusted.id,
      name: trusted.name,
      kind: trusted.kind,
      liveness,
      lastSeenAt: (liveness === 'online' || liveness === 'stale') ? trusted.heartbeatAt : null,
      lastSeenAgeMs: ageMs(trusted, liveness, now),
      usable: trusted.usable,
      demoFixture: demo === true,
    });
  }
  page.total = items.length;
  const aggregate = parseAggregateSummary(summary, total);
  const finalSummary = aggregate ? { ...aggregate } : page;
  // Truncated whenever fewer rows are listed than owned: the 50-item cap bit
  // off rows (aggregate path), or the input page itself exceeded the cap
  // (legacy path with no aggregate).
  const itemsTruncated = aggregate
    ? finalSummary.total > items.length
    : input.length > MAX_STATUS_ITEMS;
  return {
    schema: 'aipster.status/1',
    generatedAt: new Date(now).toISOString(),
    demo: demo === true,
    source: demo === true ? 'demo-fixture' : 'declared-resources',
    telemetry: 'unavailable',
    summary: finalSummary,
    total: finalSummary.total,
    itemsTruncated,
    sharedWithMe: Number.isSafeInteger(sharedWithMe) && sharedWithMe >= 0 ? sharedWithMe : 0,
    items,
  };
}

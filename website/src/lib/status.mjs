/* Built with Meta Muse. */
// Read-only resource-liveness adapter boundary. Pure functions only: no I/O,
// no fetch, no dispatch, no simulated-then-reported telemetry.
//
// Shape reference (adapted, not copied): upstream fabric worker domain.ts
// `nodeStatus` (connected flag + staleAfterMs window -> online|stale|offline)
// and contracts.ts `FabricState`/`FabricNode` summary shapes, inspected at
// upstream SHA f5223d39a4346a3fb2726be5e9b0f007861c9f0c. AIPSTER differs
// deliberately: there is no heartbeat writer yet, so a fourth `unknown` arm
// covers "flag says online but no telemetry exists", and this module never
// reports readiness for execution. AIPSTER base 7b38ba071d6a6f1520140486835f9d6a01adafab.
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
 * @property {number} sharedWithMe
 * @property {StatusItem[]} items
 */

// Wider than the upstream 30s LAN-fabric window: AIPSTER heartbeats (when a
// writer exists) will be sparse owner-pushed updates, not a <=10s socket.
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
  };
}

/**
 * Derive liveness for one trusted row. No heartbeat writer exists yet, so any
 * row whose flag claims online without parseable telemetry reports `unknown`,
 * never `online`: absence of evidence must not render as readiness.
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

/**
 * Build the public status payload from already-authorized rows.
 * @param {{rows: unknown[], sharedWithMe: number, demo: boolean, nowMs: number}} input
 * @returns {StatusPayload}
 */
export function buildStatus({ rows, sharedWithMe, demo, nowMs }) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  /** @type {StatusItem[]} */
  const items = [];
  const summary = { total: 0, online: 0, stale: 0, offline: 0, unknown: 0 };
  for (const raw of Array.isArray(rows) ? rows.slice(0, MAX_STATUS_ITEMS) : []) {
    const trusted = parseStatusRow(raw);
    if (!trusted) continue;
    const liveness = resourceLiveness(trusted, now);
    summary[liveness] += 1;
    items.push({
      id: trusted.id,
      name: trusted.name,
      kind: trusted.kind,
      liveness,
      lastSeenAt: (liveness === 'online' || liveness === 'stale') ? trusted.heartbeatAt : null,
      lastSeenAgeMs: ageMs(trusted, liveness, now),
      demoFixture: demo === true,
    });
  }
  summary.total = items.length;
  return {
    schema: 'aipster.status/1',
    generatedAt: new Date(now).toISOString(),
    demo: demo === true,
    source: demo === true ? 'demo-fixture' : 'declared-resources',
    telemetry: 'unavailable',
    summary,
    sharedWithMe: Number.isSafeInteger(sharedWithMe) && sharedWithMe >= 0 ? sharedWithMe : 0,
    items,
  };
}

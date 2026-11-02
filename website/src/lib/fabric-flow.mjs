/* Built with Meta Muse. */
// Read-only Fabric flow + throughput view-model boundary. Pure functions only:
// no I/O, no fetch, no dispatch, no simulated-then-reported telemetry.
//
// Shape reference (adapted, not copied): upstream elastic-inference-fabric
// FabricTopology.tsx (agent/harness -> authenticated MCP router -> worker
// cards, request/result/heartbeat legend) and bench/BenchDiagram.tsx
// (measured throughput bench), inspected read-only at upstream branch
// review/optimizations @3eb46cdd509a73c5cbc55c8b55c5a6cb7bbd5d7f. AIPSTER
// differs deliberately, see docs/fabric-dashboard-mapping.md:
// - there is no MCP router / placement plane here; request/result edges are
//   architectural labels only, never live connections.
// - worker cards carry liveness from GET /api/status (heartbeat freshness,
//   STALE_AFTER_MS); declared compute free-text is joined downstream by the
//   client renderer from inventory cards, never emitted here. Measured
//   CPU/GPU/memory/runtime/resident-model fields are unsupported.
// - throughput is always unavailable: GET /api/usage reports cumulative
//   requests/tokens/costs only, never tokens/sec. Missing metrics are
//   unavailable, never zero.
// - this module emits data only, never markup. Its client mirror in
//   public/app/app.js renders every string through the existing esc() helper.
import { STALE_AFTER_MS } from './status.mjs';

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);

/**
 * Map one trusted status item into a flow node. Returns null for malformed
 * rows so the caller skips them (fail-closed per row, never fail the view).
 */
export function flowNode(item) {
  if (!item || typeof item !== 'object') return null;
  if (!isId(item.id)) return null;
  if (typeof item.name !== 'string' || item.name.length < 1 || item.name.length > 80) return null;
  if (item.kind !== 'local' && item.kind !== 'cluster' && item.kind !== 'provider') return null;
  const liveness = item.liveness;
  if (liveness !== 'online' && liveness !== 'stale' && liveness !== 'offline' && liveness !== 'unknown') return null;
  // String-surface safety: kind and liveness are allowlisted above, and only
  // plain strings cross into timestamps — anything else is absence, never
  // coerced. Every surviving field is therefore either enumerated or rendered
  // through the caller's esc().
  const lastSeenAt = typeof item.lastSeenAt === 'string' ? item.lastSeenAt : null;
  const lastSeenAgeMs = item.lastSeenAgeMs === null || item.lastSeenAgeMs === undefined
    ? null
    : (Number.isSafeInteger(item.lastSeenAgeMs) && item.lastSeenAgeMs >= 0 ? item.lastSeenAgeMs : null);
  // No live presentation from a bare historical timestamp: online/stale
  // without a string heartbeat timestamp drops to unknown, matching the
  // client mirror and the status adapter's unknown arm.
  const derived = (liveness === 'online' || liveness === 'stale') && lastSeenAt !== null
    ? liveness
    : (liveness === 'offline' ? 'offline' : 'unknown');
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    liveness: derived,
    lastSeenAt: (derived === 'online' || derived === 'stale') ? lastSeenAt : null,
    // Units: milliseconds since the heartbeat was written, or null when no
    // heartbeat exists. Never seconds, never zero-filled.
    lastSeenAgeMs: (derived === 'online' || derived === 'stale') ? lastSeenAgeMs : null,
    usable: item.usable === true ? true : item.usable === false ? false : null,
    demoFixture: item.demoFixture === true,
  };
}

/**
 * Build the flow view-model from already-authorized GET /api/status and
 * GET /api/usage payloads. Throughput is always reported unavailable: usage
 * carries cumulative counts, never measured rates.
 */
function safeNow(nowMs) {
  const candidate = Number.isFinite(nowMs) ? new Date(nowMs) : new Date();
  // Fail-closed timestamp: an out-of-range nowMs must not throw RangeError.
  return Number.isNaN(candidate.getTime()) ? new Date() : candidate;
}

function usageCoverageOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (!Array.isArray(usage.items) || !isCount(usage.total)) return null;
  return { shown: usage.items.length, total: usage.total, complete: usage.items.length >= usage.total };
}

// Heartbeat-lane state derives from the node liveness SET, never from bare
// timestamp presence: an all-stale fabric is stale, not live. Offline-only
// and empty fabrics report none.
function heartbeatLane(nodes) {
  let stale = false, unknown = false;
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    if (n.liveness === 'online') return 'live';
    if (n.liveness === 'stale') stale = true;
    else if (n.liveness === 'unknown') unknown = true;
  }
  if (stale) return 'stale';
  if (unknown) return 'unknown';
  return 'none';
}

export function buildFabricFlow({ status, usage, nowMs }) {
  const now = safeNow(nowMs);
  const items = status && Array.isArray(status.items) ? status.items : [];
  const nodes = [];
  for (const raw of items) {
    const node = flowNode(raw);
    if (node) nodes.push(node);
  }
  const summary = status && status.summary && typeof status.summary === 'object' ? status.summary : null;
  const validCounts = !!summary && ['online', 'stale', 'offline', 'unknown'].every((k) => isCount(summary[k]));
  const counts = validCounts
    ? { online: summary.online, stale: summary.stale, offline: summary.offline, unknown: summary.unknown }
    : nodes.reduce((t, n) => ({ ...t, [n.liveness]: t[n.liveness] + 1 }),
      { online: 0, stale: 0, offline: 0, unknown: 0 });
  const total = status && isCount(status.total) ? status.total : nodes.length;
  const totals = usage && usage.totals && typeof usage.totals === 'object' ? usage.totals : null;
  // Absent-vs-zero: costs stay null (unknown) unless every contributing row
  // carried a real number; the /api/usage contract guarantees this, so the
  // flow view repeats it instead of summing around gaps.
  // Costs live in a non-negative domain: negatives fail closed to unknown.
  const costOrNull = (v) => (v === null || v === undefined || !(typeof v === 'number' && Number.isFinite(v) && v >= 0) ? null : v);
  const usageTotals = totals
    ? {
      requests: isCount(totals.requests) ? totals.requests : null,
      tokensIn: isCount(totals.tokensIn) ? totals.tokensIn : null,
      tokensOut: isCount(totals.tokensOut) ? totals.tokensOut : null,
      modelCostUsd: costOrNull(totals.modelCostUsd),
      executionCostUsd: costOrNull(totals.executionCostUsd),
    }
    : null;
  // A totals object whose every value is absent measures nothing: the result
  // edge stays unavailable rather than presenting an empty summary.
  const measuredTotals = usageTotals && (usageTotals.requests !== null || usageTotals.tokensIn !== null
    || usageTotals.tokensOut !== null || usageTotals.modelCostUsd !== null || usageTotals.executionCostUsd !== null);
  const lane = heartbeatLane(nodes);
  const laneLabels = {
    live: 'Heartbeat: fresh heartbeat seen (reachability only, never inference acceptance)',
    stale: 'Heartbeat: only stale heartbeats seen (reachability only, never inference acceptance)',
    unknown: 'Heartbeat: flags without heartbeat telemetry (reachability unproven)',
    none: 'No worker heartbeats seen',
  };
  return {
    schema: 'aipster.fabric-flow/1',
    generatedAt: now.toISOString(),
    staleAfterMs: STALE_AFTER_MS,
    demo: status ? status.demo === true : false,
    source: status && status.demo === true ? 'demo-fixture' : 'declared-resources',
    edges: {
      // No dispatch plane exists in this build (/api/jobs is disabled), so
      // request/result lanes are architectural labels, never live state.
      request: { state: 'architectural', label: 'Request (architectural: dispatch availability unverified in this view)' },
      result: {
        state: measuredTotals ? 'summarized' : 'unavailable',
        label: measuredTotals
          ? 'Result (architectural: usage totals only, no streamed results)'
          : 'Result unavailable: no measured usage',
      },
      heartbeat: { state: lane, label: laneLabels[lane] },
    },
    legend: [
      { key: 'request', state: 'architectural' },
      { key: 'result', state: 'architectural' },
      { key: 'heartbeat', state: lane },
      { key: 'resident', state: 'unsupported' },
      { key: 'cached', state: 'unsupported' },
      { key: 'unprovisioned', state: 'unsupported' },
    ],
    nodes,
    counts: { total, ...counts },
    countsSource: validCounts ? 'aggregate' : 'derived',
    // Absent-vs-zero: a missing shared count or truncation flag is unknown
    // (null), never zero-filled or assumed complete.
    sharedWithMe: status && isCount(status.sharedWithMe) ? status.sharedWithMe : null,
    itemsTruncated: status && typeof status.itemsTruncated === 'boolean' ? status.itemsTruncated : null,
    throughput: {
      state: 'unavailable',
      tokensPerSec: null,
      note: 'Throughput is unavailable: /api/usage reports cumulative '
        + 'requests/tokens/costs only, never measured tokens/sec. '
        + 'Unmeasured values stay null (unknown), never zero.',
    },
    usageTotals,
    // Page coverage for FINDING-1: usage totals sum the returned page, so the
    // view states how many of the universe rows they cover.
    usageCoverage: usageCoverageOf(usage),
  };
}

/**
 * Shell view-model for loading / unavailable / denied / error states.
 * Carries no resource data, so a denied shell cannot leak row contents.
 */
export function emptyFlow({ reason, detail }) {
  const ok = reason === 'loading' || reason === 'unavailable' || reason === 'denied' || reason === 'error';
  return {
    schema: 'aipster.fabric-flow/1',
    state: ok ? reason : 'error',
    detail: typeof detail === 'string' ? detail.slice(0, 300) : null,
    nodes: [],
    throughput: { state: 'unavailable', tokensPerSec: null, note: null },
    usageTotals: null,
  };
}

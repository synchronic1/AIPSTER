/* Built with Meta Muse. */
// Milestone 1 coverage view (PRD VIS07): one row per requested metric with
// its collector, release state, missing dependency, and most recent
// successful observation. No collector exists yet and execution-gated
// metrics cannot be measured while inference dispatch is dark, so every
// value stays null and every row names its gap. Coverage is measured
// independently of workload volume: a row never borrows jobs/usage counts,
// and null is never coerced to zero (PRD Section 10.1).
//
// This module never invents live metrics and never conflates DGM fixture
// runs with live harness execution: fixture verdicts are not observations
// of these metrics.

export const COVERAGE_SCHEMA_VERSION = 'admin.coverage.v1';

// The 16 requested metrics (PRD Section 10), also the allowlist behind
// GET /api/admin/v1/metrics. Single source: src/admin/router.mjs imports
// this list instead of carrying its own copy.
export const ADMIN_METRICS = Object.freeze([
  'incoming_requests', 'admitted_work', 'queue_depth', 'queue_wait_ms',
  'throughput_rps', 'throughput_tokens_per_s', 'latency_end_to_end_ms',
  'time_to_first_byte_ms', 'time_to_first_token_ms', 'token_usage_input',
  'token_usage_output', 'error_rate', 'retry_rate', 'hardware_utilization',
  'usable_capacity', 'cost',
]);

// Metrics that can only be measured by executing work through inference
// dispatch. While dispatch is dark (or its schema absent) they are
// `disabled`, never zero.
const EXECUTION_GATED = new Set([
  'admitted_work', 'queue_depth', 'queue_wait_ms', 'throughput_rps',
  'throughput_tokens_per_s', 'latency_end_to_end_ms',
  'time_to_first_byte_ms', 'time_to_first_token_ms', 'token_usage_input',
  'token_usage_output', 'error_rate', 'retry_rate', 'usable_capacity',
]);

// true = dispatch table present, false = absent, 'unknown' = the store
// itself could not be read. The error case must stay distinct from an
// absent schema (PRD T02): a read failure is not a missing dependency.
async function hasDispatchSchema(db) {
  try {
    const row = await db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_jobs'"
    ).bind().first();
    return !!(row && row.ok === 1);
  } catch {
    return 'unknown';
  }
}

export function coverageRow(metric, dispatchSchema) {
  // PRD VIS07 asks for a supported deployment/runtime per metric. No
  // runtime support has been measured for any metric, so the field is
  // declared and null — never invented, never borrowed from another pane.
  if (EXECUTION_GATED.has(metric)) {
    return {
      metric,
      collector: null,
      release_state: 'disabled',
      reason_code: dispatchSchema ? 'inference_dispatch_dark' : 'dispatch_schema_missing',
      supported_runtime: null,
      value: null,
      observed_at: null,
    };
  }
  return {
    metric,
    collector: null,
    release_state: 'not_instrumented',
    reason_code: 'collector_missing',
    supported_runtime: null,
    value: null,
    observed_at: null,
  };
}

export async function coverageSnapshot(db, nowMs = Date.now()) {
  const observedAt = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
  try {
    const dispatchSchema = await hasDispatchSchema(db);
    if (dispatchSchema === 'unknown') {
      // The store could not be read: report unavailable, not an
      // available table with a missing-schema reason.
      return {
        schema_version: COVERAGE_SCHEMA_VERSION,
        state: 'unavailable',
        reason_code: 'coverage_unavailable',
        observed_at: null,
        items: [],
        total: null,
      };
    }
    const items = ADMIN_METRICS.map((metric) => coverageRow(metric, dispatchSchema));
    return {
      schema_version: COVERAGE_SCHEMA_VERSION,
      state: 'available',
      observed_at: observedAt,
      items,
      total: items.length,
    };
  } catch {
    // A storage failure is not an empty feed: total stays null so no caller
    // can read a healthy-looking zero.
    return {
      schema_version: COVERAGE_SCHEMA_VERSION,
      state: 'unavailable',
      reason_code: 'coverage_unavailable',
      observed_at: null,
      items: [],
      total: null,
    };
  }
}

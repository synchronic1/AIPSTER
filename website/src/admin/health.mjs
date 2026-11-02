/* Built with Meta Muse. */
// Milestone 1 operations health (PRD OPS01): control-plane reachability,
// collector coverage, runtime compatibility, and dependency state from
// instrumented checks only. Nothing here changes infrastructure: the probe
// reads D1, the migration-created tables, and the process environment flags,
// then reports distinct disabled / pending / uninstrumented states instead
// of a healthy chart. No raw exception strings or request samples leave
// this module (PRD VIS08).
//
// Current-source notes (not stale scaffold remarks): inference dispatch
// exists (PR63, website/src/inference/*, migrations 0024/0025) but is dark
// unless INFERENCE_ENABLED is '1', so POST /api/jobs keeps its 501 with the
// flag off. There is no canonical `fabrics` table (fabric_nodes,
// invitations, connections, ... exist instead). DGM verdicts come from a
// flag-gated deterministic fixture table, never a live harness run.

export const HEALTH_SCHEMA_VERSION = 'admin.operations.health.v1';

async function tablePresent(db, name) {
  // A failed observation must reach readHealth's unavailable envelope;
  // only a successful query with no row establishes a missing table.
  const row = await db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).bind(name).first();
  return !!(row && row.ok === 1);
}

export async function readHealth(db, env, nowMs = Date.now()) {
  const observedAt = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
  try {
    // Control plane: the database answers, and the grant table the admin
    // API depends on exists. Any failure below fails closed to unavailable.
    await db.prepare('SELECT 1 AS ok').bind().first();
    const grants = await tablePresent(db, 'admin_grants');
    if (!grants) throw new Error('admin_grants missing');
    const dispatchSchema = await tablePresent(db, 'dispatch_jobs');
    const inferenceEnabled = !!env && env.INFERENCE_ENABLED === '1';
    return {
      schema_version: HEALTH_SCHEMA_VERSION,
      state: 'available',
      observed_at: observedAt,
      control_plane: { d1: 'reachable', admin_grants: 'present' },
      collectors: { state: 'not_instrumented', reason_code: 'collector_missing' },
      compatibility: {
        inference: inferenceEnabled && dispatchSchema ? 'enabled' : 'disabled',
        inference_reason_code: !dispatchSchema
          ? 'dispatch_schema_missing'
          : inferenceEnabled ? 'inference_dispatch_live' : 'inference_dispatch_dark',
        fabric_model: 'pending',
        fabric_reason_code: 'fabric_model_pending',
        // PRD OPS01 asks for worker version compatibility and runtime
        // readiness. No version or readiness probe exists yet, so both are
        // declared and null — never a healthy default.
        worker_versions: null,
        worker_versions_state: 'not_instrumented',
        runtime_readiness: null,
        runtime_readiness_state: 'not_instrumented',
        dgm_preview: 'fixture_only',
        dgm_preview_reason_code: 'dgm_fixture_preview',
      },
    };
  } catch {
    return {
      schema_version: HEALTH_SCHEMA_VERSION,
      state: 'unavailable',
      reason_code: 'health_check_failed',
      observed_at: null,
      control_plane: null,
      collectors: null,
      compatibility: null,
    };
  }
}

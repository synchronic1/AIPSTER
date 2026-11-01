-- Migration 0024: admitted inference dispatch store (lane L1).
-- Additive only: CREATE TABLE/INDEX IF NOT EXISTS, no ALTER, no DROP.
--
-- This is the real D1 authority behind website/src/inference/dispatch-store.mjs,
-- the store the internal coordinator (src/inference/dispatch-coordinator.mjs)
-- injects. Nothing here is wired to an HTTP route by this migration, and
-- POST /api/jobs stays 501 while INFERENCE_ENABLED is unset.
--
-- Accounting model (docs/eif-atomic-admission-contract.md):
--   * A budget hold is a conservative charge, not a promise to execute.
--     Grant pools charge the existing grants.used_tokens/used_jobs columns, so
--     every existing net-usage reader (grantUsage) stays correct; owner pools
--     charge dispatch_pool_usage.used_tokens. A release is a guarded decrement
--     by the exact owning hold, so counters can never go negative.
--   * dispatch_operations.phase is the operation state machine:
--     claimed -> holding -> admitted -> redeemed -> dispatched -> settled,
--     with released for compensated/cancelled work and uncertain_phase for a
--     step whose outcome is unknown. The admission CAS is one conditional
--     UPDATE over every exact operation-owned hold, the fence tombstone and
--     the live grant; later statements in the same batch are guarded on
--     changes() = 1, so a zero-row CAS applies nothing.
--   * dispatch_start_redemptions is the issuer-owned one-time start permit,
--     serialized with revoke by being in the same database. dispatch_fences is
--     the tombstone that forbids any later admit or start.
--   * dispatch_jobs is the bound CPU task queue: queued -> leased -> a single
--     terminal succeeded/failed/expired, with the worker's EIF-shaped result.
--   * dispatch_settlements is one row per operation, so the full admitted
--     envelope is charged exactly once.
-- No triggers: the test D1 harness splits migration files on semicolons, so a
-- trigger body would be torn apart. Guards live in the store's statement batch.

CREATE TABLE IF NOT EXISTS dispatch_admissions (
  admission_ref TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_revision INTEGER NOT NULL,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  incarnation TEXT NOT NULL,
  peer_node TEXT NOT NULL,
  peer_workspace TEXT NOT NULL,
  route TEXT NOT NULL,
  node_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  runtime_instance TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_fingerprint TEXT NOT NULL,
  max_tokens INTEGER NOT NULL,
  pools_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dispatch_admissions_principal
  ON dispatch_admissions(principal_id, tenant_id);
-- Per-principal live-admission cap counts principal_id + expires_at (0024 is
-- not applied yet, so this is still an additive in-place edit).
CREATE INDEX IF NOT EXISTS idx_dispatch_admissions_principal_expiry
  ON dispatch_admissions(principal_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_dispatch_admissions_grant
  ON dispatch_admissions(grant_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_admissions_expiry
  ON dispatch_admissions(expires_at);
-- Resource teardown deletes this resource's admissions before the resource row
-- (the resource_id FK would otherwise block DELETE /api/inventory/:id).
CREATE INDEX IF NOT EXISTS idx_dispatch_admissions_resource
  ON dispatch_admissions(resource_id);

CREATE TABLE IF NOT EXISTS dispatch_operations (
  op_id TEXT PRIMARY KEY,
  op_key TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  generation INTEGER NOT NULL,
  phase TEXT NOT NULL,
  job_id TEXT,
  uncertain_phase TEXT,
  uncertain_detail TEXT,
  cancel_intent INTEGER NOT NULL DEFAULT 0,
  settled_outcome TEXT,
  settled_digest TEXT,
  settled_job_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dispatch_operations_job ON dispatch_operations(job_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_operations_phase ON dispatch_operations(phase);
-- Per-principal retained-operation cap lookup. The store counts rows in every
-- phase, terminal phases included; this index is only the lookup path.
CREATE INDEX IF NOT EXISTS idx_dispatch_operations_principal_phase
  ON dispatch_operations(principal_id, phase);

CREATE TABLE IF NOT EXISTS dispatch_holds (
  hold_id TEXT PRIMARY KEY,
  op_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  pool_id TEXT NOT NULL,
  pool_kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  jobs INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(op_id, pool_id),
  CHECK (amount >= 0),
  CHECK (jobs >= 0),
  CHECK (state IN ('held', 'committed', 'released', 'charged')),
  CHECK (pool_kind IN ('grant', 'owner'))
);
CREATE INDEX IF NOT EXISTS idx_dispatch_holds_op ON dispatch_holds(op_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_holds_pool ON dispatch_holds(pool_id, state);

CREATE TABLE IF NOT EXISTS dispatch_pool_usage (
  pool_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  day TEXT NOT NULL,
  ceiling_tokens INTEGER NOT NULL,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (used_tokens >= 0),
  CHECK (ceiling_tokens >= 0),
  CHECK (used_tokens <= ceiling_tokens)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_pool_usage_owner
  ON dispatch_pool_usage(principal_id, day);
CREATE INDEX IF NOT EXISTS idx_dispatch_pool_usage_day ON dispatch_pool_usage(day);

CREATE TABLE IF NOT EXISTS dispatch_start_redemptions (
  op_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  redeemed_at TEXT NOT NULL,
  worker_node_id TEXT NOT NULL,
  worker_runtime_instance TEXT NOT NULL,
  PRIMARY KEY (op_id, generation)
);

CREATE TABLE IF NOT EXISTS dispatch_fences (
  op_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  fenced_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (op_id, generation)
);

CREATE TABLE IF NOT EXISTS dispatch_jobs (
  job_id TEXT PRIMARY KEY,
  op_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  resource_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  runtime_instance TEXT NOT NULL,
  model_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  deadline_at INTEGER NOT NULL,
  lease_id TEXT,
  leased_at TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(op_id, generation),
  CHECK (status IN ('queued', 'leased', 'succeeded', 'failed', 'expired'))
);
CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_queue ON dispatch_jobs(resource_id, status, deadline_at);
CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_lease ON dispatch_jobs(lease_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_status ON dispatch_jobs(status);

CREATE TABLE IF NOT EXISTS dispatch_settlements (
  op_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  settled_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dispatch_settlements_job ON dispatch_settlements(job_id);

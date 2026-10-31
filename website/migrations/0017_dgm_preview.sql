-- Built with Meta Muse.
-- Migration 0017: DGM fixture-preview runs and event/telemetry rows.
-- Two additive tables behind the DGM_PREVIEW_ENABLED flag (default off):
-- the Worker evaluates a deterministic fixture table (src/dgm/preview.mjs),
-- never the Python DGM harness. Runs carry only operator ids plus fixture
-- text; there are no cross-user joins and no held-out access.
-- dgm_preview_runs: one row per preview run. gates_json/provenance_json are
-- canonical JSON written once at creation (provenance is never mutated;
-- transitions only move `status`/`updated_at` and append events).
-- dgm_preview_events: the budget/event trace plus fixture telemetry rows
-- (env='fixture' inside body_json; no other env is ever written here).
-- The existing `audit` table records the operating-path trail
-- (dgm.preview.create|pause|resume|cancel) via the shared audit() helper.
-- Re-runnable (IF NOT EXISTS): no ALTERs, applies cleanly under both the
-- D1 migration journal and the test shim's full re-apply.
CREATE TABLE IF NOT EXISTS dgm_preview_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  fixture TEXT NOT NULL,
  held INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  envelope_label TEXT NOT NULL,
  advice_reason TEXT NOT NULL,
  budget_fits INTEGER NOT NULL,
  budget_reason TEXT NOT NULL,
  settlement TEXT NOT NULL,
  gates_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dgm_preview_runs_owner ON dgm_preview_runs(created_by, status);
CREATE TABLE IF NOT EXISTS dgm_preview_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES dgm_preview_runs(id),
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  body_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dgm_preview_events_run ON dgm_preview_events(run_id, seq);

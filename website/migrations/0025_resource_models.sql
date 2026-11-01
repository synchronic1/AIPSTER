-- Migration 0025: per-resource advertised model inventory (W1).
-- Additive only: CREATE TABLE IF NOT EXISTS, no ALTER, no DROP.
--
-- A worker may advertise the model ids its upstream (Ganglion or
-- llama-server) currently lists in GET /v1/models, carried in the heartbeat
-- body's optional `models` field. The heartbeat intake validates that list
-- strictly (at most 32 ids of at most 128 printable chars, plus the runtime
-- id) and upserts it here with the server's `observed_at`.
--
-- Freshness: a row is authoritative for the same window the dashboard uses
-- for "reachable" (STALE_AFTER_MS, 5 minutes). A heartbeat WITHOUT `models`
-- leaves the stored list and its observed_at untouched, so the list keeps
-- ageing: an old advertisement can never vouch for a model forever. Admission
-- refuses (409 MODEL_NOT_ADVERTISED) only while the row is fresh and lacks
-- the requested model; with no fresh row it keeps the pre-inventory
-- behaviour and reports model_advertised: false.
--
-- One list per resource: a worker serves one upstream runtime at a time, and
-- the stored runtime_id records which one produced the list.
CREATE TABLE IF NOT EXISTS resource_models (
  resource_id TEXT PRIMARY KEY REFERENCES resources(id),
  runtime_id TEXT NOT NULL,
  model_ids_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (runtime_id IN ('ganglion', 'llama-server'))
);

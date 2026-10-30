-- Built with Meta Muse.
-- Migration 0017: model/adapter catalog schema (read-only discovery,
-- compatibility, private assets, deployment jobs). Additive only.
--
-- node_capabilities: worker-reported capability snapshots. Written ONLY by
-- POST /api/resources/:id/capabilities under heartbeat-key auth; the server
-- stamps reported_at. Missing row = unknown, never zero-cost assumptions.
-- catalog_assets: Hub metadata cache rows (owner_id NULL, access 'public')
-- plus private user assets (owner_id set, access 'private'). Private rows
-- are tenant-filtered on every read; cross-tenant lookups 404 (T1).
-- catalog_asset_files: explicit file manifests (relpath/bytes/sha256).
-- Traversal/symlink names are rejected at write (T5); digests NULL until
-- a full pinned resolve.
-- catalog_uploads: bounded upload sessions (Phase 2). byte_ref stays NULL
-- until an object store is bound; finalize without storage returns
-- STORAGE_UNPROVISIONED rather than silently dropping bytes.
-- catalog_compat_cache: principal-aware decision cache. Keyed by
-- (principal, input fingerprint); short TTL; input/policy changes miss.
-- catalog_deployments + catalog_deployment_events: durable deployment jobs
-- (Phase 3). Worker lifecycle transport does not exist yet: jobs run
-- against a fake transport in tests and report WORKER_API_UNAVAILABLE live.

CREATE TABLE IF NOT EXISTS node_capabilities (
  node_id TEXT PRIMARY KEY REFERENCES resources(id),
  schema_version INTEGER NOT NULL DEFAULT 1,
  reported_at TEXT NOT NULL,
  os TEXT NOT NULL DEFAULT 'unknown',
  arch TEXT NOT NULL DEFAULT 'unknown',
  runtimes_json TEXT NOT NULL DEFAULT '[]',
  mem_json TEXT NOT NULL DEFAULT '{}',
  disk_json TEXT NOT NULL DEFAULT '{}',
  workload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS catalog_assets (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES "user"(id),
  source TEXT NOT NULL DEFAULT 'hub',
  repo TEXT NOT NULL DEFAULT '',
  revision TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'model',
  task TEXT NOT NULL DEFAULT 'unknown',
  arch TEXT NOT NULL DEFAULT 'unknown',
  format TEXT NOT NULL DEFAULT 'unknown',
  quant TEXT NOT NULL DEFAULT 'unknown',
  license_json TEXT NOT NULL DEFAULT '{}',
  access TEXT NOT NULL DEFAULT 'public',
  manifest_json TEXT NOT NULL DEFAULT '{}',
  validation TEXT NOT NULL DEFAULT 'unvalidated',
  base_asset_id TEXT REFERENCES catalog_assets(id),
  base_revision TEXT NOT NULL DEFAULT '',
  freshness_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catalog_assets_owner ON catalog_assets(owner_id);
CREATE INDEX IF NOT EXISTS idx_catalog_assets_repo ON catalog_assets(source, repo);

CREATE TABLE IF NOT EXISTS catalog_asset_files (
  asset_id TEXT NOT NULL REFERENCES catalog_assets(id),
  relpath TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  PRIMARY KEY (asset_id, relpath)
);

CREATE TABLE IF NOT EXISTS catalog_uploads (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  state TEXT NOT NULL DEFAULT 'uploading',
  quotas_json TEXT NOT NULL DEFAULT '{}',
  manifest_json TEXT NOT NULL DEFAULT '{}',
  byte_ref TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catalog_uploads_owner ON catalog_uploads(owner_id);

CREATE TABLE IF NOT EXISTS catalog_compat_cache (
  cache_key TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  fingerprint_json TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catalog_compat_principal ON catalog_compat_cache(principal);

CREATE TABLE IF NOT EXISTS catalog_deployments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  plan_json TEXT NOT NULL,
  plan_fingerprint TEXT NOT NULL,
  idem_key TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'queued',
  node_id TEXT NOT NULL DEFAULT '',
  runtime TEXT NOT NULL DEFAULT '',
  error_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catalog_deploy_owner ON catalog_deployments(owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_deploy_idem ON catalog_deployments(owner_id, idem_key);

CREATE TABLE IF NOT EXISTS catalog_deployment_events (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES catalog_deployments(id),
  at TEXT NOT NULL,
  from_state TEXT NOT NULL DEFAULT '',
  to_state TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_catalog_deploy_events ON catalog_deployment_events(deployment_id);

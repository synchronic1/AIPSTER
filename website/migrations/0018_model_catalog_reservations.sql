-- Built with Meta Muse.
-- Migration 0018: deployment reservations. A reservation holds node bytes
-- for one deployment from admission until terminal state (or release on
-- failure/cancel/revoke). Held bytes are subtracted from availability by
-- every later admission, which is what makes concurrent oversubscription
-- structurally impossible (AC18). States: held -> released.
CREATE TABLE IF NOT EXISTS catalog_reservations (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES catalog_deployments(id),
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  node_id TEXT NOT NULL REFERENCES resources(id),
  bytes INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'held',
  created_at TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_catalog_res_owner_node ON catalog_reservations(owner_id, node_id);
CREATE INDEX IF NOT EXISTS idx_catalog_res_deployment ON catalog_reservations(deployment_id);

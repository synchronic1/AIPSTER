-- Built with Meta Muse.
-- Migration 0014: worker pairing + registration hardening.
-- pairing_codes: short-lived single-use owner consent for one machine.
--   The browser mints a code (session-only); the worker exchanges it for a
--   resource row plus a resource-bound heartbeat key (docs/pairing.md). Only
--   the salted verifier is stored; the code is shown once at mint and never
--   again. node_id/resource_id record the winning claim so a lost-response
--   retry by the same node re-binds instead of duplicating.
-- resources.node_id: stable worker identity, unique per owner. Retries and
--   re-pairs find the existing row instead of inserting duplicates. NULL for
--   pre-pairing manual rows; SQLite treats NULLs as distinct, so no backfill.
-- idempotency_keys: replay map for POST /api/inventory Idempotency-Key.
-- Numbering: 0006-0012 remain reserved for the federation integration
-- lineage; 0014 continues past the 0013 heartbeat reservation (which still
-- needs federation-owner sign-off per docs/heartbeat-intake.md). Applies once
-- via the D1 migration journal: ALTERs are not re-runnable.
CREATE TABLE IF NOT EXISTS pairing_codes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  salt TEXT NOT NULL,
  verifier TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  node_id TEXT,
  resource_id TEXT REFERENCES resources(id)
);
CREATE INDEX IF NOT EXISTS idx_pairing_owner ON pairing_codes(owner_id);
ALTER TABLE resources ADD COLUMN node_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_owner_node ON resources(owner_id, node_id);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  key TEXT NOT NULL,
  resource_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, key)
);

-- Applied revision receipts. No backfill: old before-images cannot be inferred.
-- This follows the federation branch's 0008. Renumber together with that
-- branch's unapplied migration block when integrating with main.
CREATE TABLE IF NOT EXISTS fabric_revision_receipts (
  operation_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES fabric_grants(id),
  approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id),
  actor_id TEXT NOT NULL REFERENCES "user"(id),
  request_hash TEXT NOT NULL,
  approval_json TEXT NOT NULL,
  before_version INTEGER NOT NULL,
  after_version INTEGER NOT NULL CHECK (after_version = before_version + 1),
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  UNIQUE (grant_id, before_version)
);
-- Failure fences resolve an errored effect batch without guessing whether
-- an unknown/lost response committed. A late batch must check this fence.
CREATE TABLE IF NOT EXISTS fabric_revision_failures (
  operation_id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id),
  grant_id TEXT NOT NULL REFERENCES fabric_grants(id),
  request_hash TEXT NOT NULL,
  response_code INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  failed_at TEXT NOT NULL
);

-- Built with Meta Muse.
-- Migration 0016: administration grant table (scaffold).
-- admin_grants: explicit, server-assigned administration grants. One row
-- authorizes one user for one role; nothing is inferred from email domain,
-- OAuth session, or user API key. The admin API (src/admin/router.mjs)
-- checks live rows on every request: revoked or expired rows authorize
-- nothing. Grant issuance and revocation stay out-of-band in the scaffold
-- (operator SQL); there is no self-service grant endpoint.
-- Roles are allowlisted in code, never free text authority: an unknown
-- role value authorizes nothing. Scope is stored for the Milestone 1
-- design ('platform' is the only recognized scope in the scaffold).
-- expires_at is ISO-8601 UTC text; the live-grant check compares it
-- lexicographically against the current time, so non-ISO values deny.
-- Re-runnable (IF NOT EXISTS): no ALTERs, applies cleanly under both the
-- D1 migration journal and the test shim's full re-apply.
CREATE TABLE IF NOT EXISTS admin_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id),
  role TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'platform',
  expires_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_grants_user ON admin_grants(user_id);

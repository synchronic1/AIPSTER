-- Built with Meta Muse.
-- Migration 0002: AIPSTER application tables, adapted from the local
-- aipster-local schema.sql. Identity lives in the Better Auth "user" table;
-- every row carries owner_id = user.id for tenant isolation. No password
-- columns: GitHub OAuth only. Inference dispatch stays disabled; jobs rows
-- exist for future authorized use and read APIs.

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  cpu TEXT NOT NULL,
  gpu TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  configured INTEGER NOT NULL DEFAULT 0,
  authenticated INTEGER NOT NULL DEFAULT 0,
  online INTEGER NOT NULL DEFAULT 0,
  usable INTEGER NOT NULL DEFAULT 0,
  heartbeat_at TEXT,
  limits_json TEXT NOT NULL DEFAULT '{}',
  scope TEXT NOT NULL DEFAULT 'owner only',
  verification_json TEXT NOT NULL DEFAULT '{}',
  credits_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_owner ON resources(owner_id);

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  grantee_id TEXT NOT NULL REFERENCES "user"(id),
  max_jobs INTEGER NOT NULL,
  max_tokens INTEGER NOT NULL,
  used_jobs INTEGER NOT NULL DEFAULT 0,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  inference_only INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_grants_grantee ON grants(grantee_id);
CREATE INDEX IF NOT EXISTS idx_grants_resource ON grants(resource_id);

CREATE TABLE IF NOT EXISTS key_verifiers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  salt TEXT NOT NULL,
  verifier TEXT NOT NULL,
  prefix TEXT NOT NULL,
  expires_at TEXT,
  metadata TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_keys_owner ON key_verifiers(owner_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  resource_id TEXT NOT NULL REFERENCES resources(id),
  grant_id TEXT REFERENCES grants(id),
  adapter TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost_source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_id);

CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  kind TEXT NOT NULL,
  requests INTEGER NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  model_cost_usd REAL,
  execution_cost_usd REAL,
  cost_source TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_owner ON usage(owner_id);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit(actor_id);

-- Invited-test-user policy (assumed; see docs/cloudflare-integration-plan.md).
-- Signup for any verified email NOT in this table is rejected. Seed per
-- environment with wrangler d1 execute; never commit member emails.
CREATE TABLE IF NOT EXISTS allowlist (
  email TEXT PRIMARY KEY,
  added_at TEXT NOT NULL
);

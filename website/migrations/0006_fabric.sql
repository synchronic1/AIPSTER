-- Built with Meta Muse.
-- Migration 0005: federation control plane (F1). Invitations, connections,
-- previews, approvals, grants, denies, idempotency records, plus resource
-- incarnation/import tracking and API-key delegation/audience columns.
-- Applies once via the D1 migration journal (ALTERs are not re-runnable).
CREATE TABLE IF NOT EXISTS fabric_nodes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  workspace TEXT NOT NULL,
  label TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'fixture-0',
  transport TEXT NOT NULL DEFAULT 'fixture',
  issuer TEXT NOT NULL DEFAULT 'fixture-local',
  status TEXT NOT NULL DEFAULT 'registered',
  node_secret_verifier TEXT NOT NULL,
  node_secret_salt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fabric_nodes_owner ON fabric_nodes(owner_id);
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  issuer_node TEXT NOT NULL REFERENCES fabric_nodes(id),
  recipient_node TEXT NOT NULL,
  recipient_workspace TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  token_verifier TEXT NOT NULL,
  token_salt TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'issued',
  expiry TEXT NOT NULL,
  use_record TEXT,
  created_by TEXT NOT NULL REFERENCES "user"(id),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_invitations_recipient ON invitations(recipient_node, recipient_workspace);
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  a_node TEXT NOT NULL REFERENCES fabric_nodes(id),
  b_node TEXT NOT NULL REFERENCES fabric_nodes(id),
  a_workspace TEXT NOT NULL,
  b_workspace TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 1,
  created_by_invitation TEXT NOT NULL UNIQUE REFERENCES invitations(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connections_nodes ON connections(a_node, b_node);
CREATE TABLE IF NOT EXISTS grant_previews (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  canonical_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  revision_vector TEXT NOT NULL,
  expiry TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES "user"(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  target_id TEXT,
  preview_id TEXT REFERENCES grant_previews(id),
  preview_digest TEXT,
  revision_vector TEXT NOT NULL DEFAULT '{}',
  approver TEXT,
  interaction_ref TEXT,
  decision TEXT NOT NULL DEFAULT 'requested',
  expiry TEXT NOT NULL,
  consumed_at TEXT,
  created_by TEXT NOT NULL REFERENCES "user"(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fabric_grants (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  recipient_node TEXT NOT NULL,
  recipient_workspace TEXT NOT NULL,
  consumers TEXT NOT NULL DEFAULT '[]',
  snapshot TEXT NOT NULL DEFAULT '[]',
  actions TEXT NOT NULL DEFAULT '["infer"]',
  models TEXT NOT NULL DEFAULT '[]',
  ceilings TEXT NOT NULL DEFAULT '{}',
  route TEXT NOT NULL DEFAULT 'fixture',
  retention TEXT NOT NULL DEFAULT 'outputs-pinned-7d',
  expiry TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'enforced',
  version INTEGER NOT NULL DEFAULT 1,
  preview_hash TEXT NOT NULL,
  approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fabric_grants_recipient ON fabric_grants(recipient_node, recipient_workspace);
CREATE TABLE IF NOT EXISTS fabric_grant_revisions (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES fabric_grants(id),
  version INTEGER NOT NULL,
  terms_json TEXT NOT NULL,
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  superseded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fabric_denies (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  principal TEXT,
  resource_id TEXT,
  action TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency_records (
  idem_key TEXT NOT NULL,
  actor TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  response_code INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (idem_key, actor)
);
ALTER TABLE resources ADD COLUMN incarnation TEXT NOT NULL DEFAULT 'gen1';
ALTER TABLE resources ADD COLUMN imported_from TEXT;
ALTER TABLE key_verifiers ADD COLUMN peer_node TEXT;
ALTER TABLE key_verifiers ADD COLUMN audience TEXT;
ALTER TABLE key_verifiers ADD COLUMN delegate TEXT;

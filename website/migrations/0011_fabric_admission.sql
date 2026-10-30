-- Durable, bounded operation admissions. Never prune these on lease expiry:
-- deleting them would allow retries to consume quota twice or reset retention.
CREATE TABLE fabric_operation_admissions (
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  actor_kind TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  admitted_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, actor_kind, idem_key)
);

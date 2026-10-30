-- Atomic restriction outcomes let same-operation retries recover after an
-- unknown batch result without guessing from a later target version. Rows
-- are retained security evidence, bounded by the existing admission policy.
CREATE TABLE fabric_restriction_receipts (
  operation_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_body TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

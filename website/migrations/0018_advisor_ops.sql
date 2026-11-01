-- Built with Meta Muse.
-- Migration 0018: fabric adviser operations ledger.
-- advisor_ops: per-tenant idempotency + uncertain-outcome state for POST
-- /api/advisor. The op key binds one canonical input digest; retries with
-- the same key and digest reuse the operation, changed payloads are
-- rejected, and a lost provider response leaves state='uncertain' (never a
-- silent duplicate chargeable call). States: reserved|fetching|delivered|
-- failed|uncertain. Only sanitized receipts persist here — never raw tasks,
-- inventory snapshots, or provider outputs.
-- Numbering note: the unmerged catalog lane also proposes 0018/0019. If it
-- lands first, this file renumbers (release owner decides order); the table
-- name is collision-free either way. Applies once via the D1 journal.
CREATE TABLE IF NOT EXISTS advisor_ops (
  tenant_id TEXT NOT NULL REFERENCES "user"(id),
  op_key TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, op_key)
);
CREATE INDEX IF NOT EXISTS idx_advisor_ops_state ON advisor_ops(tenant_id, state);

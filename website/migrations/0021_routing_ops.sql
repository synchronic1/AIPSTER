-- Built with Meta Muse.
-- Migration 0021 (PROVISIONAL number): latency-first routing op ledger,
-- capacity reservations and bounded advice cache.
-- Numbering: main holds through 0018 (PR #58 merged); catalog intends
-- 0019/0020 per release direction. 0021 is free of all KNOWN claims but
-- awaits Claude's confirmation (see PR #50 coordination note). Renumbering
-- is mechanical: rename this file + update d1-shim MIGRATION_FILES and the
-- three test-list pins. Tables are additive and referenced nowhere else.
-- Gate 1 honesty: reservations are holds for a dispatch path that stays
-- 501-disabled; nothing here can execute inference.
CREATE TABLE IF NOT EXISTS routing_ops (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  state TEXT NOT NULL,
  source TEXT NOT NULL,
  ranking_json TEXT NOT NULL,
  failure_code TEXT,
  feature_digest TEXT,
  candidate_digest TEXT,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_routing_ops_request ON routing_ops(tenant_id, request_id);
CREATE INDEX IF NOT EXISTS idx_routing_ops_expiry ON routing_ops(state, expires_at);
CREATE TABLE IF NOT EXISTS routing_reservations (
  id TEXT PRIMARY KEY,
  op_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  jobs INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routing_res_op ON routing_reservations(op_id);
CREATE INDEX IF NOT EXISTS idx_routing_res_expiry ON routing_reservations(state, expires_at);
CREATE TABLE IF NOT EXISTS routing_advice_cache (
  cache_key TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routing_cache_tenant ON routing_advice_cache(tenant_id, expires_at);

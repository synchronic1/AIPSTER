-- Built with Meta Muse.
-- Migration 0005: per-user hourly write budget for public registration.
-- write_budget(user_id, window) counts mutating API calls per UTC-hour
-- bucket; the worker rejects writes past the hourly budget (429) and caps
-- stored objects per user. Additive and re-runnable. Run order:
-- 0001 -> 0002 -> 0003 -> 0004 -> 0005.
CREATE TABLE IF NOT EXISTS write_budget (
  user_id TEXT NOT NULL,
  window TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, window)
);
CREATE INDEX IF NOT EXISTS idx_write_budget_window ON write_budget (window);

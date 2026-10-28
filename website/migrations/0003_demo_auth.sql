-- Built with Meta Muse.
-- Migration 0003: demo username/password sign-in support.
-- 1) better-auth `username` plugin fields on "user" (maintained plugin, not
--    custom auth). 2) Demo-workspace flag: 1 = isolated demo tenant, server
--    sandbox restrictions enforced in src/worker.js. 3) rateLimit table for
--    better-auth database-backed throttling (model "rateLimit": key, count,
--    lastRequest). Run order: 0001 -> 0002 -> 0003.
-- Applies once via the D1 migration journal: SQLite has no
-- ADD COLUMN IF NOT EXISTS, so ALTERs are not re-runnable by design.
ALTER TABLE "user" ADD COLUMN username TEXT;
ALTER TABLE "user" ADD COLUMN displayUsername TEXT;
ALTER TABLE "user" ADD COLUMN demo INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_username ON "user"(username);
CREATE TABLE IF NOT EXISTS rateLimit (
  id TEXT PRIMARY KEY,
  "key" TEXT NOT NULL,
  count INTEGER NOT NULL,
  lastRequest INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ratelimit_key ON rateLimit("key");

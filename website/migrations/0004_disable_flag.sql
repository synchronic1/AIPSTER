-- Built with Meta Muse.
-- Migration 0004: explicit account-disable flag for membership revocation.
-- disabled = 1 stops new sessions (session-create hook) and stops existing
-- sessions and API keys from authorizing API calls (worker actorFrom).
-- Rollout-owner procedure pairs this with allowlist removal and key
-- revocation; see docs/cloudflare-integration-plan.md. Run order:
-- 0001 -> 0002 -> 0003 -> 0004. Applies once via the D1 migration journal:
-- SQLite has no ADD COLUMN IF NOT EXISTS, so ALTERs are not re-runnable.
ALTER TABLE "user" ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;

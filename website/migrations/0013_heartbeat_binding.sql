-- Built with Meta Muse.
-- Migration 0013: owner-confined heartbeat key binding.
-- Adds key_verifiers.resource_id: a heartbeat-scoped API key is bound to
-- exactly one resource at mint; read/inference keys leave it NULL. The
-- heartbeat intake endpoint matches key resource_id against the URL resource
-- id inside its single atomic UPDATE, so a stolen key is useless for any
-- other resource. Numbering: 0006-0012 are reserved for the federation
-- integration lineage (PR #14 -> #18 ordered plan); this 0013 reservation
-- requires federation-owner (Peter Medina) sign-off before merge, and must
-- be re-verified against the federation heads at PR time. See
-- docs/heartbeat-intake.md. Applies once via the D1 migration journal:
-- SQLite has no ADD COLUMN IF NOT EXISTS, so ALTERs are not re-runnable.
ALTER TABLE key_verifiers ADD COLUMN resource_id TEXT REFERENCES resources(id);
CREATE INDEX IF NOT EXISTS idx_keys_resource ON key_verifiers(resource_id);

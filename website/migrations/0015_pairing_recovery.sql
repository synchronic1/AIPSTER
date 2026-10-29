-- Built with Meta Muse.
-- Migration 0015: pairing-code invalidation + claim snapshots.
-- invalidated_at: set when the bound resource is deleted, so a spent code
--   can never resume after its resource is gone (round-4 R4-1: without it,
--   the incomplete-claim resume mistook a deletion tombstone for a crash
--   and revoked the replacement resource's sender key).
-- claim_json: snapshot of the winning claim's registration fields
--   (name/kind/cpu/gpu/capabilities), recorded at code consumption so a
--   crash between consumption and resource creation can recreate the row
--   on same-node retry (round-4 R4-4) instead of stranding the code.
-- Numbering continues past 0014; 0006-0012 stay federation-reserved.
-- Applies once via the D1 migration journal.
ALTER TABLE pairing_codes ADD COLUMN invalidated_at TEXT;
ALTER TABLE pairing_codes ADD COLUMN claim_json TEXT;

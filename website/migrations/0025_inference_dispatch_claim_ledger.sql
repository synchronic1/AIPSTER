-- Migration 0025: per-principal trailing claim ledger (PR63 round 2).
-- Additive only: CREATE TABLE/INDEX IF NOT EXISTS, no ALTER, no DROP, no trigger.
--
-- The claim path in website/src/inference/dispatch-store.mjs bounds writes, not
-- just rows: a principal may admit at most INFERENCE_DISPATCH_CLAIMS_PER_WINDOW
-- *new* operations in any trailing window (default 100 per hour). This is a
-- true sliding window, not a counter with an anchored reset -- a counter would
-- let 100 claims just before the reset and 100 just after through, i.e. 200
-- inside one hour.
--
-- One row per admitted claim; the store appends it in the same atomic D1 batch
-- as the guarded operation insert, and only when that insert wrote a row. A
-- refused claim, or a replay of a retained idempotency key, writes nothing
-- here, which is why a spent window costs zero row changes per attempt. Rows
-- outside the trailing window are deleted by the next admitted claim, so the
-- ledger holds at most one window of events per principal and survives
-- eviction or restart like the rest of the store.
--
-- Retained terminal history is pruned by age only (the replay window); the
-- documented retained bound is quota x windows per retention, not a deletion
-- trigger. The table is inert for a deployment that never constructs the
-- dispatch store.
CREATE TABLE IF NOT EXISTS dispatch_claim_events (
  principal_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dispatch_claim_events_window
  ON dispatch_claim_events(principal_id, claimed_at);

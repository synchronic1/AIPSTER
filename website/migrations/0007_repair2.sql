/* Built with Meta Muse. */
-- F1R2: independent veto set per connection (no peer consent replacement),
-- exporter binding + approval recency per grant (no stale-approval
-- overwrite, no ownership-drift authorization), and purge of pre-repair
-- secret-bearing idempotency responses.
ALTER TABLE connections ADD COLUMN vetoed_by TEXT;
-- Backfill: the recorded suspender becomes the sole vetoer. Node ids are
-- `node_<hex>`, so plain concatenation is a safe JSON string here.
UPDATE connections SET vetoed_by = '["' || suspended_by || '"]' WHERE suspended_by IS NOT NULL;
ALTER TABLE fabric_grants ADD COLUMN exporter_id TEXT;
UPDATE fabric_grants SET exporter_id = (SELECT r.owner_id FROM resources r WHERE r.id = json_extract(fabric_grants.snapshot, '$[0].resourceId'));
ALTER TABLE fabric_grants ADD COLUMN last_approval_id TEXT;
-- Pre-repair completed rows may persist raw one-time secrets; strip the
-- secret fields in place and mark the record. Read-path redaction
-- (store.mjs) backstops anything this misses.
UPDATE idempotency_records SET response_body = json_set(json_remove(response_body, '$.nodeSecret', '$.token', '$.secret'), '$.replayNote', 'Secret fields are shown once and are not stored for replay.') WHERE status = 'completed' AND (json_extract(response_body, '$.nodeSecret') IS NOT NULL OR json_extract(response_body, '$.token') IS NOT NULL OR json_extract(response_body, '$.secret') IS NOT NULL);

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
-- F1R3 correction: derive the exporter from the grant's own proposal
-- evidence (approval -> preview -> exporter node owner), scoped to the same
-- connection and recipient. The previous revision read the resource registry's
-- CURRENT owner, which the R2-6 probe proved can drift.
UPDATE fabric_grants SET exporter_id = (
  SELECT n.owner_id FROM approvals a
  JOIN grant_previews p ON p.id = a.preview_id
  JOIN fabric_nodes n ON n.id = json_extract(p.canonical_json, '$.exporterNode')
  WHERE a.id = fabric_grants.approval_id
    AND p.connection_id = fabric_grants.connection_id
    AND json_extract(p.canonical_json, '$.importerNode') = fabric_grants.recipient_node
    AND json_extract(p.canonical_json, '$.importerWorkspace') = fabric_grants.recipient_workspace
);
ALTER TABLE fabric_grants ADD COLUMN last_approval_id TEXT;
-- Backfill recency tracking for grants issued before repair2.
UPDATE fabric_grants SET last_approval_id = approval_id WHERE approval_id IS NOT NULL;
-- Pre-repair completed rows may persist raw one-time secrets; strip the
-- secret fields in place and mark the record. Read-path redaction
-- (store.mjs) backstops anything this misses.
UPDATE idempotency_records SET response_body = json_set(json_remove(response_body, '$.nodeSecret', '$.token', '$.secret'), '$.replayNote', 'Secret fields are shown once and are not stored for replay.') WHERE status = 'completed' AND (json_extract(response_body, '$.nodeSecret') IS NOT NULL OR json_extract(response_body, '$.token') IS NOT NULL OR json_extract(response_body, '$.secret') IS NOT NULL);

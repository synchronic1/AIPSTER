/* Built with Meta Muse. */
-- F1R3: invariant-first state-layer repair (side-owned veto ledger,
-- grant generation, approval issue/binding/consumption columns,
-- idempotency attempt fencing, grant quarantine, exporter
-- re-derivation, secret-bearing record quarantine).
--
-- Connection veto side rows: each restrictive side of a connection
-- holds its own veto row. A connection authorizes only when no veto
-- row exists. `epoch` records the connection version at veto time
-- (forensic; live checks join the connection row). No separate
-- incarnation column: every veto add/remove bumps `version`, so the
-- version IS the consent clock and cannot diverge from it.
CREATE TABLE IF NOT EXISTS connection_vetoes (
  connection_id TEXT NOT NULL REFERENCES connections(id),
  side_node TEXT NOT NULL REFERENCES fabric_nodes(id),
  epoch INTEGER NOT NULL DEFAULT 1,
  added_at TEXT NOT NULL,
  added_by TEXT NOT NULL,
  PRIMARY KEY (connection_id, side_node)
);
-- Fail closed on corrupt veto JSON before backfill: a restrictive
-- marker that cannot be parsed becomes a suspension, and the rule
-- below then vetoes both sides.
UPDATE connections SET state = 'suspended'
WHERE vetoed_by IS NOT NULL AND NOT json_valid(vetoed_by);
-- Backfill veto rows from the repair2 JSON veto arrays.
INSERT OR IGNORE INTO connection_vetoes (connection_id, side_node, epoch, added_at, added_by)
  SELECT c.id, j.value, 1, c.updated_at, 'migration-0008'
  FROM connections c, json_each(c.vetoed_by) AS j
  WHERE c.vetoed_by IS NOT NULL AND json_valid(c.vetoed_by);
-- Fail closed: a restrictive connection with no recorded vetoer gets a
-- veto row on BOTH sides so neither peer can unilaterally resume it.
INSERT OR IGNORE INTO connection_vetoes (connection_id, side_node, epoch, added_at, added_by)
  SELECT c.id, c.a_node, 1, c.updated_at, 'migration-0008-legacy' FROM connections c
  WHERE c.state != 'active'
    AND NOT EXISTS (SELECT 1 FROM connection_vetoes v WHERE v.connection_id = c.id)
  UNION ALL
  SELECT c.id, c.b_node, 1, c.updated_at, 'migration-0008-legacy' FROM connections c
  WHERE c.state != 'active'
    AND c.b_node IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM connection_vetoes v WHERE v.connection_id = c.id);
-- Causal per-connection grant generation: bumped by every grant
-- effect (commit/revise/pause/resume/revoke). Legacy targetless
-- approvals bind to it; any intervening grant mutation on the
-- connection invalidates them. A causal counter, not a clock.
ALTER TABLE connections ADD COLUMN grant_gen INTEGER NOT NULL DEFAULT 0;
-- Approval decision timing (forensic; ordered decisions).
ALTER TABLE approvals ADD COLUMN decided_at TEXT;
-- Issue bindings: the live connection coordinates the approval was
-- requested against. Consumption requires equality.
ALTER TABLE approvals ADD COLUMN issued_connection TEXT;
ALTER TABLE approvals ADD COLUMN issued_version INTEGER;
ALTER TABLE approvals ADD COLUMN issued_grant_gen INTEGER;
-- Exact target binding for grant.revise / grant.resume approvals.
ALTER TABLE approvals ADD COLUMN bound_grant_id TEXT;
ALTER TABLE approvals ADD COLUMN bound_grant_version INTEGER;
-- Shared cross-action consumption claim (one claimant wins, ever).
ALTER TABLE approvals ADD COLUMN consumed_by_op TEXT;
ALTER TABLE approvals ADD COLUMN consumed_action TEXT;
ALTER TABLE approvals ADD COLUMN consumed_target TEXT;
-- Idempotency attempt fencing: the current attempt token. Legacy
-- rows are NULL: replayable without a presented token, never
-- rebindable to a new attempt.
ALTER TABLE idempotency_records ADD COLUMN attempt TEXT;
-- Grant quarantine: forensically preserved but inert until re-issued.
ALTER TABLE fabric_grants ADD COLUMN quarantine_reason TEXT;
-- Fail-closed version backfill for pre-repair rows.
UPDATE connections SET version = 1 WHERE version IS NULL;
UPDATE fabric_grants SET version = 1 WHERE version IS NULL;
-- Re-derive EVERY exporter from proposal evidence (covers databases
-- migrated before the 0007 correction, which read the registry's
-- current owner). Rows whose stored issuer disagrees with the
-- proposal evidence are quarantined as suspect rather than silently
-- repaired into usable grants.
UPDATE fabric_grants
SET quarantine_reason = 'issuer-corrected-f1r3'
WHERE exporter_id IS NOT NULL AND exporter_id != (
  SELECT n.owner_id FROM approvals a
  JOIN grant_previews p ON p.id = a.preview_id
  JOIN fabric_nodes n ON n.id = json_extract(p.canonical_json, '$.exporterNode')
  WHERE a.id = fabric_grants.approval_id
    AND p.connection_id = fabric_grants.connection_id
    AND json_extract(p.canonical_json, '$.importerNode') = fabric_grants.recipient_node
    AND json_extract(p.canonical_json, '$.importerWorkspace') = fabric_grants.recipient_workspace
);
UPDATE fabric_grants SET exporter_id = (
  SELECT n.owner_id FROM approvals a
  JOIN grant_previews p ON p.id = a.preview_id
  JOIN fabric_nodes n ON n.id = json_extract(p.canonical_json, '$.exporterNode')
  WHERE a.id = fabric_grants.approval_id
    AND p.connection_id = fabric_grants.connection_id
    AND json_extract(p.canonical_json, '$.importerNode') = fabric_grants.recipient_node
    AND json_extract(p.canonical_json, '$.importerWorkspace') = fabric_grants.recipient_workspace
);
-- Unprovable issuer: inert.
UPDATE fabric_grants SET quarantine_reason = 'issuer-unprovable'
WHERE exporter_id IS NULL AND quarantine_reason IS NULL;
-- Changed rows: any snapshot entry whose CURRENT owner disagrees
-- with the evidence-derived issuer stays inert even when the issuer
-- itself is provable (authority is ambiguous: issuer or holder?).
UPDATE fabric_grants SET quarantine_reason = 'issuer-ambiguous'
WHERE quarantine_reason IS NULL AND exporter_id IS NOT NULL
  AND json_valid(snapshot) AND EXISTS (
    SELECT 1 FROM json_each(fabric_grants.snapshot) AS j
    JOIN resources r ON r.id = json_extract(j.value, '$.resourceId')
    WHERE r.owner_id != fabric_grants.exporter_id
  );
-- Malformed snapshots cannot be validated: inert.
UPDATE fabric_grants SET quarantine_reason = 'snapshot-invalid'
WHERE quarantine_reason IS NULL
  AND (NOT json_valid(snapshot) OR json_type(snapshot) != 'array');
-- Quarantine completed idempotency records with secret-bearing keys
-- at ANY depth (the repair2 purge stripped only top-level fields).
-- Key-based match via json_tree avoids false positives on model
-- names that merely contain those words as values. Quarantined rows
-- are never returned on replay.
UPDATE idempotency_records SET status = 'quarantined'
WHERE status = 'completed' AND json_valid(response_body)
  AND EXISTS (
    SELECT 1 FROM json_tree(idempotency_records.response_body)
    WHERE json_tree.key IN ('nodeSecret', 'token', 'secret')
  );
UPDATE idempotency_records SET status = 'quarantined'
WHERE status = 'completed' AND NOT json_valid(response_body);

-- Restrictive federation actions (revoke/pause/suspend/disconnect/decline) stay
-- available at budget or retention exhaustion, as main's revocation exemption
-- requires. Each owner gets one uncharged admission per (action, existing
-- target), shared by REST and MCP; repeats use the normal charged path.
-- Additive only: no existing admission is changed or deleted.
ALTER TABLE fabric_operation_admissions ADD COLUMN restriction TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS fabric_admission_restriction
  ON fabric_operation_admissions(owner_id, restriction) WHERE restriction IS NOT NULL;

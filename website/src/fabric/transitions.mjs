/* Built with Meta Muse. */
// Single-effect batch runner + per-mutation batch builders (F1R3).
// Every builder returns an array of [sql, ...params] tuples executed
// as ONE db.batch (one SQL transaction on D1). Effects are
// conditional and re-pin their own mutable dependencies inline;
// zero-row effects are detected via meta.changes and mapped by the
// caller. No builder depends on ledger rows: direct store callers
// have no ledger entry, so effects are fenced by claims,
// fingerprints, and version CAS, never by idempotency state.

// Live-actor predicate fragment (? = actor user id). Demo sessions
// and disabled users authorize no fabric mutation.
export const ACTOR_LIVE = `EXISTS(SELECT 1 FROM "user" u WHERE u.id = ? AND u.disabled = 0 AND u.demo = 0)`;

// Whole-snapshot validation fragment (? = snapshot JSON array, ? =
// required owner). True unless some entry is missing, foreign-owned,
// re-incarnated, or imported. One fragment regardless of entry count.
export const SNAPSHOT_VALID = `NOT EXISTS(SELECT 1 FROM json_each(?) AS j LEFT JOIN resources r
  ON r.id = json_extract(j.value, '$.resourceId')
  WHERE r.id IS NULL OR r.owner_id != ? OR r.incarnation != json_extract(j.value, '$.incarnation') OR r.imported_from IS NOT NULL)`;

export async function runBatch(db, stmts) {
  return db.batch(stmts.map(([sql, ...params]) => db.prepare(sql).bind(...params)));
}

export function changes(results, i) {
  const m = results[i] && results[i].meta;
  return m ? Number(m.changes) : 0;
}

// ---- creators: conditional INSERT keyed by op-bound id ----

export function creatorInsert({ table, columns, values, id, actorId }) {
  const qs = values.map(() => '?').join(',');
  return [[`INSERT INTO ${table} (${columns.join(',')}) SELECT ${qs}
    WHERE NOT EXISTS(SELECT 1 FROM ${table} WHERE id = ?) AND ${ACTOR_LIVE}`, ...values, id, actorId]];
}

// ---- invitation accept: conditional flip + chained connection ----

export function acceptFlip({ invId, useRecord, now, actorId }) {
  return [`UPDATE invitations SET state = 'accepted', use_record = ?, decided_at = ?
    WHERE id = ? AND state = 'issued' AND expiry > ? AND ${ACTOR_LIVE}`, useRecord, now, invId, now, actorId];
}

export function acceptConnInsert({ connId, invId, aNode, bNode, aWs, bWs, useRecord, now }) {
  return [`INSERT INTO connections (id, a_node, b_node, a_workspace, b_workspace, state, version, created_by_invitation, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?
    WHERE EXISTS(SELECT 1 FROM invitations WHERE id = ? AND state = 'accepted' AND use_record = ?)`,
    connId, aNode, bNode, aWs, bWs, invId, now, now, invId, useRecord];
}

// ---- acceptance recovery: completes only a durably accepted invitation ----
// Re-pins the accepted state, the proven recipient, and a live actor in
// the same statement, so recovery can never resurrect a revoked,
// declined, expired, or still-issued invitation.

export function acceptRecoverInsert({ connId, invId, aNode, bNode, aWs, bWs, now, actorId }) {
  return [`INSERT INTO connections (id, a_node, b_node, a_workspace, b_workspace, state, version, created_by_invitation, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?
    WHERE EXISTS(SELECT 1 FROM invitations WHERE id = ? AND state = 'accepted' AND recipient_node = ? AND recipient_workspace = ?)
    AND NOT EXISTS(SELECT 1 FROM connections WHERE created_by_invitation = ?) AND ${ACTOR_LIVE}`,
    connId, aNode, bNode, aWs, bWs, invId, now, now, invId, bNode, bWs, invId, actorId];
}

// ---- veto add: version-pinned restriction first, veto row chained on it ----

export function vetoRestrict({ connId, side, version, newState, mirror, now, actorId }) {
  const newV = Number(version) + 1;
  return [
    [`UPDATE connections SET state = ?, suspended_by = ?, vetoed_by = ?, version = ?, updated_at = ?
      WHERE id = ? AND version = ? AND state IN ('active','suspended') AND ${ACTOR_LIVE}`,
      newState, side, mirror, newV, now, connId, version, actorId],
    [`INSERT OR IGNORE INTO connection_vetoes (connection_id, side_node, epoch, added_at, added_by)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM connections c WHERE c.id = ? AND c.version = ? AND c.suspended_by = ?)`,
      connId, side, newV, now, actorId, connId, newV, side]
  ];
}

// ---- veto withdraw: delete proven sides, then version-pinned derivation ----
// A zero-row UPDATE does not roll the batch back, so the DELETE carries
// every predicate the UPDATE does (pre-delete form of the count): a
// withdrawal that loses the version race or the actor check deletes
// nothing, and a DELETE that lands guarantees the UPDATE lands.

export function vetoWithdraw({ connId, sides, version, newState, suspendedBy, mirror, remaining, now, actorId }) {
  const newV = Number(version) + 1;
  const qs = sides.map(() => '?').join(',');
  return [
    [`DELETE FROM connection_vetoes WHERE connection_id = ? AND side_node IN (${qs})
      AND EXISTS(SELECT 1 FROM connections c WHERE c.id = ? AND c.version = ? AND c.state != 'active') AND ${ACTOR_LIVE}
      AND (SELECT count(*) FROM connection_vetoes WHERE connection_id = ? AND side_node IN (${qs})) = ?
      AND (SELECT count(*) FROM connection_vetoes WHERE connection_id = ?) = ?`,
      connId, ...sides, connId, version, actorId, connId, ...sides, sides.length, connId, remaining + sides.length],
    [`UPDATE connections SET state = ?, suspended_by = ?, vetoed_by = ?, version = ?, updated_at = ?
      WHERE id = ? AND version = ? AND state != 'active' AND ${ACTOR_LIVE}
      AND (SELECT count(*) FROM connection_vetoes WHERE connection_id = ?) = ?`,
      newState, suspendedBy, mirror, newV, now, connId, version, actorId, connId, remaining]
  ];
}

// ---- grant insert (commit): live-connection + whole-snapshot guards ----

export function grantInsert({ row, snapshotJson, exporterId, connId, connVersion, actorId }) {
  const cols = ['id', 'connection_id', 'recipient_node', 'recipient_workspace', 'consumers', 'snapshot', 'actions', 'models', 'ceilings', 'route', 'retention', 'expiry', 'status', 'version', 'preview_hash', 'approval_id', 'exporter_id', 'last_approval_id', 'created_at', 'updated_at'];
  const qs = cols.map(() => '?').join(',');
  return [
    [`INSERT INTO fabric_grants (${cols.join(',')}) SELECT ${qs}
      WHERE EXISTS(SELECT 1 FROM connections c WHERE c.id = ? AND c.state = 'active' AND c.version = ?)
      AND ${SNAPSHOT_VALID} AND ${ACTOR_LIVE}`,
      ...cols.map((c) => row[c]), connId, connVersion, snapshotJson, exporterId, actorId],
    [`UPDATE connections SET grant_gen = grant_gen + 1 WHERE id = ? AND EXISTS(SELECT 1 FROM fabric_grants WHERE id = ?)`,
      connId, row.id]
  ];
}

// ---- grant revise: status-preserving update, consumers first ----

export function grantRevise({ id, version, sets, snapshotJson, exporterId, connId, connVersion, apprId, actorId, receipt }) {
  const newV = Number(version) + 1;
  return [
    [`UPDATE fabric_grants SET consumers = ?, snapshot = ?, models = ?, ceilings = ?, expiry = ?, version = ?, preview_hash = ?, last_approval_id = ?, updated_at = ?
      WHERE id = ? AND version = ? AND status != 'revoked' AND quarantine_reason IS NULL AND ${ACTOR_LIVE}
      AND NOT EXISTS(SELECT 1 FROM fabric_revision_failures WHERE operation_id = ?)
      AND EXISTS(SELECT 1 FROM connections c WHERE c.id = ? AND c.state = 'active' AND c.version = ?) AND ${SNAPSHOT_VALID}`,
      sets.consumers, sets.snapshot, sets.models, sets.ceilings, sets.expiry, newV, sets.previewHash, apprId, sets.now,
      id, version, actorId, receipt.operationId, connId, connVersion, snapshotJson, exporterId],
    // Immediately follows the CAS in the same transaction: a zero-row
    // effect creates no receipt. SQL failures roll back both. Do not use
    // OR IGNORE: a conflicting receipt must roll back the effect.
    [`INSERT INTO fabric_revision_receipts (operation_id, grant_id, approval_id, actor_id, request_hash, approval_json, before_version, after_version, before_json, after_json, applied_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
      receipt.operationId, id, apprId, actorId, receipt.requestHash, receipt.approvalJson, version, newV, receipt.beforeJson, receipt.afterJson, sets.now],
    [`UPDATE connections SET grant_gen = grant_gen + 1 WHERE id = ? AND changes() = 1`, connId]
  ];
}

// ---- grant status moves: pause / revoke / resume ----
// `from` is one of 'enforced' | 'paused' | 'not-revoked' (internal
// constants only, never caller input). Resume pins the live
// connection; pause/revoke are fail-safe narrowing and need none.

export function grantStatus({ id, version, to, from, apprId, connId, connVersion, grantConnId, now, actorId }) {
  const newV = Number(version) + 1;
  const fromPred = from === 'not-revoked' ? `status != 'revoked'` : `status = ?`;
  const fromParam = from === 'not-revoked' ? [] : [from];
  const lastApprSql = apprId ? `, last_approval_id = ?` : '';
  const lastApprParam = apprId ? [apprId] : [];
  const connPinSql = connId ? ` AND EXISTS(SELECT 1 FROM connections c WHERE c.id = ? AND c.state = 'active' AND c.version = ?)` : '';
  const connPinParam = connId ? [connId, connVersion] : [];
  return [
    [`UPDATE fabric_grants SET status = ?, version = ?, updated_at = ?${lastApprSql}
      WHERE id = ? AND version = ? AND ${fromPred} AND quarantine_reason IS NULL AND ${ACTOR_LIVE}${connPinSql}`,
      to, newV, now, ...lastApprParam, id, version, ...fromParam, actorId, ...connPinParam],
    [`UPDATE connections SET grant_gen = grant_gen + 1 WHERE id = ? AND EXISTS(SELECT 1 FROM fabric_grants WHERE id = ? AND version = ? AND status = ?)`,
      grantConnId, id, newV, to]
  ];
}

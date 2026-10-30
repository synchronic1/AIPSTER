// Public REST/MCP admission: one hourly charge per durable mutation identity.
// The retained-operation ceiling also bounds new objects/history/audit records
// without expiring security evidence or making deletion replenish capacity.
import { budgetWindow, WRITE_BUDGET_PER_HOUR } from '../lib/quotas.js';
import { httpError } from '../lib/validate.js';

export const MAX_RETAINED_FABRIC_OPERATIONS = 10000;

// Security-reducing actions must work at exhaustion (main's revocation
// exemption). Each maps to (table, kind.action) so REST and MCP share one key.
const RESTRICTIVE_REST = /^\/v1\/fabric\/(grants|connections|invitations)\/([A-Za-z0-9_-]{1,64})\/(pause|revoke|suspend|disconnect|decline)$/;
const RESTRICTIVE_ACTIONS = {
  'grants/pause': 'grant.pause', 'grants/revoke': 'grant.revoke',
  'connections/suspend': 'connection.suspend', 'connections/disconnect': 'connection.disconnect',
  'invitations/decline': 'invitation.decline', 'invitations/revoke': 'invitation.revoke'
};
const RESTRICTIVE_TOOLS = {
  'fabric.pause_grant': 'grant.pause', 'fabric.revoke_grant': 'grant.revoke',
  'fabric.suspend_connection': 'connection.suspend', 'fabric.disconnect_connection': 'connection.disconnect',
  'fabric.decline_invitation': 'invitation.decline', 'fabric.revoke_invitation': 'invitation.revoke'
};
// The free slot is granted only when the store would accept the request: the
// caller owns the restricting side, the target is in an actionable state and
// (where the store requires it) expectedVersion is current. Bind order: id,
// owner, version. Others' or missing targets and stale requests take the
// charged path, so they neither consume the slot nor reveal existence.
const SIDE_OWNED = `EXISTS(SELECT 1 FROM fabric_nodes n WHERE n.owner_id = ? AND n.id IN (c.a_node, c.b_node))`;
const FREE_TARGETS = {
  'grant.pause': `SELECT 1 FROM fabric_grants WHERE id = ? AND exporter_id = ? AND quarantine_reason IS NULL AND status = 'enforced' AND version = ?`,
  'grant.revoke': `SELECT 1 FROM fabric_grants WHERE id = ? AND exporter_id = ? AND quarantine_reason IS NULL AND status <> 'revoked' AND version = ?`,
  'connection.suspend': `SELECT 1 FROM connections c WHERE c.id = ? AND ${SIDE_OWNED} AND c.state <> 'disconnected' AND c.version = ?`,
  'connection.disconnect': `SELECT 1 FROM connections c WHERE c.id = ? AND ${SIDE_OWNED} AND c.state <> 'disconnected' AND c.version = ?`,
  'invitation.decline': `SELECT 1 FROM invitations i WHERE i.id = ? AND i.state = 'issued' AND EXISTS(SELECT 1 FROM fabric_nodes n
    WHERE n.owner_id = ? AND n.id = i.recipient_node AND n.workspace = i.recipient_workspace)`,
  'invitation.revoke': `SELECT 1 FROM invitations i WHERE i.id = ? AND i.state = 'issued' AND EXISTS(SELECT 1 FROM fabric_nodes n
    WHERE n.owner_id = ? AND n.id = i.issuer_node)`
};
const VERSIONED = new Set(['grant.pause', 'grant.revoke', 'connection.suspend', 'connection.disconnect']);

// Returns { action, id, version } for a restrictive mutation, else null. MCP
// passes the tool name and its params; REST passes the path and JSON body.
export function restrictionOf(path, tool = null, input = null) {
  let action, id;
  if (tool) {
    action = RESTRICTIVE_TOOLS[tool]; id = input && input.id;
    if (!action || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  } else {
    const m = RESTRICTIVE_REST.exec(path);
    action = m && RESTRICTIVE_ACTIONS[`${m[1]}/${m[3]}`]; id = m && m[2];
    if (!action) return null;
  }
  if (!VERSIONED.has(action)) return { action, id, version: null };
  const version = Number(input && input.expectedVersion);
  return Number.isSafeInteger(version) && version > 0 ? { action, id, version } : null;
}

export async function admitFabricOperation(db, actor, method, path, key, requestHash, restriction = null) {
  const owner = actor.user.id, kind = actor.kind;
  const read = () => db.prepare('SELECT * FROM fabric_operation_admissions WHERE owner_id = ? AND actor_kind = ? AND idem_key = ?')
    .bind(owner, kind, key).first();
  const verify = row => {
    if (row.method !== method || row.path !== path || row.request_hash !== requestHash) {
      throw httpError(409, 'Idempotency-Key was already admitted for a different request.', 'IDEMPOTENCY_MISMATCH');
    }
  };
  const previous = await read();
  if (previous) { verify(previous); return; }
  const window = budgetWindow(), now = new Date().toISOString();
  // The insert, capacity predicates and shared budget increment serialize as
  // one D1 transaction. Concurrent duplicate keys have changes()=0 and pay zero.
  // A failure of any statement rolls back all; lost responses are recovered
  // by the durable admission row. No interactive transaction is assumed.
  //
  // A restrictive action first tries its one uncharged, ceiling-exempt slot for
  // (owner, action, target, current version); the partial unique index makes
  // concurrent or repeated attempts fall through to the normal charged insert,
  // which only runs when the free insert changed nothing. Versions advance only
  // through an applied restriction or a charged resume/revision, so free
  // admissions stay bounded; nothing is deleted and the ceiling is unchanged.
  const free = restriction && FREE_TARGETS[restriction.action];
  const freeArgs = restriction && [restriction.id, owner, ...(restriction.version === null ? [] : [restriction.version])];
  const charged = `INSERT OR IGNORE INTO fabric_operation_admissions
      (owner_id, actor_kind, idem_key, method, path, request_hash, admitted_at)
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE COALESCE((SELECT count FROM write_budget WHERE user_id = ? AND window = ?), 0) < ?
      AND (SELECT count(*) FROM fabric_operation_admissions WHERE owner_id = ?) < ?
      AND EXISTS(SELECT 1 FROM "user" WHERE id = ? AND disabled = 0 AND demo = 0)`;
  await db.batch([
    ...(free ? [db.prepare(`INSERT OR IGNORE INTO fabric_operation_admissions
      (owner_id, actor_kind, idem_key, method, path, request_hash, admitted_at, restriction)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS(${free})
      AND EXISTS(SELECT 1 FROM "user" WHERE id = ? AND disabled = 0 AND demo = 0)`)
      .bind(owner, kind, key, method, path, requestHash, now,
        `${restriction.action}:${restriction.id}:${restriction.version ?? ''}`, ...freeArgs, owner)] : []),
    db.prepare(free ? charged + ' AND changes() = 0' : charged)
      .bind(owner, kind, key, method, path, requestHash, now,
        owner, window, WRITE_BUDGET_PER_HOUR, owner, MAX_RETAINED_FABRIC_OPERATIONS, owner),
    db.prepare(`INSERT INTO write_budget(user_id, window, count)
      SELECT ?, ?, 1 WHERE changes() = 1
      ON CONFLICT(user_id, window) DO UPDATE SET count = count + 1`).bind(owner, window)
  ]);
  const admitted = await read();
  if (admitted) { verify(admitted); return; }
  const user = await db.prepare('SELECT disabled,demo FROM "user" WHERE id = ?').bind(owner).first();
  if (!user || Number(user.disabled)) throw httpError(401, 'Sign-in or API key required.', 'AUTH_REQUIRED');
  if (Number(user.demo)) throw httpError(403, 'Demo accounts cannot mutate federation.', 'DEMO_READ_ONLY');
  const retained = await db.prepare('SELECT count(*) n FROM fabric_operation_admissions WHERE owner_id = ?').bind(owner).first();
  if (retained.n >= MAX_RETAINED_FABRIC_OPERATIONS) {
    throw httpError(409, 'Federation retained-operation limit reached; operator review required. Existing retries remain available.', 'FABRIC_RETENTION_LIMIT');
  }
  throw httpError(429, 'Too many changes in this UTC hour. Try again later.', 'WRITE_RATE_LIMITED');
}

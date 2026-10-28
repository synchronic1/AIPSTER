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
const TARGET_TABLES = { grant: 'fabric_grants', connection: 'connections', invitation: 'invitations' };

// Returns { action, id } for a restrictive mutation, else null. MCP passes the
// tool name and its params; REST passes the request path.
export function restrictionOf(path, tool = null, params = null) {
  if (tool) {
    const action = RESTRICTIVE_TOOLS[tool], id = params && params.id;
    return action && typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? { action, id } : null;
  }
  const m = RESTRICTIVE_REST.exec(path);
  const action = m && RESTRICTIVE_ACTIONS[`${m[1]}/${m[3]}`];
  return action ? { action, id: m[2] } : null;
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
  // (owner, action, existing target); the partial unique index makes concurrent
  // or repeated attempts fall through to the normal charged insert, which only
  // runs when the free insert changed nothing. Growth stays bounded by existing
  // rows x six actions; nothing is deleted and the ceiling is unchanged.
  const free = restriction && TARGET_TABLES[restriction.action.split('.')[0]];
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
      WHERE EXISTS(SELECT 1 FROM ${free} WHERE id = ?)
      AND EXISTS(SELECT 1 FROM "user" WHERE id = ? AND disabled = 0 AND demo = 0)`)
      .bind(owner, kind, key, method, path, requestHash, now, `${restriction.action}:${restriction.id}`, restriction.id, owner)] : []),
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

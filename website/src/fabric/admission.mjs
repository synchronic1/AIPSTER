// Public REST/MCP admission: one hourly charge per durable mutation identity.
// The retained-operation ceiling also bounds new objects/history/audit records
// without expiring security evidence or making deletion replenish capacity.
import { budgetWindow, WRITE_BUDGET_PER_HOUR } from '../lib/quotas.js';
import { httpError } from '../lib/validate.js';

export const MAX_RETAINED_FABRIC_OPERATIONS = 10000;

export async function admitFabricOperation(db, actor, method, path, key, requestHash) {
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
  const window = budgetWindow();
  // The insert, capacity predicates and shared budget increment serialize as
  // one D1 transaction. Concurrent duplicate keys have changes()=0 and pay zero.
  // A failure of either statement rolls back both; lost responses are recovered
  // by the durable admission row. No interactive transaction is assumed.
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO fabric_operation_admissions
      (owner_id, actor_kind, idem_key, method, path, request_hash, admitted_at)
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE COALESCE((SELECT count FROM write_budget WHERE user_id = ? AND window = ?), 0) < ?
      AND (SELECT count(*) FROM fabric_operation_admissions WHERE owner_id = ?) < ?
      AND EXISTS(SELECT 1 FROM "user" WHERE id = ? AND disabled = 0 AND demo = 0)`)
      .bind(owner, kind, key, method, path, requestHash, new Date().toISOString(),
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

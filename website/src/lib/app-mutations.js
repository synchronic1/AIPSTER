/* Built with Meta Muse. */
// App mutation, audit and applicable write debit share one guarded D1 batch.
// No reliance on SQLite changes() carrying across batch statements.
import { first, rid16, nowIso } from './store.js';
import { budgetWindow, WRITE_BUDGET_PER_HOUR, MAX_GRANTS_PER_USER, MAX_KEYS_PER_USER, capError } from './quotas.js';
import { httpError } from './validate.js';

const userLive = 'EXISTS(SELECT 1 FROM "user" WHERE id=? AND disabled=0)';
const ownerReal = 'EXISTS(SELECT 1 FROM "user" WHERE id=? AND disabled=0 AND demo=0)';
const owns = 'EXISTS(SELECT 1 FROM resources WHERE id=? AND owner_id=?)';
const underBudget = 'COALESCE((SELECT count FROM write_budget WHERE user_id=? AND window=?),0) < ?';
const marker = 'EXISTS(SELECT 1 FROM audit WHERE id=?)';
const absentGrant = 'NOT EXISTS(SELECT 1 FROM grants WHERE resource_id=? AND grantee_id=? AND revoked_at IS NULL)';
const noResource = () => httpError(404, 'Resource not found or not yours.', 'NOT_FOUND');
const sameSandbox = () => httpError(403, 'Grants cannot cross the demo sandbox boundary.', 'DEMO_RESTRICTED');

async function commit(db, { owner, action, target, detail = '', at, gate, args, apply, window }) {
  const auditId = rid16('a_');
  const result = await db.batch([
    db.prepare(`INSERT INTO audit(id,at,actor_id,action,target,detail) SELECT ?,?,?,?,?,? WHERE ${gate}`)
      .bind(auditId, at, owner, action, target, detail, ...args),
    apply(auditId),
    ...(window ? [
      db.prepare(`INSERT INTO write_budget(user_id,window,count) SELECT ?,?,1 WHERE ${marker}
        ON CONFLICT(user_id,window) DO UPDATE SET count=count+1`).bind(owner, window, auditId)
    ] : []),
  ]);
  const rows = result.map(x => Number(x?.meta?.changes));
  if (rows.some(n => n !== rows[0]) || (rows[0] !== 0 && rows[0] !== 1)) {
    throw new Error('App write batch receipt mismatch');
  }
  return rows[0] === 1;
}

async function assertLive(db, owner) {
  const row = await first(db, 'SELECT disabled,demo FROM "user" WHERE id = ?', owner);
  if (!row || Number(row.disabled) !== 0) throw httpError(401, 'Sign-in or API key required.', 'AUTH_REQUIRED');
  return row;
}
async function assertBudget(db, owner, window) {
  const row = await first(db, 'SELECT count FROM write_budget WHERE user_id=? AND window=?', owner, window);
  if (row && Number(row.count) >= WRITE_BUDGET_PER_HOUR) {
    throw httpError(429, 'Too many changes in the last hour. Try again later.', 'WRITE_RATE_LIMITED');
  }
}

export async function createAppGrant(db, { owner, resource, grantee, maxJobs, maxTokens }) {
  const at = nowIso(), window = budgetWindow(new Date(at)), id = rid16('g_');
  const gate = `${ownerReal} AND ${owns} AND ${ownerReal} AND ?<>? AND ${absentGrant}
    AND (SELECT COUNT(*) FROM grants WHERE owner_id=? AND revoked_at IS NULL)<${MAX_GRANTS_PER_USER} AND ${underBudget}`;
  const done = await commit(db, {
    owner, action: 'grant.create', target: id, at, window,
    detail: `${resource} -> ${grantee.email}`.slice(0, 300), gate,
    args: [owner, resource, owner, grantee.id, owner, grantee.id, resource, grantee.id, owner, owner, window, WRITE_BUDGET_PER_HOUR],
    apply: aid => db.prepare(`INSERT INTO grants(id,resource_id,owner_id,grantee_id,max_jobs,max_tokens,used_jobs,used_tokens,inference_only,created_at,revoked_at)
      SELECT ?,?,?,?,?,?,0,0,1,?,NULL WHERE ${marker}`).bind(id, resource, owner, grantee.id, maxJobs, maxTokens, at, aid),
  });
  if (done) return first(db, 'SELECT * FROM grants WHERE id=? AND owner_id=?', id, owner);
  if (Number((await assertLive(db, owner)).demo)) throw sameSandbox();
  if (!await first(db, 'SELECT id FROM resources WHERE id=? AND owner_id=?', resource, owner)) throw noResource();
  const user = await first(db, 'SELECT demo,disabled FROM "user" WHERE id=?', grantee.id);
  if (!user || Number(user.disabled)) throw httpError(404, 'Grantee user not found.', 'USER_NOT_FOUND');
  if (Number(user.demo)) throw sameSandbox();
  if (await first(db, 'SELECT id FROM grants WHERE resource_id=? AND grantee_id=? AND revoked_at IS NULL', resource, grantee.id)) {
    throw httpError(409, 'An active grant already exists for this user and resource.', 'GRANT_EXISTS');
  }
  await assertBudget(db, owner, window);
  throw capError('grant');
}

export async function createAppKey(db, { id, owner, demo, name, scope, resource, salt, verifier, prefix, expiresAt, metadata }) {
  const at = nowIso(), window = budgetWindow(new Date(at));
  const gate = `EXISTS(SELECT 1 FROM "user" WHERE id=? AND disabled=0 AND demo=?)
    AND (? IS NULL OR (${owns} AND ?=0))
    AND (SELECT COUNT(*) FROM key_verifiers WHERE owner_id=? AND revoked_at IS NULL)<${MAX_KEYS_PER_USER} AND ${underBudget}`;
  const done = await commit(db, {
    owner, action: 'key.create', target: id, at, window, detail: resource ? `heartbeat:${resource}` : scope, gate,
    args: [owner, demo, resource, resource, owner, demo, owner, owner, window, WRITE_BUDGET_PER_HOUR],
    apply: aid => db.prepare(`INSERT INTO key_verifiers(id,owner_id,name,scope,resource_id,salt,verifier,prefix,expires_at,metadata,created_at,last_used_at,revoked_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,NULL,NULL WHERE ${marker}`)
      .bind(id, owner, name, scope, resource, salt, verifier, prefix, expiresAt, metadata, at, aid),
  });
  if (done) return first(db, 'SELECT * FROM key_verifiers WHERE id=? AND owner_id=?', id, owner);
  if (Number((await assertLive(db, owner)).demo) !== demo) throw httpError(401, 'Sign-in or API key required.', 'AUTH_REQUIRED');
  if (resource && !await first(db, 'SELECT id FROM resources WHERE id=? AND owner_id=?', resource, owner)) throw noResource();
  await assertBudget(db, owner, window);
  throw capError('key');
}

export async function revokeAppEntry(db, kind, owner, id) {
  // Internal allowlist; neither a request nor a database value can set a table.
  const table = kind === 'grant' ? 'grants' : kind === 'key' ? 'key_verifiers' : null;
  if (!table) throw new Error('Unknown app revocation kind');
  const at = nowIso();
  const done = await commit(db, {
    owner, action: `${kind}.revoke`, target: id, at,
    gate: `${userLive} AND EXISTS(SELECT 1 FROM ${table} WHERE id=? AND owner_id=? AND revoked_at IS NULL)`,
    args: [owner, id, owner],
    apply: aid => db.prepare(`UPDATE ${table} SET revoked_at=? WHERE id=? AND owner_id=? AND revoked_at IS NULL AND ${marker}`)
      .bind(at, id, owner, aid),
  });
  if (done) return true;
  await assertLive(db, owner);
  const row = await first(db, `SELECT revoked_at FROM ${table} WHERE id=? AND owner_id=?`, id, owner);
  return Boolean(row?.revoked_at);
}

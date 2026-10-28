// Restrictive federation actions stay available at budget/retention exhaustion
// (main's revocation exemption), bounded to one uncharged admission per
// (owner, action, existing target) across REST and MCP. Expansion is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fabricEnv, connectPair, commitFlow, S, freshKey, readJson } from './qa-helpers.mjs';
import { revisionFixture } from './revision-fixtures.mjs';
import { admitFabricOperation, restrictionOf, MAX_RETAINED_FABRIC_OPERATIONS } from '../src/fabric/admission.mjs';
import { budgetWindow } from '../src/lib/quotas.js';

const seedRetained = (db, owner, n) => db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
  INSERT INTO fabric_operation_admissions (owner_id, actor_kind, idem_key, method, path, request_hash, admitted_at)
  SELECT ?,'key','seed-'||x,'POST','/seed','hash','2026-01-01' FROM n`).bind(n, owner).run();

const currentConn = (t, id) => t.sqlite.prepare('SELECT version FROM connections WHERE id = ?').get(id).version;

async function setup(exhaust) {
  const t = await fabricEnv();
  const { conn } = await connectPair(t);
  const g1 = (await commitFlow(t, conn.id)).grant, g2 = (await commitFlow(t, conn.id)).grant;
  if (exhaust === 'hourly budget') t.sqlite.prepare('INSERT OR REPLACE INTO write_budget VALUES (?,?,120)').run(t.alice.id, budgetWindow());
  else await seedRetained(t.DB, t.alice.id, MAX_RETAINED_FABRIC_OPERATIONS);
  const post = (path, body = {}, key = freshKey(), user = t.alice) =>
    t.call(path, { method: 'POST', headers: S(t, user, { 'Idempotency-Key': key }), body }).then(readJson);
  const mcp = (tool, params, key = freshKey()) => post('/v1/fabric/mcp', { tool, params, idempotencyKey: key });
  const budget = () => (t.sqlite.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').get(t.alice.id, budgetWindow()) || { count: 0 }).count;
  return { t, conn, g1, g2, post, mcp, budget };
}

for (const exhaust of ['hourly budget', 'retention ceiling']) {
  const blocked = exhaust === 'hourly budget' ? 429 : 409;
  test(`${exhaust}: owner can still revoke, pause and suspend; expansion stays blocked`, async c => {
    const { t, conn, g1, g2, post, mcp, budget } = await setup(exhaust); c.after(() => t.sqlite.close());
    const before = budget();
    const revoke = await post(`/v1/fabric/grants/${g1.id}/revoke`, { expectedVersion: g1.version });
    assert.equal(revoke.status, 200, JSON.stringify(revoke.json));
    assert.equal(t.sqlite.prepare('SELECT status FROM fabric_grants WHERE id = ?').get(g1.id).status, 'revoked');
    assert.equal((await mcp('fabric.pause_grant', { id: g2.id, expectedVersion: g2.version })).status, 200);
    assert.equal((await post(`/v1/fabric/connections/${conn.id}/suspend`, { expectedVersion: currentConn(t, conn.id) })).status, 200);
    assert.equal(budget(), before, 'restrictive actions are not charged');
    // Expansion still fails closed at exhaustion.
    assert.equal((await post('/v1/fabric/nodes', { label: 'more' })).status, blocked);
    assert.equal((await mcp('fabric.resume_grant', { id: g2.id })).status, blocked);
    assert.equal((await post(`/v1/fabric/connections/${conn.id}/resume`)).status, blocked);
    // One free slot per (action, target), shared by REST and MCP: repeats take the charged path.
    assert.equal((await mcp('fabric.revoke_grant', { id: g1.id })).status, blocked);
    assert.equal((await post(`/v1/fabric/grants/${g2.id}/pause`)).status, blocked);
    // A nonexistent target never gets a free admission.
    assert.equal((await post('/v1/fabric/grants/g_does_not_exist/revoke')).status, blocked);
    const free = t.sqlite.prepare('SELECT restriction FROM fabric_operation_admissions WHERE restriction IS NOT NULL ORDER BY restriction').all().map(r => r.restriction);
    assert.deepEqual(free, [`connection.suspend:${conn.id}`, `grant.pause:${g2.id}`, `grant.revoke:${g1.id}`]);
    assert.equal(budget(), before);
  });
}

test('free restrictive admission replays, binds the request and keeps one audit record', async c => {
  const { t, g1, post, budget } = await setup('hourly budget'); c.after(() => t.sqlite.close());
  const key = freshKey();
  assert.equal((await post(`/v1/fabric/grants/${g1.id}/revoke`, { expectedVersion: g1.version }, key)).status, 200);
  const replay = await post(`/v1/fabric/grants/${g1.id}/revoke`, { expectedVersion: g1.version }, key);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.replayed, true);
  assert.equal((await post(`/v1/fabric/grants/${g1.id}/revoke`, { expectedVersion: 99 }, key)).status, 409);
  assert.equal(t.sqlite.prepare("SELECT count(*) n FROM audit WHERE action = 'fabric.grant.revoke'").get().n, 1);
  assert.equal(budget(), 120);
});

test('restrictive free path still requires a live owner and a well-formed target', async c => {
  const { t, g1 } = await setup('hourly budget'); c.after(() => t.sqlite.close());
  t.sqlite.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').run(t.alice.id);
  const path = `/v1/fabric/grants/${g1.id}/revoke`;
  await assert.rejects(admitFabricOperation(t.DB, { kind: 'session', user: { id: t.alice.id } }, 'POST', path, 'disabled', 'h', restrictionOf(path)),
    { code: 'AUTH_REQUIRED' });
  assert.equal(t.sqlite.prepare('SELECT count(*) n FROM fabric_operation_admissions WHERE restriction IS NOT NULL').get().n, 0);
  assert.equal(restrictionOf('/v1/fabric/mcp:fabric.revoke_grant', 'fabric.revoke_grant', { id: 'x/../y' }), null);
  assert.equal(restrictionOf('/v1/fabric/grants/g1/resume'), null);
  assert.equal(restrictionOf('/v1/fabric/mcp:fabric.resume_connection', 'fabric.resume_connection', { id: 'c1' }), null);
});

test('real local D1: concurrent restrictive admissions at exhaustion admit exactly one free slot', async c => {
  const t = await revisionFixture(true); c.after(t.close);
  await t.db.prepare('INSERT INTO write_budget VALUES (?,?,120)').bind('u_alice', budgetWindow()).run();
  const path = `/v1/fabric/grants/${t.grant}/revoke`, r = restrictionOf(path);
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
    admitFabricOperation(t.db, { ...t.alice, kind: i % 2 ? 'key' : 'session' }, 'POST', path, 'race-' + i, 'h', r)));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.ok(results.filter(x => x.status === 'rejected').every(x => x.reason.code === 'WRITE_RATE_LIMITED'));
  assert.equal((await t.db.prepare('SELECT count FROM write_budget WHERE user_id = ?').bind('u_alice').first()).count, 120);
  assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_operation_admissions WHERE restriction IS NOT NULL').first()).n, 1);
  // Nonexistent targets and repeats take the unchanged charged path.
  await assert.rejects(admitFabricOperation(t.db, t.alice, 'POST', '/v1/fabric/grants/missing/revoke', 'missing', 'h',
    restrictionOf('/v1/fabric/grants/missing/revoke')), { code: 'WRITE_RATE_LIMITED' });
  await t.db.prepare('UPDATE write_budget SET count = 0').run();
  await admitFabricOperation(t.db, t.alice, 'POST', path, 'charged-repeat', 'h', r);
  assert.equal((await t.db.prepare('SELECT count FROM write_budget WHERE user_id = ?').bind('u_alice').first()).count, 1);
});

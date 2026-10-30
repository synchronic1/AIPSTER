// Restrictive federation actions stay available at budget/retention exhaustion
// (main's revocation exemption), bounded to one uncharged admission per
// (owner, action, owned actionable target, current version) across REST and
// MCP. Expansion, others' targets and stale requests stay on the charged path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fabricEnv, connectPair, commitFlow, S, freshKey, readJson } from './qa-helpers.mjs';
import { revisionFixture } from './revision-fixtures.mjs';
import { admitFabricOperation, restrictionOf, MAX_RETAINED_FABRIC_OPERATIONS } from '../src/fabric/admission.mjs';
import { budgetWindow } from '../src/lib/quotas.js';

const seedRetained = (db, owner, n) => db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
  INSERT INTO fabric_operation_admissions (owner_id, actor_kind, idem_key, method, path, request_hash, admitted_at)
  SELECT ?,'key','seed-'||x,'POST','/seed','hash','2026-01-01' FROM n`).bind(n, owner).run();
const version = (t, table, id) => t.sqlite.prepare(`SELECT version FROM ${table} WHERE id = ?`).get(id).version;

async function setup(exhaust, who = ['alice']) {
  const t = await fabricEnv();
  const { conn } = await connectPair(t);
  const g1 = (await commitFlow(t, conn.id)).grant, g2 = (await commitFlow(t, conn.id)).grant;
  for (const name of who) {
    const id = t[name].id;
    if (exhaust === 'hourly budget') t.sqlite.prepare('INSERT OR REPLACE INTO write_budget VALUES (?,?,120)').run(id, budgetWindow());
    else await seedRetained(t.DB, id, MAX_RETAINED_FABRIC_OPERATIONS);
  }
  const post = (path, body = {}, key = freshKey(), user = t.alice) =>
    t.call(path, { method: 'POST', headers: S(t, user, { 'Idempotency-Key': key }), body }).then(readJson);
  const mcp = (tool, params, key = freshKey(), user = t.alice) => post('/v1/fabric/mcp', { tool, params, idempotencyKey: key }, freshKey(), user);
  const budget = (id = t.alice.id) => (t.sqlite.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').get(id, budgetWindow()) || { count: 0 }).count;
  const freeRows = () => t.sqlite.prepare('SELECT restriction FROM fabric_operation_admissions WHERE restriction IS NOT NULL ORDER BY restriction').all().map(r => r.restriction);
  return { t, conn, g1, g2, post, mcp, budget, freeRows };
}

for (const exhaust of ['hourly budget', 'retention ceiling']) {
  const blocked = exhaust === 'hourly budget' ? 429 : 409;
  test(`${exhaust}: owner can still revoke, pause and suspend; expansion stays blocked`, async c => {
    const { t, conn, g1, g2, post, mcp, budget, freeRows } = await setup(exhaust); c.after(() => t.sqlite.close());
    const before = budget(), connVersion = version(t, 'connections', conn.id);
    const revoke = await post(`/v1/fabric/grants/${g1.id}/revoke`, { expectedVersion: g1.version });
    assert.equal(revoke.status, 200, JSON.stringify(revoke.json));
    assert.equal(t.sqlite.prepare('SELECT status FROM fabric_grants WHERE id = ?').get(g1.id).status, 'revoked');
    assert.equal((await mcp('fabric.pause_grant', { id: g2.id, expectedVersion: g2.version })).status, 200);
    assert.equal((await post(`/v1/fabric/connections/${conn.id}/suspend`, { expectedVersion: connVersion })).status, 200);
    assert.equal(budget(), before, 'restrictive actions are not charged');
    // Expansion still fails closed at exhaustion.
    assert.equal((await post('/v1/fabric/nodes', { label: 'more' })).status, blocked);
    assert.equal((await mcp('fabric.resume_grant', { id: g2.id, expectedVersion: version(t, 'fabric_grants', g2.id) })).status, blocked);
    assert.equal((await post(`/v1/fabric/connections/${conn.id}/resume`, { expectedVersion: version(t, 'connections', conn.id) })).status, blocked);
    // Already-applied restrictions are no longer actionable, so repeats are charged (blocked here), over either transport.
    assert.equal((await mcp('fabric.revoke_grant', { id: g1.id, expectedVersion: version(t, 'fabric_grants', g1.id) })).status, blocked);
    assert.equal((await post(`/v1/fabric/grants/${g2.id}/pause`, { expectedVersion: version(t, 'fabric_grants', g2.id) })).status, blocked);
    // A nonexistent target never gets a free admission.
    assert.equal((await post('/v1/fabric/grants/g_does_not_exist/revoke', { expectedVersion: 1 })).status, blocked);
    assert.deepEqual(freeRows(), [`connection.suspend:${conn.id}:${connVersion}`, `grant.pause:${g2.id}:${g2.version}`, `grant.revoke:${g1.id}:${g1.version}`]);
    assert.equal(budget(), before);
  });
}

test('another tenant cannot spend or probe the free slot; responses match a missing target', async c => {
  const { t, g1, post, mcp, budget, freeRows } = await setup('hourly budget', ['alice', 'bob']); c.after(() => t.sqlite.close());
  // Bob is the importer, not the exporter: he cannot restrict alice's grant.
  const foreign = await post(`/v1/fabric/grants/${g1.id}/revoke`, { expectedVersion: g1.version }, freshKey(), t.bob);
  const missing = await post('/v1/fabric/grants/g_missing_target/revoke', { expectedVersion: 1 }, freshKey(), t.bob);
  assert.equal(foreign.status, 429);
  assert.deepEqual([foreign.status, foreign.json.code], [missing.status, missing.json.code], 'no existence oracle');
  assert.equal((await mcp('fabric.revoke_grant', { id: g1.id, expectedVersion: g1.version }, freshKey(), t.bob)).status, 429);
  assert.deepEqual(freeRows(), []);
  assert.equal(budget(t.bob.id), 120);
  // The owner's slot is untouched.
  assert.equal((await post(`/v1/fabric/grants/${g1.id}/revoke`, { expectedVersion: g1.version })).status, 200);
});

test('a stale or missing expectedVersion does not consume the free slot', async c => {
  const { t, conn, post, freeRows } = await setup('hourly budget'); c.after(() => t.sqlite.close());
  const current = version(t, 'connections', conn.id);
  assert.equal((await post(`/v1/fabric/connections/${conn.id}/suspend`, { expectedVersion: current + 7 })).status, 429);
  assert.equal((await post(`/v1/fabric/connections/${conn.id}/suspend`, {})).status, 429);
  assert.deepEqual(freeRows(), []);
  assert.equal((await post(`/v1/fabric/connections/${conn.id}/suspend`, { expectedVersion: current })).status, 200);
  assert.equal(t.sqlite.prepare('SELECT state FROM connections WHERE id = ?').get(conn.id).state, 'suspended');
});

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
  await assert.rejects(admitFabricOperation(t.DB, { kind: 'session', user: { id: t.alice.id } }, 'POST', path, 'disabled', 'h',
    restrictionOf(path, null, { expectedVersion: g1.version })), { code: 'AUTH_REQUIRED' });
  assert.equal(t.sqlite.prepare('SELECT count(*) n FROM fabric_operation_admissions WHERE restriction IS NOT NULL').get().n, 0);
  assert.equal(restrictionOf('/v1/fabric/mcp:fabric.revoke_grant', 'fabric.revoke_grant', { id: 'x/../y', expectedVersion: 1 }), null);
  assert.equal(restrictionOf(path, null, { expectedVersion: '1; DROP' }), null);
  assert.equal(restrictionOf('/v1/fabric/grants/g1/resume', null, { expectedVersion: 1 }), null);
  assert.equal(restrictionOf('/v1/fabric/mcp:fabric.resume_connection', 'fabric.resume_connection', { id: 'c1', expectedVersion: 1 }), null);
  assert.deepEqual(restrictionOf('/v1/fabric/invitations/i_1/decline'), { action: 'invitation.decline', id: 'i_1', version: null });
});

test('real local D1: concurrent restrictive admissions at exhaustion admit exactly one free slot', async c => {
  const t = await revisionFixture(true); c.after(t.close);
  for (const u of ['u_alice', 'u_bob']) await t.db.prepare('INSERT INTO write_budget VALUES (?,?,120)').bind(u, budgetWindow()).run();
  const v = (await t.db.prepare('SELECT version FROM fabric_grants WHERE id = ?').bind(t.grant).first()).version;
  const path = `/v1/fabric/grants/${t.grant}/revoke`, r = restrictionOf(path, null, { expectedVersion: v });
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
    admitFabricOperation(t.db, { ...t.alice, kind: i % 2 ? 'key' : 'session' }, 'POST', path, 'race-' + i, 'h', r)));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.ok(results.filter(x => x.status === 'rejected').every(x => x.reason.code === 'WRITE_RATE_LIMITED'));
  assert.equal((await t.db.prepare('SELECT count FROM write_budget WHERE user_id = ?').bind('u_alice').first()).count, 120);
  assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_operation_admissions WHERE restriction IS NOT NULL').first()).n, 1);
  // Others' targets, stale versions and repeats take the unchanged charged path.
  await assert.rejects(admitFabricOperation(t.db, t.bob, 'POST', path, 'foreign', 'h', r), { code: 'WRITE_RATE_LIMITED' });
  await assert.rejects(admitFabricOperation(t.db, t.alice, 'POST', path, 'stale', 'h',
    restrictionOf(path, null, { expectedVersion: v + 1 })), { code: 'WRITE_RATE_LIMITED' });
  await t.db.prepare('UPDATE write_budget SET count = 0').run();
  await admitFabricOperation(t.db, t.alice, 'POST', path, 'charged-repeat', 'h', r);
  assert.equal((await t.db.prepare('SELECT count FROM write_budget WHERE user_id = ?').bind('u_alice').first()).count, 1);
  assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_operation_admissions WHERE restriction IS NOT NULL').first()).n, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revisionFixture, faultOnce } from './revision-fixtures.mjs';
import { fabricEnv, S, freshKey, readJson } from './qa-helpers.mjs';
import { admitFabricOperation, MAX_RETAINED_FABRIC_OPERATIONS } from '../src/fabric/admission.mjs';
import { budgetWindow, checkWriteBudget } from '../src/lib/quotas.js';
import * as core from '../src/fabric/store.mjs';

for (const real of [false, true]) {
  const engine = real ? 'local D1' : 'sqlite';
  test(`${engine}: federation admission shares quota and serializes competing REST/MCP identities`, async c => {
    const t = await revisionFixture(real); c.after(t.close);
    await t.db.prepare('INSERT INTO write_budget VALUES (?,?,119)').bind('u_alice', budgetWindow()).run();
    const attempts = Array.from({ length: 12 }, (_, i) => () =>
      admitFabricOperation(t.db, { ...t.alice, kind: i % 2 ? 'key' : 'session' }, 'POST',
        i % 2 ? '/v1/fabric/mcp:fabric.register_node' : '/v1/fabric/nodes', 'race-' + i, 'same'));
    // The shim's nested savepoints support deterministic hooks, not independent
    // concurrent transactions on one SQLite connection. Actual concurrency is
    // exercised on workerd D1; the shim checks the equivalent serial boundary.
    const results = real ? await Promise.allSettled(attempts.map(run => run())) : [];
    if (!real) for (const run of attempts) results.push((await Promise.allSettled([run()]))[0]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'WRITE_RATE_LIMITED'));
    assert.equal((await t.db.prepare('SELECT count FROM write_budget WHERE user_id=?').bind('u_alice').first()).count, 120);
    assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_operation_admissions').first()).n, 1);
    await assert.rejects(checkWriteBudget(t.db, 'u_alice'), { code: 'WRITE_RATE_LIMITED' });
    await admitFabricOperation(t.db, t.bob, 'POST', '/v1/fabric/nodes', 'bob', 'same');
  });

  test(`${engine}: duplicate and lost-response admissions charge once; input mismatch cannot replay`, async c => {
    const t = await revisionFixture(real); c.after(t.close);
    const args = [t.alice, 'POST', '/v1/fabric/nodes', 'duplicate', 'original'];
    await assert.rejects(admitFabricOperation(faultOnce(t.db, /INSERT OR IGNORE INTO fabric_operation_admissions/, 'after', true), ...args));
    await Promise.all(Array.from({ length: 8 }, () => admitFabricOperation(t.db, ...args)));
    assert.equal((await t.db.prepare('SELECT count FROM write_budget WHERE user_id=?').bind('u_alice').first()).count, 1);
    await assert.rejects(admitFabricOperation(t.db, ...args.slice(0, -1), 'changed'), { code: 'IDEMPOTENCY_MISMATCH' });
    await t.db.prepare('UPDATE write_budget SET count=120 WHERE user_id=?').bind('u_alice').run();
    await admitFabricOperation(t.db, ...args); // recovery is available even after budget exhaustion
  });

  test(`${engine}: failed budget increment rolls back admission and retries do not lose capacity`, async c => {
    const t = await revisionFixture(real); c.after(t.close);
    await t.db.prepare("CREATE TRIGGER budget_fault BEFORE INSERT ON write_budget BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
    await assert.rejects(admitFabricOperation(t.db, t.alice, 'POST', '/v1/fabric/nodes', 'fault', 'hash'));
    assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_operation_admissions').first()).n, 0);
    await t.db.prepare('DROP TRIGGER budget_fault').run();
    await admitFabricOperation(t.db, t.alice, 'POST', '/v1/fabric/nodes', 'fault', 'hash');
    assert.equal((await t.db.prepare('SELECT count FROM write_budget').first()).count, 1);
  });

  test(`${engine}: lifetime retention cap is shared across actor kinds; old admission still recovers`, async c => {
    const t = await revisionFixture(real); c.after(t.close);
    await t.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
      INSERT INTO fabric_operation_admissions (owner_id, actor_kind, idem_key, method, path, request_hash, admitted_at) SELECT 'u_alice','key','seed-'||x,'POST','/seed','hash','2026-01-01' FROM n`)
      .bind(MAX_RETAINED_FABRIC_OPERATIONS).run();
    await assert.rejects(admitFabricOperation(t.db, t.alice, 'POST', '/v1/fabric/nodes', 'over', 'hash'), { code: 'FABRIC_RETENTION_LIMIT' });
    assert.equal((await t.db.prepare('SELECT count(*) n FROM write_budget').first()).n, 0);
    await admitFabricOperation(t.db, { ...t.alice, kind: 'key' }, 'POST', '/seed', 'seed-1', 'hash');
    await admitFabricOperation(t.db, t.bob, 'POST', '/v1/fabric/nodes', 'bob', 'hash');
  });
}

test('REST and MCP mutations use the same admission; reads/replays and invalid guards do not charge', async c => {
  const t = await fabricEnv(); c.after(() => t.sqlite.close());
  const request = (path, body, key = freshKey(), headers = S(t, t.alice, { 'Idempotency-Key': key })) =>
    t.call(path, { method: 'POST', headers, body }).then(readJson);
  const key = freshKey();
  assert.equal((await request('/v1/fabric/nodes', { label: 'rest' }, key)).status, 201);
  assert.equal((await request('/v1/fabric/nodes', { label: 'rest' }, key)).json.replayed, true);
  assert.equal((await request('/v1/fabric/mcp', { tool: 'fabric.register_node', params: { label: 'mcp' }, idempotencyKey: freshKey() })).status, 201);
  assert.equal((await request('/v1/fabric/mcp', { tool: 'fabric.list_nodes' })).status, 200);
  assert.equal((await request('/v1/fabric/nodes', { label: 'unauthorized' }, freshKey(), {})).status, 401);
  assert.equal(t.sqlite.prepare('SELECT count FROM write_budget WHERE user_id=?').get(t.alice.id).count, 2);
  t.sqlite.prepare('UPDATE write_budget SET count=120 WHERE user_id=?').run(t.alice.id);
  assert.equal((await request('/v1/fabric/nodes', { label: 'blocked' })).status, 429);
  assert.equal((await request('/v1/fabric/mcp', { tool: 'fabric.register_node', params: { label: 'blocked' }, idempotencyKey: freshKey() })).status, 429);
  assert.equal((await request('/v1/fabric/nodes', { label: 'rest' }, key)).json.replayed, true);
  assert.equal(t.sqlite.prepare('SELECT count(*) n FROM idempotency_records').get().n, 2);
});

test('REST and MCP deny deletion charge the same budget without deleting retained admissions', async c => {
  const t = await fabricEnv(); c.after(() => t.sqlite.close());
  const call = (path, method, body) => t.call(path, { method, body, headers: S(t, t.alice) }).then(readJson);
  const actor = { kind: 'session', user: { id: t.alice.id } };
  const deny = (await core.createDeny(t.DB, actor, {})).body.id;
  await admitFabricOperation(t.DB, actor, 'POST', '/fixture', 'retained', 'hash');
  assert.equal((await call('/v1/fabric/denies/' + deny, 'DELETE')).status, 200);
  const next = (await core.createDeny(t.DB, actor, {})).body.id;
  assert.equal((await call('/v1/fabric/mcp', 'POST', { tool: 'fabric.delete_deny', params: { id: next } })).status, 200);
  assert.equal(t.sqlite.prepare('SELECT count FROM write_budget WHERE user_id=?').get(t.alice.id).count, 3);
  assert.equal(t.sqlite.prepare('SELECT count(*) n FROM fabric_operation_admissions').get().n, 1);
});

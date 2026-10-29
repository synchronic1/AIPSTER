import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revisionFixture, faultOnce, assertComplete } from './revision-fixtures.mjs';
import * as core from '../src/fabric/store.mjs';
import { handleFabric } from '../src/fabric/router.mjs';

async function thirdUser(t) {
  await t.db.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)')
    .bind('u_charlie', 'Synthetic Charlie', 'charlie@synthetic.invalid', '2026-01-01', '2026-01-01').run();
  return { kind: 'session', user: { id: 'u_charlie' } };
}

async function routed(t, actor, path, input, key, db = t.db) {
  const url = new URL(path, 'https://synthetic.invalid');
  const request = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input) });
  const response = await handleFabric({ db, actor, url, request, env: { FEDERATION_ENABLED: '1' },
    json: (status, body) => Response.json(body, { status }),
    needAuthz: () => null, needSession: () => null, needCsrf: () => null, needNotDemo: () => null });
  return { status: response.status, body: await response.json() };
}

for (const real of [false, true]) {
  const engine = real ? 'local D1' : 'sqlite';
  test(`${engine}: consumed commit rejects third-owner approval-only replay without false audit`, async c => {
    const t = await revisionFixture(real); c.after(t.close);
    const input = await t.approval(100), op = { key: 'original-commit', path: '/v1/fabric/grants' };
    const grant = await core.commitGrant(t.db, t.alice, input, op);
    assert.equal(grant.status, 201);
    const charlie = await thirdUser(t);
    const audits = () => t.db.prepare("SELECT * FROM audit WHERE action = 'fabric.grant.commit' ORDER BY id").all();
    const before = (await audits()).results;
    const response = await routed(t, charlie, op.path, { approvalId: input.approvalId }, 'foreign-commit');
    const after = (await audits()).results;
    console.log(engine, 'foreign consumed commit:', JSON.stringify({ ...response, auditDelta: after.length - before.length }));
    assert.ok([403, 404].includes(response.status), 'foreign owner must not learn grant id: ' + JSON.stringify(response));
    assert.equal(JSON.stringify(response).includes(grant.body.id), false);
    assert.deepEqual(after, before);
  });

  for (const [boundary, pattern] of [
    ['history', /INSERT OR IGNORE INTO fabric_grant_revisions/],
    ['audit', /INSERT OR IGNORE INTO audit/],
  ]) test(`${engine}: revision ${boundary} repair survives later irreversible revoke`, async c => {
    const t = await revisionFixture(real); c.after(t.close);
    await assert.rejects(t.revise(faultOnce(t.db, pattern)));
    const applied = await t.state();
    assert.equal(applied.receipts.length, 1);
    assert.equal((await core.revokeGrant(t.db, t.alice, t.grant, { expectedVersion: 2 })).status, 200);
    const revoked = await t.state();
    const result = await t.revise();
    assert.deepEqual(result, { status: 200, body: { id: t.grant, version: 2 } });
    const recovered = await t.state();
    assert.equal(recovered.grant.status, 'revoked');
    assert.deepEqual(recovered.grant, revoked.grant);
    assert.equal(recovered.generation, revoked.generation);
    assertComplete(recovered, t.before, t.input, JSON.parse(applied.receipts[0].after_json));
    for (let i = 0; i < 3; i++) assert.deepEqual(await t.revise(), result);
    assert.deepEqual(await t.state(), recovered, 'repeated reconciliation preserves every persisted field');
    await assert.rejects(core.reviseGrant(t.db, t.alice, t.grant, t.input, { ...t.op, key: 'new-after-revoke' }), { code: 'BAD_STATE' });
    assert.deepEqual(await t.state(), recovered, 'fresh operation cannot use the historical receipt');
  });

  test(`${engine}: consumed commit binds exporter, preview, operation and live actor before audit recovery`, async c => {
    const t = await revisionFixture(real); c.after(t.close);
    const input = await t.approval(100), op = { key: 'bound-commit', path: '/v1/fabric/grants' };
    await assert.rejects(core.commitGrant(faultOnce(t.db, /INSERT OR IGNORE INTO audit/), t.alice, input, op));
    const row = await t.db.prepare('SELECT * FROM fabric_grants WHERE approval_id = ?').bind(input.approvalId).first();
    assert.ok(row);
    const auditCount = () => t.db.prepare("SELECT count(*) n FROM audit WHERE action = 'fabric.grant.commit' AND target = ?").bind(row.id).first();
    assert.equal((await auditCount()).n, 0);
    const charlie = await thirdUser(t);
    for (const actor of [t.bob, charlie]) {
      await assert.rejects(core.commitGrant(t.db, actor, input, op), { code: 'FORBIDDEN' });
    }
    for (const previewHash of [undefined, 'different']) {
      await assert.rejects(core.commitGrant(t.db, t.alice, { ...input, previewHash }, op), { code: 'PREVIEW_STALE' });
    }
    for (const other of [null, { ...op, key: 'other' }, { ...op, path: '/different' }]) {
      const out = await core.commitGrant(t.db, t.alice, input, other);
      assert.equal(out.status, 409);
      assert.equal(out.body.code, 'APPROVAL_CONSUMED');
    }
    for (const [flag, code] of [['disabled', 'AUTH_REQUIRED'], ['demo', 'DEMO_RESTRICTED']]) {
      await t.db.prepare(`UPDATE "user" SET ${flag} = 1 WHERE id = ?`).bind(t.alice.user.id).run();
      await assert.rejects(core.commitGrant(t.db, t.alice, input, op), { code });
      await t.db.prepare(`UPDATE "user" SET ${flag} = 0 WHERE id = ?`).bind(t.alice.user.id).run();
    }
    assert.equal((await auditCount()).n, 0, 'rejected replay cannot repair or falsely attribute an audit');
    // Original authorization is historical: later expiry/revoke cannot erase
    // a bound operation outcome, and recovery cannot revive the live grant.
    await t.db.prepare('UPDATE approvals SET expiry = ? WHERE id = ?').bind('2000-01-01', input.approvalId).run();
    await core.revokeGrant(t.db, t.alice, row.id, { expectedVersion: 1 });
    const revoked = await t.db.prepare('SELECT * FROM fabric_grants WHERE id = ?').bind(row.id).first();
    const recovered = await core.commitGrant(t.db, t.alice, input, op);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.id, row.id);
    assert.equal((await auditCount()).n, 1);
    assert.deepEqual(await core.commitGrant(t.db, t.alice, input, op), recovered);
    assert.equal((await auditCount()).n, 1);
    assert.deepEqual(await t.db.prepare('SELECT * FROM fabric_grants WHERE id = ?').bind(row.id).first(), revoked);
  });

  test(`${engine}: commit router repairs audit after revoke and lost ledger finalization`, async c => {
    const t = await revisionFixture(real); c.after(t.close);
    const input = await t.approval(100), path = '/v1/fabric/grants', key = 'router-commit-recovery';
    const failed = await routed(t, t.alice, path, input, key, faultOnce(t.db, /INSERT OR IGNORE INTO audit/));
    assert.equal(failed.status, 500);
    const grant = await t.db.prepare('SELECT * FROM fabric_grants WHERE approval_id = ?').bind(input.approvalId).first();
    assert.ok(grant);
    await core.revokeGrant(t.db, t.alice, grant.id, { expectedVersion: 1 });
    const revoked = await t.db.prepare('SELECT * FROM fabric_grants WHERE id = ?').bind(grant.id).first();
    const lost = faultOnce(t.db, /UPDATE idempotency_records SET status = \?, response_code/);
    assert.equal((await routed(t, t.alice, path, input, key, lost)).status, 500);
    await t.db.prepare("UPDATE idempotency_records SET created_at = '2000-01-01' WHERE idem_key = ? AND status = 'processing'").bind(key).run();
    for (let i = 0; i < 3; i++) {
      const replay = await routed(t, t.alice, path, input, key);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.id, grant.id);
    }
    assert.equal((await routed(t, t.alice, path, { ...input, previewHash: 'changed' }, key)).status, 409);
    assert.deepEqual(await t.db.prepare('SELECT * FROM fabric_grants WHERE id = ?').bind(grant.id).first(), revoked);
    assert.equal((await t.db.prepare("SELECT count(*) n FROM audit WHERE action = 'fabric.grant.commit' AND target = ?").bind(grant.id).first()).n, 1);
    assert.equal((await t.db.prepare('SELECT response_code FROM idempotency_records WHERE idem_key = ?').bind(key).first()).response_code, 200);
  });

  test(`${engine}: revision router completes receipt after revoke without terminalizing a failed replay`, async c => {
    const t = await revisionFixture(real); c.after(t.close);
    const path = `/v1/fabric/grants/${t.grant}/revise`, key = 'router-revision-recovery';
    const op = { path, key };
    assert.equal((await routed(t, t.alice, path, t.input, key, faultOnce(t.db, /INSERT OR IGNORE INTO fabric_grant_revisions/))).status, 500);
    const applied = await t.state();
    await core.revokeGrant(t.db, t.alice, t.grant, { expectedVersion: 2 });
    const revoked = await t.state();
    await assert.rejects(core.reviseGrant(t.db, t.bob, t.grant, t.input, op), { code: 'FORBIDDEN' });
    await assert.rejects(core.reviseGrant(t.db, t.alice, t.grant, { ...t.input, previewHash: 'changed' }, op), { code: 'IDEMPOTENCY_CONFLICT' });
    await t.db.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').bind(t.alice.user.id).run();
    await assert.rejects(core.reviseGrant(t.db, t.alice, t.grant, t.input, op), { code: 'AUTH_REQUIRED' });
    await t.db.prepare('UPDATE "user" SET disabled = 0 WHERE id = ?').bind(t.alice.user.id).run();
    assert.deepEqual(await t.state(), revoked, 'unauthorized or mismatched calls cannot complete forensic records');
    const lost = faultOnce(t.db, /UPDATE idempotency_records SET status = \?, response_code/);
    assert.equal((await routed(t, t.alice, path, t.input, key, lost)).status, 500);
    await t.db.prepare("UPDATE idempotency_records SET created_at = '2000-01-01' WHERE idem_key = ? AND status = 'processing'").bind(key).run();
    for (let i = 0; i < 3; i++) {
      const replay = await routed(t, t.alice, path, t.input, key);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.version, 2);
    }
    const complete = await t.state();
    assert.deepEqual(complete.grant, revoked.grant);
    assert.equal(complete.generation, revoked.generation);
    assertComplete(complete, t.before, t.input, JSON.parse(applied.receipts[0].after_json));
    assert.equal((await t.db.prepare('SELECT response_code FROM idempotency_records WHERE idem_key = ?').bind(key).first()).response_code, 200);
    await assert.rejects(core.reviseGrant(t.db, t.alice, t.grant, t.input, { ...op, key: 'fresh-revision' }), { code: 'BAD_STATE' });
    assert.deepEqual(await t.state(), complete);
  });
}

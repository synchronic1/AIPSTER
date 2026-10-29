import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revisionFixture, faultOnce } from './revision-fixtures.mjs';
import * as core from '../src/fabric/store.mjs';
import { handleFabric } from '../src/fabric/router.mjs';
import { budgetWindow } from '../src/lib/quotas.js';

// Real router over a synthetic pre-authorized session. Session-cookie/CSRF/key
// verification is exercised separately by the public HTTP shim suites.
async function routed(t, action, id, input, key, db = t.db, mcp = false) {
  const grant = ['pause', 'revoke'].includes(action);
  const path = mcp ? '/v1/fabric/mcp' : `/v1/fabric/${grant ? 'grants' : 'connections'}/${id}/${action}`;
  const body = mcp ? { tool: `fabric.${action}_${grant ? 'grant' : 'connection'}`, params: { id, ...input }, idempotencyKey: key } : input;
  const url = new URL(path, 'https://synthetic.invalid');
  const request = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  const response = await handleFabric({ db, actor: t.alice, url, request, env: { FEDERATION_ENABLED: '1' },
    json: (status, data) => Response.json(data, { status }),
    needAuthz: () => null, needSession: () => null, needCsrf: () => null, needNotDemo: () => null });
  return { status: response.status, body: await response.json() };
}

for (const real of [false, true]) {
  const engine = real ? 'local D1' : 'sqlite';
  test(`${engine}: foreign actor cannot expire another owner's approval`, async c => {
    const t = await revisionFixture(real); c.after(t.close);
    await t.db.prepare("UPDATE approvals SET decision = 'requested', expiry = '2000-01-01' WHERE id = ?").bind(t.input.approvalId).run();
    const before = await t.db.prepare('SELECT * FROM approvals WHERE id = ?').bind(t.input.approvalId).first();
    await assert.rejects(core.decideApproval(t.db, t.bob, t.input.approvalId, { decision: 'approve' }), { code: 'FORBIDDEN' });
    const after = await t.db.prepare('SELECT * FROM approvals WHERE id = ?').bind(t.input.approvalId).first();
    assert.deepEqual(after, before);
  });

  test(`${engine}: approval expiry requires a live exporting owner`, async c => {
    const t = await revisionFixture(real); c.after(t.close);
    await t.db.prepare("UPDATE approvals SET decision = 'requested', expiry = '2000-01-01' WHERE id = ?").bind(t.input.approvalId).run();
    const before = await t.db.prepare('SELECT * FROM approvals WHERE id = ?').bind(t.input.approvalId).first();
    for (const [column, code] of [['disabled', 'AUTH_REQUIRED'], ['demo', 'DEMO_RESTRICTED']]) {
      await t.db.prepare(`UPDATE "user" SET ${column} = 1 WHERE id = ?`).bind(t.alice.user.id).run();
      await assert.rejects(core.decideApproval(t.db, t.alice, t.input.approvalId, { decision: 'approve' }), { code });
      assert.deepEqual(await t.db.prepare('SELECT * FROM approvals WHERE id = ?').bind(t.input.approvalId).first(), before);
      await t.db.prepare(`UPDATE "user" SET ${column} = 0 WHERE id = ?`).bind(t.alice.user.id).run();
    }
    await assert.rejects(core.decideApproval(t.db, t.alice, t.input.approvalId, { decision: 'approve' }), { code: 'APPROVAL_EXPIRED' });
    assert.equal((await t.db.prepare('SELECT decision FROM approvals WHERE id = ?').bind(t.input.approvalId).first()).decision, 'expired');
  });

  for (const action of ['pause', 'revoke', 'suspend', 'disconnect']) {
    test(`${engine}: ${action} does not lose its audit when audit persistence fails`, async c => {
      const t = await revisionFixture(real); c.after(t.close);
      const grant = ['pause', 'revoke'].includes(action), id = grant ? t.grant : t.conn;
      const table = grant ? 'fabric_grants' : 'connections';
      const event = `fabric.${grant ? 'grant' : 'connection'}.${action}`;
      const fn = core[`${action}${grant ? 'Grant' : 'Connection'}`];
      const before = await t.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
      const input = { expectedVersion: before.version }, op = { key: 'audit-retry', path: `/v1/fabric/${grant ? 'grants' : 'connections'}/${id}/${action}` };
      await t.db.prepare(`CREATE TRIGGER audit_fault BEFORE INSERT ON audit WHEN NEW.action = '${event}' BEGIN SELECT RAISE(ABORT,'synthetic audit fault'); END`).run();
      await assert.rejects(fn(t.db, t.alice, id, input, op));
      await t.db.prepare('DROP TRIGGER audit_fault').run();
      const retry = await fn(t.db, t.alice, id, input, op);
      assert.equal(retry.status, 200);
      assert.equal((await t.db.prepare('SELECT count(*) n FROM audit WHERE action = ? AND target = ?').bind(event, id).first()).n, 1);
      const after = await t.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
      assert.equal(after.version, before.version + 1);
      assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_restriction_receipts').first()).n, 1);
    });

    test(`${engine}: HTTP ${action} recovers lost batch and finalization at exhaustion`, async c => {
      const t = await revisionFixture(real); c.after(t.close);
      const grant = ['pause', 'revoke'].includes(action), id = grant ? t.grant : t.conn;
      const table = grant ? 'fabric_grants' : 'connections', event = `fabric.${grant ? 'grant' : 'connection'}.${action}`;
      const input = { expectedVersion: (await t.db.prepare(`SELECT version FROM ${table} WHERE id = ?`).bind(id).first()).version };
      await t.db.prepare('INSERT INTO write_budget VALUES (?,?,120)').bind(t.alice.user.id, budgetWindow()).run();
      const mcp = action === 'revoke' || action === 'disconnect', key = 'lost-batch-' + action;
      // Receipt SQL failure must roll back effect, veto/generation, and audit.
      const before = await t.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
      const generation = (await t.db.prepare('SELECT grant_gen FROM connections WHERE id = ?').bind(t.conn).first()).grant_gen;
      await t.db.prepare("CREATE TRIGGER receipt_fault BEFORE INSERT ON fabric_restriction_receipts BEGIN SELECT RAISE(ABORT,'receipt fault'); END").run();
      assert.equal((await routed(t, action, id, input, key, t.db, mcp)).status, 500);
      assert.deepEqual(await t.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first(), before);
      assert.equal((await t.db.prepare('SELECT grant_gen FROM connections WHERE id = ?').bind(t.conn).first()).grant_gen, generation);
      assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_restriction_receipts').first()).n, 0);
      await t.db.prepare('DROP TRIGGER receipt_fault').run();
      // Both the effect batch response and the HTTP ledger finalization are lost.
      const lostBatch = faultOnce(t.db, /INSERT INTO fabric_restriction_receipts/, 'after', true);
      const lostBoth = faultOnce(lostBatch, /UPDATE idempotency_records SET status = \?, response_code/, 'before');
      const interrupted = await routed(t, action, id, input, key, lostBoth, mcp);
      assert.equal(interrupted.status, 500);
      // A later valid restriction changes the live state before reconciliation.
      if (action === 'pause') await core.revokeGrant(t.db, t.alice, id, { expectedVersion: input.expectedVersion + 1 });
      if (action === 'suspend') await core.disconnectConnection(t.db, t.bob, id, { expectedVersion: input.expectedVersion + 1 });
      const saved = await t.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
      await t.db.prepare("UPDATE idempotency_records SET created_at = '2000-01-01' WHERE idem_key = ? AND status = 'processing'").bind(key).run();
      const expected = grant ? { id, status: action === 'pause' ? 'paused' : 'revoked' } : { id, state: action === 'suspend' ? 'suspended' : 'disconnected' };
      for (let i = 0; i < 3; i++) {
        const retry = await routed(t, action, id, input, key, t.db, mcp);
        assert.equal(retry.status, 200);
        const result = mcp ? retry.body.result : { id: retry.body.id, ...(grant ? { status: retry.body.status } : { state: retry.body.state }) };
        assert.deepEqual(result, expected);
      }
      assert.equal((await routed(t, action, id, { expectedVersion: 999 }, key, t.db, mcp)).status, 409);
      assert.deepEqual(await t.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first(), saved);
      assert.equal((await t.db.prepare('SELECT count(*) n FROM audit WHERE action = ? AND target = ?').bind(event, id).first()).n, 1);
      assert.equal((await t.db.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind(t.alice.user.id, budgetWindow()).first()).count, 120);
    });

    test(`${engine}: ${action} actor closure at the batch boundary leaves no receipt or effect`, async c => {
      const t = await revisionFixture(real); c.after(t.close);
      const grant = ['pause', 'revoke'].includes(action), id = grant ? t.grant : t.conn;
      const table = grant ? 'fabric_grants' : 'connections';
      const before = await t.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
      const generation = (await t.db.prepare('SELECT grant_gen FROM connections WHERE id = ?').bind(t.conn).first()).grant_gen;
      const db = faultOnce(t.db, /INSERT INTO fabric_restriction_receipts/, 'before', true, async () => {
        await t.db.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').bind(t.alice.user.id).run();
      });
      await assert.rejects(core[`${action}${grant ? 'Grant' : 'Connection'}`](db, t.alice, id,
        { expectedVersion: before.version }, { key: 'closed', path: '/' + action }), { code: 'AUTH_REQUIRED' });
      assert.deepEqual(await t.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first(), before);
      assert.equal((await t.db.prepare('SELECT grant_gen FROM connections WHERE id = ?').bind(t.conn).first()).grant_gen, generation);
      assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_restriction_receipts').first()).n, 0);
    });
  }
}

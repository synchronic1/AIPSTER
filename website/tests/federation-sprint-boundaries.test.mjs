import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revisionFixture, faultOnce } from './revision-fixtures.mjs';
import * as core from '../src/fabric/store.mjs';
import { handleFabric } from '../src/fabric/router.mjs';
import { budgetWindow } from '../src/lib/quotas.js';
import { MAX_RETAINED_FABRIC_OPERATIONS } from '../src/fabric/admission.mjs';

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

async function routedInvitation(t, actor, action, id, key, db = t.db, mcp = false, params = {}) {
  const url = new URL(mcp ? '/v1/fabric/mcp' : `/v1/fabric/invitations/${id}/${action}`, 'https://synthetic.invalid');
  const body = mcp ? { tool: `fabric.${action}_invitation`, params: { id, ...params }, idempotencyKey: key } : params;
  const request = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  const response = await handleFabric({ db, actor, url, request, env: { FEDERATION_ENABLED: '1' },
    json: (status, data) => Response.json(data, { status }),
    needAuthz: () => null, needSession: () => null, needCsrf: () => null, needNotDemo: () => null });
  return { status: response.status, body: await response.json() };
}

async function pending(t) {
  const conn = await t.db.prepare('SELECT * FROM connections WHERE id = ?').bind(t.conn).first();
  return (await core.createInvitation(t.db, t.alice, { issuerNode: conn.a_node, recipientNode: conn.b_node, recipientWorkspace: conn.b_workspace })).body;
}

function holdEffect(db) {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  return { ready, release, db: faultOnce(db, /INSERT INTO fabric_restriction_receipts/, 'before', true, async () => { entered(); await gate; }) };
}

for (const real of [false, true]) {
  const engine = real ? 'local D1' : 'sqlite';
  // Independent review found this lease-takeover sequence in the first repair.
  // Both attempts pass the initial receipt read before the original applies.
  for (const action of ['pause', 'revoke', 'suspend', 'disconnect', 'invitation.decline', 'invitation.revoke']) {
    test(`${engine}: ${action} lease takeover recovers the receipt after a zero-row CAS`, async c => {
      const t = await revisionFixture(real); c.after(t.close);
      const invitation = action.startsWith('invitation.'), name = invitation ? action.split('.')[1] : action;
      const grant = !invitation && ['pause', 'revoke'].includes(action);
      const inv = invitation ? await pending(t) : null;
      const id = invitation ? inv.id : grant ? t.grant : t.conn;
      const actor = action === 'invitation.decline' ? t.bob : t.alice;
      const table = invitation ? 'invitations' : grant ? 'fabric_grants' : 'connections';
      const version = invitation ? null : (await t.db.prepare(`SELECT version FROM ${table} WHERE id = ?`).bind(id).first()).version;
      const key = 'takeover-' + action;
      const route = db => invitation ? routedInvitation(t, actor, name, id, key, db) : routed(t, name, id, { expectedVersion: version }, key, db);
      const a = holdEffect(t.db), b = holdEffect(t.db); c.after(a.release); c.after(b.release);
      const original = route(a.db); await a.ready;
      await t.db.prepare("UPDATE idempotency_records SET created_at = '2000-01-01' WHERE idem_key = ?").bind(key).run();
      const takeover = route(b.db); await b.ready;
      a.release(); const applied = await original; assert.equal(applied.status, 200);
      if (action === 'pause') await core.revokeGrant(t.db, t.alice, id, { expectedVersion: version + 1 });
      if (action === 'suspend') await core.disconnectConnection(t.db, t.bob, id, { expectedVersion: version + 1 });
      const saved = await t.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
      b.release(); const recovered = await takeover;
      assert.equal(recovered.status, 200); assert.deepEqual(recovered.body, applied.body);
      const ledger = await t.db.prepare('SELECT response_code,response_body FROM idempotency_records WHERE idem_key = ?').bind(key).first();
      assert.equal(ledger.response_code, 200); assert.deepEqual(JSON.parse(ledger.response_body), applied.body);
      assert.deepEqual(await t.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first(), saved);
      assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_restriction_receipts WHERE target_id = ? AND action = ?')
        .bind(id, `fabric.${invitation ? 'invitation' : grant ? 'grant' : 'connection'}.${name}`).first()).n, 1);
    });
  }
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

  for (const action of ['decline', 'revoke']) {
    test(`${engine}: invitation ${action} recovers an interrupted audit`, async c => {
      const t = await revisionFixture(real); c.after(t.close);
      const inv = await pending(t);
      const actor = action === 'decline' ? t.bob : t.alice, fn = core[`${action}Invitation`];
      const event = `fabric.invitation.${action}`, op = { key: 'invitation-' + action, path: `/v1/fabric/invitations/${inv.id}/${action}` };
      await t.db.prepare(`CREATE TRIGGER invitation_audit_fault BEFORE INSERT ON audit WHEN NEW.action = '${event}' BEGIN SELECT RAISE(ABORT,'synthetic invitation audit fault'); END`).run();
      await assert.rejects(fn(t.db, actor, inv.id, op));
      await t.db.prepare('DROP TRIGGER invitation_audit_fault').run();
      const retry = await fn(t.db, actor, inv.id, op);
      assert.equal(retry.status, 200);
      assert.equal((await t.db.prepare('SELECT count(*) n FROM audit WHERE action = ? AND target = ?').bind(event, inv.id).first()).n, 1);
    });

    test(`${engine}: HTTP invitation ${action} retains exact outcome through lost responses at retention ceiling`, async c => {
      const t = await revisionFixture(real); c.after(t.close);
      const inv = await pending(t), actor = action === 'decline' ? t.bob : t.alice, mcp = action === 'revoke';
      await t.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
        INSERT INTO fabric_operation_admissions(owner_id,actor_kind,idem_key,method,path,request_hash,admitted_at)
        SELECT ?,'key','seed-'||x,'POST','/seed','h','2026-01-01' FROM n`).bind(MAX_RETAINED_FABRIC_OPERATIONS, actor.user.id).run();
      const key = 'invitation-lost-' + action;
      const lost = faultOnce(t.db, /INSERT INTO fabric_restriction_receipts/, 'after', true);
      assert.equal((await routedInvitation(t, actor, action, inv.id, key, lost, mcp)).status, 500);
      const finalizationLost = faultOnce(t.db, /UPDATE idempotency_records SET status = \?, response_code/, 'before');
      assert.equal((await routedInvitation(t, actor, action, inv.id, key, finalizationLost, mcp)).status, 500);
      await t.db.prepare("UPDATE idempotency_records SET created_at = '2000-01-01' WHERE idem_key = ? AND status = 'processing'").bind(key).run();
      const expected = { id: inv.id, state: action === 'decline' ? 'declined' : 'revoked' };
      for (let i = 0; i < 3; i++) {
        const r = await routedInvitation(t, actor, action, inv.id, key, t.db, mcp);
        assert.equal(r.status, 200);
        assert.deepEqual(mcp ? r.body.result : { id: r.body.id, state: r.body.state }, expected);
      }
      assert.equal((await routedInvitation(t, actor, action, inv.id, key, t.db, mcp, { changed: true })).status, 409);
      assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_restriction_receipts WHERE target_id = ?').bind(inv.id).first()).n, 1);
      assert.equal((await t.db.prepare('SELECT count(*) n FROM audit WHERE action = ? AND target = ?').bind('fabric.invitation.' + action, inv.id).first()).n, 1);
      assert.equal((await t.db.prepare('SELECT count(*) n FROM write_budget WHERE user_id = ?').bind(actor.user.id).first()).n, 0);
    });

    test(`${engine}: invitation ${action} checks side ownership and actor liveness before mutation`, async c => {
      const t = await revisionFixture(real); c.after(t.close);
      const inv = await pending(t), actor = action === 'decline' ? t.bob : t.alice, foreign = action === 'decline' ? t.alice : t.bob;
      const fn = core[`${action}Invitation`], op = { key: 'invitation-closure', path: '/' + action };
      await assert.rejects(fn(t.db, foreign, inv.id, op), e => e.status === 403 || e.status === 404);
      const db = faultOnce(t.db, /INSERT INTO fabric_restriction_receipts/, 'before', true, async () => {
        await t.db.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').bind(actor.user.id).run();
      });
      await assert.rejects(fn(db, actor, inv.id, op), { code: 'AUTH_REQUIRED' });
      assert.equal((await t.db.prepare('SELECT state FROM invitations WHERE id = ?').bind(inv.id).first()).state, 'issued');
      assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_restriction_receipts').first()).n, 0);
    });
  }
}

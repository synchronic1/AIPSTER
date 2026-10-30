import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revisionFixture, faultOnce } from './revision-fixtures.mjs';
import * as core from '../src/fabric/store.mjs';
import { handleFabric } from '../src/fabric/router.mjs';
import { budgetWindow } from '../src/lib/quotas.js';
import { MAX_RETAINED_FABRIC_OPERATIONS } from '../src/fabric/admission.mjs';
import { digestJson } from '../src/fabric/canonical.mjs';

async function fixture(c, real) {
  c.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const t = await revisionFixture(real); c.after(t.close);
  assert.equal((await core.pauseGrant(t.db, t.alice, t.grant, { expectedVersion: 1 })).status, 200);
  const approval = (await core.requestApproval(t.db, t.alice, { action: 'grant.resume', targetId: t.grant })).body;
  assert.equal((await core.decideApproval(t.db, t.alice, approval.id, { decision: 'approve' })).status, 200);
  const input = { expectedVersion: 2, approvalId: approval.id }, op = { key: 'original-resume', path: `/v1/fabric/grants/${t.grant}/resume` };
  const state = async () => ({
    grant: await t.db.prepare('SELECT * FROM fabric_grants WHERE id=?').bind(t.grant).first(),
    approval: await t.db.prepare('SELECT * FROM approvals WHERE id=?').bind(approval.id).first(),
    generation: (await t.db.prepare('SELECT grant_gen FROM connections WHERE id=?').bind(t.conn).first()).grant_gen,
    receipts: (await t.db.prepare("SELECT * FROM fabric_restriction_receipts WHERE action='fabric.grant.resume'").all()).results,
    audits: (await t.db.prepare("SELECT * FROM audit WHERE action='fabric.grant.resume'").all()).results,
    history: (await t.db.prepare('SELECT * FROM fabric_grant_revisions').all()).results,
  });
  return { ...t, input, op, state, resume: (db = t.db) => core.resumeGrant(db, t.alice, t.grant, input, op) };
}

async function route(t, { db = t.db, mcp = false, input = t.input, key = t.op.key, action = 'resume', path = t.op.path, actor = t.alice } = {}) {
  const url = new URL(mcp ? '/v1/fabric/mcp' : path, 'https://synthetic.invalid');
  const body = mcp ? { tool: `fabric.${action}_grant`, params: { id: t.grant, ...input }, idempotencyKey: key } : input;
  const request = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  const response = await handleFabric({ db, actor, url, request, env: { FEDERATION_ENABLED: '1' },
    json: (status, data) => Response.json(data, { status }),
    needAuthz: () => null, needSession: () => null, needCsrf: () => null, needNotDemo: () => null });
  return { status: response.status, body: await response.json() };
}

function closeAfterGate(t, field) {
  let fired = false;
  const wrap = (raw, sql) => ({ raw, bind: (...args) => wrap(raw.bind(...args), sql),
    all: (...args) => raw.all(...args), run: (...args) => raw.run(...args),
    async first(...args) {
      if (!fired && /SELECT attempt FROM idempotency_records/.test(sql)) {
        fired = true;
        await t.db.prepare(`UPDATE "user" SET ${field}=1 WHERE id=?`).bind(t.alice.user.id).run();
      }
      return raw.first(...args);
    }
  });
  return { fired: () => fired, db: { prepare: sql => wrap(t.db.prepare(sql), sql),
    batch: stmts => t.db.batch(stmts.map(s => s.raw || s)), exec: sql => t.db.exec(sql) } };
}

function holdEffect(db) {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  return { ready, release, db: faultOnce(db, /UPDATE fabric_grants SET status/, 'before', true, async () => { entered(); await gate; }) };
}

for (const real of [false, true]) {
  const engine = real ? 'local D1' : 'sqlite';
  for (const later of ['pause', 'revoke']) test(`${engine}: unknown resume batch response survives later ${later} as an immutable outcome`, async c => {
    const t = await fixture(c, real);
    let lost = false;
    const unknown = { prepare: sql => t.db.prepare(sql), async batch(stmts) {
      await t.db.batch(stmts); lost = true; throw new Error('synthetic lost resume batch response');
    } };
    assert.deepEqual(await t.resume(unknown), { status: 200, body: { id: t.grant, status: 'enforced' } });
    assert.equal(lost, true, 'the batch response was actually lost and recovered from its receipt');
    const applied = await t.state(); assert.equal(applied.grant.status, 'enforced'); assert.equal(applied.grant.version, 3);
    assert.equal(applied.receipts.length, 1); assert.equal(applied.audits.length, 1);
    assert.equal(applied.approval.consumed_by_op, applied.receipts[0].operation_id);
    assert.equal(applied.approval.consumed_action, 'grant.resume'); assert.equal(applied.approval.consumed_target, t.grant);
    assert.equal(applied.receipts[0].request_hash, await digestJson(t.input));
    assert.equal((await core[`${later}Grant`](t.db, t.alice, t.grant, { expectedVersion: 3 })).status, 200);
    const narrowed = await t.state();
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await t.resume(), { status: 200, body: { id: t.grant, status: 'enforced' } });
      assert.deepEqual(await t.state(), narrowed);
    }
    await assert.rejects(core.resumeGrant(t.db, t.alice, t.grant, { ...t.input, approvalId: 'changed' }, t.op), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(core.resumeGrant(t.db, t.alice, t.grant, { ...t.input, expectedVersion: 4 }, { ...t.op, key: 'fresh-resume' }), { code: later === 'revoke' ? 'BAD_STATE' : 'NOT_APPROVED' });
    assert.deepEqual(await t.state(), narrowed);
    assert.equal(applied.receipts[0].applied_at, applied.audits[0].at);
    assert.deepEqual(JSON.parse(applied.receipts[0].response_body), { id: t.grant, status: 'enforced' });
  });

  for (const boundary of ['approval', 'effect', 'receipt', 'audit']) test(`${engine}: resume ${boundary} SQL failure rolls approval and every effect back`, async c => {
    const t = await fixture(c, real), before = await t.state();
    const clause = boundary === 'approval' ? 'BEFORE UPDATE OF consumed_at ON approvals'
      : boundary === 'effect' ? 'BEFORE UPDATE ON fabric_grants'
      : boundary === 'receipt' ? 'BEFORE INSERT ON fabric_restriction_receipts'
      : "BEFORE INSERT ON audit WHEN NEW.action='fabric.grant.resume'";
    await t.db.prepare(`CREATE TRIGGER resume_fault ${clause} BEGIN SELECT RAISE(ABORT,'synthetic resume SQL failure'); END`).run();
    await assert.rejects(t.resume()); assert.deepEqual(await t.state(), before);
    await t.db.prepare('DROP TRIGGER resume_fault').run();
    assert.equal((await t.resume()).status, 200);
    const after = await t.state(); assert.equal(after.grant.version, 3); assert.equal(after.generation, before.generation + 1);
    assert.equal(after.receipts.length, 1); assert.equal(after.audits.length, 1);
  });

  test(`${engine}: resume receipt access requires a live exporting human and exact operation`, async c => {
    const t = await fixture(c, real); assert.equal((await t.resume()).status, 200);
    const before = await t.state();
    await assert.rejects(core.resumeGrant(t.db, t.bob, t.grant, t.input, t.op), { code: 'FORBIDDEN' });
    await assert.rejects(core.resumeGrant(t.db, { ...t.alice, kind: 'key' }, t.grant, t.input, t.op), { code: 'HUMAN_REQUIRED' });
    await assert.rejects(core.resumeGrant(t.db, t.alice, t.grant, t.input, { ...t.op, key: 'other' }), { code: 'VERSION_MISMATCH' });
    for (const [field, code] of [['disabled', 'AUTH_REQUIRED'], ['demo', 'DEMO_RESTRICTED']]) {
      await t.db.prepare(`UPDATE "user" SET ${field}=1 WHERE id=?`).bind(t.alice.user.id).run();
      await assert.rejects(t.resume(), { code });
      await t.db.prepare(`UPDATE "user" SET ${field}=0 WHERE id=?`).bind(t.alice.user.id).run();
    }
    assert.deepEqual(await t.state(), before);
  });

  test(`${engine}: owner closure at resume batch boundary leaves consent unspent`, async c => {
    const t = await fixture(c, real), before = await t.state();
    const db = faultOnce(t.db, /UPDATE fabric_grants SET status/, 'before', true, async () => {
      await t.db.prepare('UPDATE "user" SET disabled=1 WHERE id=?').bind(t.alice.user.id).run();
    });
    await assert.rejects(t.resume(db), { code: 'AUTH_REQUIRED' }); assert.deepEqual(await t.state(), before);
  });

  test(`${engine}: resume takeover re-reads its receipt after original completion and revoke`, async c => {
    const t = await fixture(c, real), a = holdEffect(t.db), b = holdEffect(t.db); c.after(a.release); c.after(b.release);
    const original = route(t, { db: a.db }); await a.ready;
    await t.db.prepare("UPDATE idempotency_records SET created_at='2000-01-01' WHERE idem_key=?").bind(t.op.key).run();
    const takeover = route(t, { db: b.db }); await b.ready;
    a.release(); assert.equal((await original).status, 200);
    assert.equal((await core.revokeGrant(t.db, t.alice, t.grant, { expectedVersion: 3 })).status, 200);
    const revoked = await t.state(); b.release(); assert.equal((await takeover).status, 200);
    assert.deepEqual(await t.state(), revoked);
    const ledger = await t.db.prepare('SELECT response_code,response_body FROM idempotency_records WHERE idem_key=?').bind(t.op.key).first();
    assert.equal(ledger.response_code, 200); assert.deepEqual(JSON.parse(ledger.response_body), { id: t.grant, status: 'enforced' });
  });

  for (const mcp of [false, true]) test(`${engine}: ${mcp ? 'MCP' : 'REST'} resume completion loss recovers after revoke at budget and retention exhaustion`, async c => {
    const t = await fixture(c, real);
    const lost = faultOnce(t.db, /UPDATE idempotency_records SET status = \?, response_code/, 'before');
    assert.equal((await route(t, { db: lost, mcp })).status, 500);
    assert.equal((await core.revokeGrant(t.db, t.alice, t.grant, { expectedVersion: 3 })).status, 200);
    await t.db.prepare('UPDATE write_budget SET count=120 WHERE user_id=? AND window=?').bind(t.alice.user.id, budgetWindow()).run();
    await t.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
      INSERT INTO fabric_operation_admissions(owner_id,actor_kind,idem_key,method,path,request_hash,admitted_at)
      SELECT ?,'key','seed-'||x,'POST','/seed','hash','2026-01-01' FROM n`)
      .bind(MAX_RETAINED_FABRIC_OPERATIONS - 1, t.alice.user.id).run();
    await t.db.prepare("UPDATE idempotency_records SET created_at='2000-01-01' WHERE idem_key=? AND status='processing'").bind(t.op.key).run();
    const revoked = await t.state();
    for (let i = 0; i < 3; i++) {
      const out = await route(t, { mcp }); assert.equal(out.status, 200);
      assert.deepEqual(mcp ? out.body.result : { id: out.body.id, status: out.body.status }, { id: t.grant, status: 'enforced' });
      assert.deepEqual(await t.state(), revoked);
    }
    assert.equal((await route(t, { mcp, input: { ...t.input, approvalId: 'changed' } })).status, 409);
    const fresh = await route(t, { mcp, key: 'fresh-at-retention' });
    assert.equal(fresh.status, 409); assert.equal(fresh.body.code, 'FABRIC_RETENTION_LIMIT');
    assert.equal((await t.db.prepare('SELECT count FROM write_budget WHERE user_id=? AND window=?').bind(t.alice.user.id, budgetWindow()).first()).count, 120);
    const rows = (await t.db.prepare('SELECT restriction FROM fabric_operation_admissions WHERE owner_id=? AND idem_key=?').bind(t.alice.user.id, t.op.key).all()).results;
    assert.deepEqual(rows.map(r => ({ ...r })), [{ restriction: null }], 'resume is a charged expansion, not a restrictive exemption');
    assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_operation_admissions WHERE owner_id=?').bind(t.alice.user.id).first()).n, MAX_RETAINED_FABRIC_OPERATIONS);
  });

  for (const mcp of [false, true]) test(`${engine}: ${mcp ? 'MCP' : 'REST'} temporary owner closure cannot terminalize an applied resume`, async c => {
    const t = await fixture(c, real);
    assert.equal((await route(t, { mcp, db: faultOnce(t.db, /UPDATE idempotency_records SET status = \?, response_code/, 'before') })).status, 500);
    await t.db.prepare("UPDATE idempotency_records SET created_at='2000-01-01' WHERE idem_key=?").bind(t.op.key).run();
    await core.revokeGrant(t.db, t.alice, t.grant, { expectedVersion: 3 }); const before = await t.state();
    const gatedBefore = await t.db.prepare('SELECT * FROM idempotency_records WHERE idem_key=?').bind(t.op.key).first();
    for (const [field, status] of [['disabled', 401], ['demo', 403]]) {
      await t.db.prepare(`UPDATE "user" SET ${field}=1 WHERE id=?`).bind(t.alice.user.id).run();
      const denied = await route(t, { mcp }); assert.equal(denied.status, status); assert.equal(denied.body.id, undefined); assert.equal(denied.body.result, undefined);
      assert.deepEqual(await t.db.prepare('SELECT * FROM idempotency_records WHERE idem_key=?').bind(t.op.key).first(), gatedBefore);
      await t.db.prepare(`UPDATE "user" SET ${field}=0 WHERE id=?`).bind(t.alice.user.id).run();
    }
    assert.equal((await route(t, { mcp })).status, 200); assert.deepEqual(await t.state(), before);
    for (const [field, status] of [['disabled', 401], ['demo', 403]]) {
      await t.db.prepare(`UPDATE "user" SET ${field}=1 WHERE id=?`).bind(t.alice.user.id).run();
      assert.equal((await route(t, { mcp })).status, status, 'completed outcomes also require current DB authority');
      await t.db.prepare(`UPDATE "user" SET ${field}=0 WHERE id=?`).bind(t.alice.user.id).run();
    }
    assert.equal((await t.db.prepare('SELECT response_code FROM idempotency_records WHERE idem_key=?').bind(t.op.key).first()).response_code, 200);
  });

  for (const mcp of [false, true]) for (const [field, deniedStatus] of [['disabled', 401], ['demo', 403]]) {
    test(`${engine}: ${mcp ? 'MCP' : 'REST'} ${field} after gate denies caller but preserves the applied receipt outcome`, async c => {
      const t = await fixture(c, real);
      assert.equal((await route(t, { mcp, db: faultOnce(t.db, /UPDATE idempotency_records SET status = \?, response_code/, 'before') })).status, 500);
      await t.db.prepare("UPDATE idempotency_records SET created_at='2000-01-01' WHERE idem_key=?").bind(t.op.key).run();
      await core.revokeGrant(t.db, t.alice, t.grant, { expectedVersion: 3 }); const before = await t.state();
      const closure = closeAfterGate(t, field), denied = await route(t, { mcp, db: closure.db });
      assert.equal(closure.fired(), true); assert.equal(denied.status, deniedStatus);
      assert.equal(denied.body.id, undefined); assert.equal(denied.body.result, undefined);
      const saved = await t.db.prepare('SELECT status,response_code,response_body FROM idempotency_records WHERE idem_key=?').bind(t.op.key).first();
      assert.equal(saved.status, 'completed'); assert.equal(saved.response_code, 200);
      assert.deepEqual(JSON.parse(saved.response_body), { id: t.grant, status: 'enforced' });
      assert.equal((await route(t, { mcp })).status, deniedStatus, 'do not expose cached success while the actor remains closed');
      await t.db.prepare(`UPDATE "user" SET ${field}=0 WHERE id=?`).bind(t.alice.user.id).run();
      assert.equal((await route(t, { mcp })).status, 200); assert.deepEqual(await t.state(), before);
    });
  }

  for (const action of ['revise', 'commit']) test(`${engine}: temporary auth denial preserves ${action} forensic completion for an authorized retry`, async c => {
    c.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const t = await revisionFixture(real); c.after(t.close);
    const input = action === 'revise' ? t.input : await t.approval(90), path = action === 'revise' ? t.op.path : '/v1/fabric/grants', key = 'forensic-auth-retry';
    const pattern = action === 'revise' ? /INSERT OR IGNORE INTO fabric_grant_revisions/ : /INSERT OR IGNORE INTO audit/;
    assert.equal((await route(t, { action, input, path, key, db: faultOnce(t.db, pattern, 'before') })).status, 500);
    const id = action === 'revise' ? t.grant : (await t.db.prepare('SELECT id FROM fabric_grants WHERE approval_id=?').bind(input.approvalId).first()).id;
    const before = await t.db.prepare('SELECT * FROM fabric_grants WHERE id=?').bind(id).first();
    const closure = closeAfterGate(t, 'disabled');
    const denied = await route(t, { action, input, path, key, db: closure.db }); assert.equal(closure.fired(), true); assert.equal(denied.status, 401);
    const pending = await t.db.prepare('SELECT status,response_code FROM idempotency_records WHERE idem_key=?').bind(key).first();
    assert.equal(pending.status, 'uncertain'); assert.equal(pending.response_code, null, 'do not cache200 before forensic completion');
    assert.equal((await t.db.prepare('SELECT count(*) n FROM audit WHERE action=? AND target=?').bind(`fabric.grant.${action}`, id).first()).n, 0);
    await t.db.prepare('UPDATE "user" SET disabled=0 WHERE id=?').bind(t.alice.user.id).run();
    const completed = await route(t, { action, input, path, key }); assert.equal(completed.status, 200);
    assert.equal((await t.db.prepare('SELECT count(*) n FROM audit WHERE action=? AND target=?').bind(`fabric.grant.${action}`, id).first()).n, 1);
    if (action === 'revise') assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_grant_revisions WHERE grant_id=?').bind(id).first()).n, 1);
    assert.deepEqual(await t.db.prepare('SELECT * FROM fabric_grants WHERE id=?').bind(id).first(), before);
  });

  for (const [field, deniedStatus] of [['disabled', 401], ['demo', 403]]) {
    test(`${engine}: takeover ${field} denial stays reconcilable until an older resume effect is known`, async c => {
      const t = await fixture(c, real), a = holdEffect(t.db); c.after(a.release);
      const original = route(t, { db: a.db }); await a.ready;
      await t.db.prepare("UPDATE idempotency_records SET created_at='2000-01-01' WHERE idem_key=?").bind(t.op.key).run();
      const b = closeAfterGate(t, field), denied = await route(t, { db: b.db });
      assert.equal(b.fired(), true); assert.equal(denied.status, deniedStatus); assert.equal(denied.body.id, undefined);
      const pending = await t.db.prepare('SELECT status,response_code FROM idempotency_records WHERE idem_key=?').bind(t.op.key).first();
      assert.equal(pending.status, 'uncertain'); assert.equal(pending.response_code, null);
      assert.equal((await t.state()).receipts.length, 0, 'the original batch has not applied yet');
      await t.db.prepare(`UPDATE "user" SET ${field}=0 WHERE id=?`).bind(t.alice.user.id).run();
      a.release(); assert.equal((await original).status, 200);
      await core.revokeGrant(t.db, t.alice, t.grant, { expectedVersion: 3 }); const revoked = await t.state();
      const retry = await route(t); assert.equal(retry.status, 200);
      assert.equal((await t.db.prepare('SELECT response_code FROM idempotency_records WHERE idem_key=?').bind(t.op.key).first()).response_code, 200);
      assert.deepEqual(await t.state(), revoked);
    });
  }

  test(`${engine}: ordinary foreign-owner authorization failures remain terminal and charge once`, async c => {
    const t = await fixture(c, real), before = await t.state();
    const denied = await route(t, { actor: t.bob }); assert.equal(denied.status, 403); assert.equal(denied.body.code, 'FORBIDDEN');
    const read = () => t.db.prepare('SELECT * FROM idempotency_records WHERE idem_key=? AND actor=?').bind(t.op.key, `session:${t.bob.user.id}`).first();
    const saved = await read(); assert.equal(saved.status, 'completed'); assert.equal(saved.response_code, 403);
    assert.equal((await route(t, { actor: t.bob })).status, 403); assert.deepEqual(await read(), saved);
    assert.equal((await t.db.prepare('SELECT count FROM write_budget WHERE user_id=? AND window=?').bind(t.bob.user.id, budgetWindow()).first()).count, 1);
    assert.deepEqual(await t.state(), before);
  });
}

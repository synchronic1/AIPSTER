// Delayed resume/revision claims serialize against terminal 410 ledger failures;
// synthetic users only. Mirrors the commit fence ordering proof in
// connection-commit-recovery.test.mjs for grant.revise and grant.resume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revisionFixture, faultOnce } from './revision-fixtures.mjs';
import * as core from '../src/fabric/store.mjs';
import { handleFabric } from '../src/fabric/router.mjs';

async function fixture(c, real, action) {
  c.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const t = await revisionFixture(real); c.after(t.close);
  if (action === 'resume') {
    assert.equal((await core.pauseGrant(t.db, t.alice, t.grant, { expectedVersion: 1 })).status, 200);
    const approval = (await core.requestApproval(t.db, t.alice, { action: 'grant.resume', targetId: t.grant })).body;
    assert.equal((await core.decideApproval(t.db, t.alice, approval.id, { decision: 'approve' })).status, 200);
    const input = { expectedVersion: 2, approvalId: approval.id };
    return { ...t, input, action, key: 'resume-claim-fence', path: `/v1/fabric/grants/${t.grant}/resume` };
  }
  return { ...t, action, key: 'revise-claim-fence', path: `/v1/fabric/grants/${t.grant}/revise` };
}

async function route(t, { db = t.db, input = t.input, key = t.key, actor = t.alice, mcp = false } = {}) {
  const url = new URL(mcp ? '/v1/fabric/mcp' : t.path, 'https://synthetic.invalid');
  const body = mcp ? { tool: `fabric.${t.action}_grant`, params: { id: t.grant, ...input }, idempotencyKey: key } : input;
  const request = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  const r = await handleFabric({ db, actor, url, request, env: { FEDERATION_ENABLED: '1' },
    json: (status, data) => Response.json(data, { status }),
    needSession: () => null, needCsrf: () => null, needAuthz: () => null, needNotDemo: () => null });
  return { status: r.status, body: await r.json() };
}

async function snapshot(t) {
  const s = {};
  for (const table of ['fabric_grants', 'approvals', 'fabric_revision_receipts', 'fabric_revision_failures',
    'fabric_restriction_receipts', 'fabric_grant_revisions', 'audit']) {
    s[table] = (await t.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
  }
  return s;
}

async function ledger(t) {
  return t.db.prepare('SELECT * FROM idempotency_records WHERE idem_key = ? AND actor = ?')
    .bind(t.key, `session:${t.alice.user.id}`).first();
}

async function expire(t) {
  await t.db.prepare("UPDATE idempotency_records SET created_at = '2000-01-01' WHERE idem_key = ?").bind(t.key).run();
}

function hold(db, pattern) {
  let entered, release;
  const ready = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  return { ready, release, db: faultOnce(db, pattern, 'before', true, async () => { entered(); await gate; }) };
}

const PENDING = { revise: 'REVISION_UNCERTAIN', resume: 'RESUME_UNCERTAIN' };

for (const real of [false, true]) {
  const engine = real ? 'local D1' : 'sqlite';
  for (const action of ['revise', 'resume']) for (const mcp of [false, true]) {
    const via = `${engine}: ${mcp ? 'MCP' : 'REST'} ${action}`;
    const claimPattern = /UPDATE approvals SET consumed_at/;
    const effectPattern = action === 'revise' ? /UPDATE fabric_grants SET consumers/ : /UPDATE approvals SET consumed_at/;

    test(`${via} terminal failure first fences a delayed claim using its old timestamp`, async c => {
      const t = await fixture(c, real, action);
      // Resume claims atomically inside its effect batch; revise holds the
      // standalone claim statement, then its effect batch below.
      const batchHold = action === 'resume' ? hold(t.db, claimPattern) : null;
      if (batchHold) c.after(batchHold.release);
      let entered, releaseClaim;
      const claimReady = new Promise(r => { entered = r; }), claimGate = new Promise(r => { releaseClaim = r; });
      c.after(releaseClaim);
      const held = action === 'resume' ? batchHold.db
        : faultOnce(t.db, claimPattern, 'before', false, async () => { entered(); await claimGate; });
      const original = route(t, { db: held, mcp });
      if (action === 'resume') await batchHold.ready; else await claimReady;
      const before = await snapshot(t);
      await expire(t); c.mock.timers.tick(61 * 60e3);
      const takeover = await route(t, { mcp });
      assert.equal(takeover.status, 410); assert.equal(takeover.body.code, 'APPROVAL_EXPIRED');
      assert.equal((await ledger(t)).response_code, 410);
      // Even a much later delayed claim using its old timestamp must stay fenced.
      c.mock.timers.tick(24 * 60 * 60e3);
      if (action === 'resume') batchHold.release(); else releaseClaim();
      const old = await original;
      assert.equal(old.status, 503); assert.equal(old.body.code, PENDING[action]);
      assert.equal((await t.db.prepare('SELECT consumed_at FROM approvals WHERE id = ?').bind(t.input.approvalId).first()).consumed_at, null);
      assert.deepEqual(await snapshot(t), before);
      for (let i = 0; i < 3; i++) {
        const replay = await route(t, { mcp });
        assert.equal(replay.status, 410); assert.equal(replay.body.id, undefined);
      }
    });

    test(`${via} winning claim first fences a stale terminal failure`, async c => {
      const t = await fixture(c, real, action);
      const effect = action === 'revise' ? hold(t.db, effectPattern) : null;
      if (effect) c.after(effect.release);
      let entered, releaseClaim;
      const claimReady = new Promise(r => { entered = r; }), claimGate = new Promise(r => { releaseClaim = r; });
      c.after(releaseClaim);
      const held = action === 'resume'
        ? faultOnce(t.db, effectPattern, 'before', true, async () => { entered(); await claimGate; })
        : faultOnce(effect.db, claimPattern, 'before', false, async () => { entered(); await claimGate; });
      const original = route(t, { db: held, mcp });
      await claimReady;
      const before = await snapshot(t);
      await expire(t); c.mock.timers.tick(61 * 60e3);
      // The store already read "no claim" in its precheck; the SQL finalizer
      // must itself observe this now-winning claim.
      const db = faultOnce(t.db, /UPDATE idempotency_records SET status = \?, response_code/, 'before', false, async () => {
        releaseClaim();
        if (action === 'revise') await effect.ready; else await original.catch(() => {});
      });
      const takeover = await route(t, { db, mcp });
      assert.equal(takeover.status, 503); assert.equal(takeover.body.code, PENDING[action]);
      if (action === 'revise') effect.release();
      const winner = await original;
      assert.equal(winner.status, 200);
      const grant = await t.db.prepare('SELECT * FROM fabric_grants WHERE id = ?').bind(t.grant).first();
      if (action === 'resume') {
        assert.equal(grant.status, 'enforced');
        assert.equal((await t.db.prepare("SELECT count(*) n FROM fabric_restriction_receipts WHERE action = 'fabric.grant.resume'").first()).n, 1);
      } else {
        assert.equal(grant.version, 2);
        assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_revision_receipts').first()).n, 1);
        assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_grant_revisions').first()).n, 1);
      }
      const applied = await snapshot(t);
      for (let i = 0; i < 3; i++) {
        const replay = await route(t, { mcp });
        assert.equal(replay.status, 200);
      }
      assert.equal((await ledger(t)).response_code, 200);
      assert.deepEqual(await snapshot(t), applied);
    });
  }
}

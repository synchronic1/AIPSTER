/* Regression tests for the PR #6 Codex review findings on F1R3
 * (reviewed commit 2ceafd2). Each test reproduces the reported
 * interleaving deterministically against the real store code: a
 * wrapped D1 binding runs the competing operation (or injects the
 * failure) at the exact batch boundary the finding describes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fabricEnv, connectPair, commitFlow, S, freshKey, readJson } from './qa-helpers.mjs';
import * as core from '../src/fabric/store.mjs';

const post = (t, u, p, b = {}, key = freshKey()) => t.call('/v1/fabric/' + p, { method: 'POST', headers: S(t, u, { 'Idempotency-Key': key }), body: b }).then(readJson);
const actorOf = (u) => ({ kind: 'session', user: { id: u.id } });

// A D1 binding whose next batch matching `match` first runs `hook`
// (with the raw binding), then either proceeds or applies `after`.
function hookedDb(db, match, hook, after = (run) => run()) {
  let fired = false;
  return {
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    async batch(stmts) {
      if (!fired && stmts.some((s) => match.test(s.sql || ''))) {
        fired = true;
        await hook(db);
        return after(() => db.batch(stmts));
      }
      return db.batch(stmts);
    }
  };
}

const vetoes = (t, conn) => t.sqlite.prepare('SELECT side_node s FROM connection_vetoes WHERE connection_id = ? ORDER BY s').all(conn).map((r) => r.s);
const connRow = (t, conn) => t.sqlite.prepare('SELECT state, version, suspended_by FROM connections WHERE id = ?').get(conn);

test('review P1: concurrent veto withdrawals cannot delete a veto whose version-pinned update lost', async () => {
  const t = await fabricEnv();
  const { conn, nodeA, nodeB } = await connectPair(t);
  assert.equal((await post(t, t.alice, `connections/${conn.id}/suspend`, { expectedVersion: 1 })).status, 200);
  assert.equal((await post(t, t.bob, `connections/${conn.id}/disconnect`, { expectedVersion: 2 })).status, 200);
  assert.deepEqual(vetoes(t, conn.id), [nodeA.id, nodeB.id].sort());
  // Both peers pre-read version 3. Alice's withdrawal commits between
  // Bob's pre-read and Bob's batch.
  let aliceOut;
  const racing = hookedDb(t.DB, /DELETE FROM connection_vetoes/, async (db) => {
    aliceOut = await core.resumeConnection(db, actorOf(t.alice), conn.id, { expectedVersion: 3, nodeKey: nodeA.nodeSecret });
  });
  const bobOut = await core.resumeConnection(racing, actorOf(t.bob), conn.id, { expectedVersion: 3, nodeKey: nodeB.nodeSecret });
  assert.equal(aliceOut.status, 200);
  assert.deepEqual(aliceOut.body.remainingVetoes, [nodeB.id]);
  // Bob lost the version race: nothing he submitted may have landed.
  assert.equal(bobOut.status, 412);
  assert.equal(bobOut.body.code, 'VERSION_MISMATCH');
  assert.deepEqual(vetoes(t, conn.id), [nodeB.id]);
  assert.equal(connRow(t, conn.id).version, 4);
  assert.notEqual(connRow(t, conn.id).state, 'active');
  // The relationship is not stranded: Bob refreshes and withdraws.
  const retry = await core.resumeConnection(t.DB, actorOf(t.bob), conn.id, { expectedVersion: 4, nodeKey: nodeB.nodeSecret });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.state, 'active');
  assert.deepEqual(vetoes(t, conn.id), []);
});

test('review P1: a lost withdrawal by a disabled actor deletes no veto', async () => {
  const t = await fabricEnv();
  const { conn, nodeA } = await connectPair(t);
  assert.equal((await post(t, t.alice, `connections/${conn.id}/suspend`, { expectedVersion: 1 })).status, 200);
  const racing = hookedDb(t.DB, /DELETE FROM connection_vetoes/, async () => {
    t.sqlite.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').run(t.alice.id);
  });
  await assert.rejects(core.resumeConnection(racing, actorOf(t.alice), conn.id, { expectedVersion: 2, nodeKey: nodeA.nodeSecret }), { code: 'AUTH_REQUIRED' });
  assert.deepEqual(vetoes(t, conn.id), [nodeA.id]);
  assert.equal(connRow(t, conn.id).state, 'suspended');
});

async function pendingInvitation(t) {
  const nA = await post(t, t.alice, 'nodes', { label: 'issuer' });
  const nB = await post(t, t.bob, 'nodes', { label: 'acceptor' });
  const inv = await post(t, t.alice, 'invitations', { issuerNode: nA.json.id, recipientNode: nB.json.id, recipientWorkspace: 'default' });
  assert.equal(inv.status, 201);
  return { inv: inv.json, nodeB: nB.json };
}
const connsFor = (t, invId) => t.sqlite.prepare('SELECT id, state FROM connections WHERE created_by_invitation = ?').all(invId);
const acceptBatch = /SET state = 'accepted'/;
const synthetic = () => { throw Object.assign(new Error('synthetic D1 batch failure'), { status: 500 }); };

test('review P1: a failed acceptance batch after a concurrent revoke creates no connection', async () => {
  const t = await fabricEnv();
  const { inv, nodeB } = await pendingInvitation(t);
  const racing = hookedDb(t.DB, acceptBatch, async (db) => {
    assert.equal((await core.revokeInvitation(db, actorOf(t.alice), inv.id)).status, 200);
  }, synthetic);
  await assert.rejects(core.acceptInvitation(racing, actorOf(t.bob), { token: inv.token, nodeId: nodeB.id, nodeKey: nodeB.nodeSecret }), { code: 'INVITATION_USED' });
  assert.deepEqual(connsFor(t, inv.id), []);
  assert.equal(t.sqlite.prepare('SELECT state FROM invitations WHERE id = ?').get(inv.id).state, 'revoked');
});

test('review P1: a failed acceptance batch that never flipped is not treated as a win', async () => {
  const t = await fabricEnv();
  const { inv, nodeB } = await pendingInvitation(t);
  const racing = hookedDb(t.DB, acceptBatch, async () => {}, synthetic);
  // Outcome unknown to the caller: surfaced as a retryable 5xx, with no
  // connection created while the invitation is still merely issued.
  await assert.rejects(core.acceptInvitation(racing, actorOf(t.bob), { token: inv.token, nodeId: nodeB.id, nodeKey: nodeB.nodeSecret }), (e) => e.status === 500);
  assert.deepEqual(connsFor(t, inv.id), []);
  assert.equal(t.sqlite.prepare('SELECT state FROM invitations WHERE id = ?').get(inv.id).state, 'issued');
  const retry = await core.acceptInvitation(t.DB, actorOf(t.bob), { token: inv.token, nodeId: nodeB.id, nodeKey: nodeB.nodeSecret });
  assert.equal(retry.status, 201);
  assert.equal(connsFor(t, inv.id).length, 1);
});

test('review P1: a batch that committed but reported failure converges on its connection', async () => {
  const t = await fabricEnv();
  const { inv, nodeB } = await pendingInvitation(t);
  const racing = hookedDb(t.DB, acceptBatch, async () => {}, async (run) => { await run(); synthetic(); });
  const out = await core.acceptInvitation(racing, actorOf(t.bob), { token: inv.token, nodeId: nodeB.id, nodeKey: nodeB.nodeSecret });
  assert.ok([200, 201].includes(out.status));
  const rows = connsFor(t, inv.id);
  assert.equal(rows.length, 1);
  assert.equal(out.body.id, rows[0].id);
});

test('review P1: recovery of an accepted invitation requires a live acceptor', async () => {
  const t = await fabricEnv();
  const { inv, nodeB } = await pendingInvitation(t);
  // Legacy shape: accepted, connection never created.
  t.sqlite.prepare("UPDATE invitations SET state = 'accepted', use_record = '{}' WHERE id = ?").run(inv.id);
  const racing = hookedDb(t.DB, /./, async () => {});
  const disableFirst = {
    prepare: (sql) => {
      if (/INSERT INTO connections/.test(sql)) t.sqlite.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').run(t.bob.id);
      return racing.prepare(sql);
    },
    exec: racing.exec, batch: racing.batch
  };
  await assert.rejects(core.acceptInvitation(disableFirst, actorOf(t.bob), { token: inv.token, nodeId: nodeB.id, nodeKey: nodeB.nodeSecret }), { code: 'AUTH_REQUIRED' });
  assert.deepEqual(connsFor(t, inv.id), []);
  // Re-enabled, the same proofs complete the legacy acceptance once.
  t.sqlite.prepare('UPDATE "user" SET disabled = 0 WHERE id = ?').run(t.bob.id);
  const ok = await core.acceptInvitation(t.DB, actorOf(t.bob), { token: inv.token, nodeId: nodeB.id, nodeKey: nodeB.nodeSecret });
  assert.equal(ok.status, 201);
  assert.equal(connsFor(t, inv.id).length, 1);
});

test('review P2: a resume whose audit write failed reconciles on same-key retry', async () => {
  const t = await fabricEnv();
  const { conn } = await connectPair(t);
  const { grant } = await commitFlow(t, conn.id);
  assert.equal((await post(t, t.alice, `grants/${grant.id}/pause`, { expectedVersion: 1 })).status, 200);
  const pa = await post(t, t.alice, 'approvals', { action: 'grant.resume', targetId: grant.id });
  assert.equal((await post(t, t.alice, `approvals/${pa.json.id}/decide`, { decision: 'approve' })).status, 200);
  const key = freshKey();
  const body = { expectedVersion: 2, approvalId: pa.json.id };
  const audits = () => t.sqlite.prepare("SELECT count(*) n FROM audit WHERE action = 'fabric.grant.resume' AND target = ?").get(grant.id).n;
  t.sqlite.exec("CREATE TRIGGER review_resume_audit BEFORE INSERT ON audit WHEN NEW.action = 'fabric.grant.resume' BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
  assert.equal((await post(t, t.alice, `grants/${grant.id}/resume`, body, key)).status, 500);
  t.sqlite.exec('DROP TRIGGER review_resume_audit');
  // Audit failure rolls the approval and effect back with its receipt.
  const g = t.sqlite.prepare('SELECT status, version, last_approval_id FROM fabric_grants WHERE id = ?').get(grant.id);
  assert.equal(g.status, 'paused'); assert.equal(g.version, 2);
  assert.notEqual(g.last_approval_id, pa.json.id);
  assert.equal(t.sqlite.prepare('SELECT consumed_at FROM approvals WHERE id=?').get(pa.json.id).consumed_at, null);
  assert.equal(t.sqlite.prepare("SELECT count(*) n FROM fabric_restriction_receipts WHERE action='fabric.grant.resume'").get().n, 0);
  assert.equal(audits(), 0);
  const retry = await post(t, t.alice, `grants/${grant.id}/resume`, body, key);
  assert.equal(retry.status, 200);
  assert.equal(retry.json.status, 'enforced');
  assert.equal(audits(), 1);
  assert.equal(t.sqlite.prepare('SELECT version FROM fabric_grants WHERE id=?').get(grant.id).version, 3);
  assert.equal(t.sqlite.prepare("SELECT count(*) n FROM fabric_restriction_receipts WHERE action='fabric.grant.resume'").get().n, 1);
  // Idempotent thereafter: the completed record replays, no second audit.
  const again = await post(t, t.alice, `grants/${grant.id}/resume`, body, key);
  assert.equal(again.status, 200);
  assert.equal(audits(), 1);
  // A different operation cannot ride the consumed approval past the
  // version check: it still gets the fresh-mutation answer.
  assert.equal((await post(t, t.alice, `grants/${grant.id}/resume`, body)).status, 412);
  assert.equal(audits(), 1);
});

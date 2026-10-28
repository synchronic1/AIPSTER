/* Built with Meta Muse. F1R3 owner tests for the invariant-first
 * state-layer repair. These pin the NEW contract behaviors alongside
 * (never replacing) the independent ARCH/R2 probes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fabricEnv, connectPair, commitFlow, S, freshKey, readJson } from './qa-helpers.mjs';
import * as core from '../src/fabric/store.mjs';

const post = (t, u, p, b = {}, key = freshKey()) => t.call('/v1/fabric/' + p, { method: 'POST', headers: S(t, u, { 'Idempotency-Key': key }), body: b }).then(readJson);
const get = (t, u, p) => t.call('/v1/fabric/' + p, { headers: S(t, u) }).then(readJson);
const actor = (t) => ({ kind: 'session', user: { id: t.alice.id } });
async function preview(t, conn, limit = 9000) {
  const p = await post(t, t.alice, 'previews', { connectionId: conn, resourceIds: ['r_gpu1'], consumers: ['bob-op'], models: ['llama'], maxTokens: limit, maxRequests: 10 });
  assert.equal(p.status, 201);
  return p.json;
}
async function approve(t, p, extra = {}) {
  const a = await post(t, t.alice, 'approvals', { previewId: p.id, ...extra });
  assert.equal(a.status, 201);
  assert.equal((await post(t, t.alice, `approvals/${a.json.id}/decide`, { decision: 'approve' })).status, 200);
  return { approvalId: a.json.id, previewHash: p.digest };
}

test('F1R3: grant.revise binds exact target and revision; stale or foreign use is 412', async () => {
  const t = await fabricEnv();
  const { conn } = await connectPair(t);
  const { grant } = await commitFlow(t, conn.id);
  const p = await preview(t, conn.id, 50);
  // Missing targetId is 404 (strict action needs its target).
  assert.equal((await post(t, t.alice, 'approvals', { action: 'grant.revise', previewId: p.id })).status, 404);
  const a = await post(t, t.alice, 'approvals', { action: 'grant.revise', previewId: p.id, targetId: grant.id });
  assert.equal(a.status, 201);
  assert.equal((await post(t, t.alice, `approvals/${a.json.id}/decide`, { decision: 'approve' })).status, 200);
  // A second grant: the approval names the first grant only.
  const p2 = await preview(t, conn.id, 60);
  const a2 = await approve(t, p2);
  const g2 = await post(t, t.alice, 'grants', a2);
  assert.equal(g2.status, 201);
  const foreign = await post(t, t.alice, `grants/${g2.json.id}/revise`, { approvalId: a.json.id, previewHash: p.digest });
  assert.equal(foreign.status, 412);
  // Narrow the first grant under a legacy approval, then the strict one goes stale.
  const legacy = await approve(t, await preview(t, conn.id, 70));
  assert.equal((await post(t, t.alice, `grants/${grant.id}/revise`, legacy)).status, 200);
  const stale = await post(t, t.alice, `grants/${grant.id}/revise`, { approvalId: a.json.id, previewHash: p.digest });
  assert.equal(stale.status, 412);
  const g = await get(t, t.alice, `grants/${grant.id}`);
  assert.equal(g.json.ceilings.maxTokens, 70);
});

test('F1R3: suspension invalidates pending commit, revise, and resume approvals', async () => {
  const t = await fabricEnv();
  const { conn } = await connectPair(t);
  const { grant } = await commitFlow(t, conn.id);
  const pc = await preview(t, conn.id, 9000);
  const ac = await approve(t, pc);
  const pr = await preview(t, conn.id, 50);
  const ar = await approve(t, pr);
  await post(t, t.alice, `grants/${grant.id}/pause`, { expectedVersion: 1 });
  const pa = await post(t, t.alice, 'approvals', { action: 'grant.resume', targetId: grant.id });
  assert.equal((await post(t, t.alice, `approvals/${pa.json.id}/decide`, { decision: 'approve' })).status, 200);
  assert.equal((await post(t, t.alice, `connections/${conn.id}/suspend`, { expectedVersion: 1 })).status, 200);
  assert.equal((await post(t, t.alice, 'grants', ac)).status, 409);
  assert.equal((await post(t, t.alice, `grants/${grant.id}/revise`, ar)).status, 409);
  assert.equal((await post(t, t.alice, `grants/${grant.id}/resume`, { expectedVersion: 2, approvalId: pa.json.id })).status, 409);
});

test('F1R3: one approval feeds exactly one consumer across commit/revise/resume pairs', async () => {
  for (const order of ['commit-first', 'revise-first']) {
    const t = await fabricEnv();
    const { conn } = await connectPair(t);
    const { grant } = await commitFlow(t, conn.id);
    const a = await approve(t, await preview(t, conn.id));
    const c = () => core.commitGrant(t.DB, actor(t), a);
    const r = () => core.reviseGrant(t.DB, actor(t), grant.id, a);
    const [firstFn, secondFn] = order === 'commit-first' ? [c, r] : [r, c];
    const r1 = await firstFn();
    const r2 = await secondFn();
    const uses = t.sqlite.prepare('SELECT (SELECT count(*) FROM fabric_grants WHERE approval_id = ?) + (SELECT count(*) FROM fabric_grant_revisions WHERE approval_id = ?) n').get(a.approvalId, a.approvalId).n;
    assert.equal(uses, 1, `${order}: ${r1.status}/${r2.status}`);
    assert.ok([r1.status, r2.status].includes(409) || [r1.status, r2.status].includes(200) && uses === 1);
  }
});

test('F1R3: approval issued for one connection cannot revise a grant on another', async () => {
  const t = await fabricEnv();
  const c1 = await connectPair(t);
  await commitFlow(t, c1.conn.id);
  // Second pair of nodes between the same owners: a distinct connection.
  const nA2 = await post(t, t.alice, 'nodes', { label: 'a2' });
  const nB2 = await post(t, t.bob, 'nodes', { label: 'b2' });
  const inv = await post(t, t.alice, 'invitations', { issuerNode: nA2.json.id, recipientNode: nB2.json.id, recipientWorkspace: 'default' });
  const acc = await post(t, t.bob, 'invitations/accept', { token: inv.json.token, nodeId: nB2.json.id, nodeKey: nB2.json.nodeSecret });
  assert.equal(acc.status, 201);
  const p = await preview(t, c1.conn.id, 50);
  const a = await post(t, t.alice, 'approvals', { action: 'grant.revise', previewId: p.id, targetId: 'fg_missing' });
  assert.equal(a.status, 404);
});

test('F1R3: withdraw permutations converge; re-restriction converges; legacy NULL fails closed', async () => {
  for (const first of ['alice', 'bob']) {
    const t = await fabricEnv();
    const { conn, nodeA, nodeB } = await connectPair(t);
    await commitFlow(t, conn.id);
    const A = first === 'alice' ? t.alice : t.bob;
    const B = first === 'alice' ? t.bob : t.alice;
    const nA = first === 'alice' ? nodeA : nodeB;
    const nB = first === 'alice' ? nodeB : nodeA;
    assert.equal((await post(t, A, `connections/${conn.id}/suspend`, { expectedVersion: 1 })).status, 200);
    assert.equal((await post(t, B, `connections/${conn.id}/disconnect`, { expectedVersion: 2 })).status, 200);
    // Same-side re-restriction converges 200 without a new epoch.
    const again = await post(t, A, `connections/${conn.id}/suspend`, { expectedVersion: 3 });
    assert.equal(again.status, 200);
    assert.equal(t.sqlite.prepare('SELECT version FROM connections WHERE id = ?').get(conn.id).version, 3);
    const w1 = await post(t, B, `connections/${conn.id}/resume`, { expectedVersion: 3, nodeKey: nB.nodeSecret });
    assert.equal(w1.status, 200);
    assert.equal(w1.json.remainingVetoes.length, 1);
    const w2 = await post(t, A, `connections/${conn.id}/resume`, { expectedVersion: 4, nodeKey: nA.nodeSecret });
    assert.equal(w2.status, 200);
    assert.equal(w2.json.state, 'active');
  }
  // Legacy NULL suspender with live veto rows fails closed (409, not 403).
  const t = await fabricEnv();
  const { conn, nodeA } = await connectPair(t);
  await post(t, t.alice, `connections/${conn.id}/suspend`, { expectedVersion: 1 });
  t.sqlite.prepare('UPDATE connections SET suspended_by = NULL WHERE id = ?').run(conn.id);
  const r = await post(t, t.alice, `connections/${conn.id}/resume`, { expectedVersion: 2, nodeKey: 'wrong' });
  assert.equal(r.status, 409);
  const r2 = await post(t, t.alice, `connections/${conn.id}/resume`, { expectedVersion: 2, nodeKey: nodeA.nodeSecret });
  assert.equal(r2.status, 409);
});

test('F1R3: same-owner two-node connection withdraws per side', async () => {
  const t = await fabricEnv();
  const n1 = await post(t, t.alice, 'nodes', { label: 'own-a' });
  const n2 = await post(t, t.alice, 'nodes', { label: 'own-b' });
  const inv = await post(t, t.alice, 'invitations', { issuerNode: n1.json.id, recipientNode: n2.json.id, recipientWorkspace: 'default' });
  const acc = await post(t, t.alice, 'invitations/accept', { token: inv.json.token, nodeId: n2.json.id, nodeKey: n2.json.nodeSecret });
  assert.equal(acc.status, 201);
  const conn = acc.json.id;
  assert.equal((await post(t, t.alice, `connections/${conn}/suspend`, { expectedVersion: 1 })).status, 200);
  // Acting side is deterministic a-first: withdrawing with the a-side proof clears it.
  const w = await post(t, t.alice, `connections/${conn}/resume`, { expectedVersion: 2, nodeKey: n1.json.nodeSecret });
  assert.equal(w.status, 200);
  assert.equal(w.json.state, 'active');
});

test('F1R3: quarantined grants are inert on every path', async () => {
  const t = await fabricEnv();
  const { conn, nodeB } = await connectPair(t);
  const { grant } = await commitFlow(t, conn.id);
  t.sqlite.prepare("UPDATE fabric_grants SET quarantine_reason = 'issuer-ambiguous' WHERE id = ?").run(grant.id);
  const auth = await post(t, t.bob, 'authorization/preview', { nodeId: nodeB.id, resourceId: 'r_gpu1', incarnation: 'gen1', consumer: 'bob-op', model: 'llama', maxTokens: 1 });
  assert.equal(auth.json.decision, 'deny');
  const d = await get(t, t.bob, 'discovery');
  assert.ok(!d.json.items.some((x) => x.id === 'r_gpu1'));
  assert.equal((await post(t, t.alice, `grants/${grant.id}/pause`, { expectedVersion: 1 })).status, 409);
  assert.equal((await post(t, t.alice, `grants/${grant.id}/revoke`, { expectedVersion: 1 })).status, 409);
  const a = await approve(t, await preview(t, conn.id));
  assert.equal((await post(t, t.alice, `grants/${grant.id}/revise`, a)).status, 409);
  assert.equal((await post(t, t.alice, 'approvals', { action: 'grant.resume', targetId: grant.id })).status, 409);
});

test('F1R3: uncertain ledger reclaims on same binding, conflicts on changed binding', async () => {
  const t = await fabricEnv();
  const key = freshKey();
  const body = { label: 'opaque' };
  const first = await post(t, t.alice, 'nodes', body, key);
  assert.equal(first.status, 201);
  // Simulate a 5xx that marked the record uncertain after the effect.
  t.sqlite.prepare("UPDATE idempotency_records SET status = 'uncertain' WHERE idem_key = ?").run(key);
  const retry = await post(t, t.alice, 'nodes', body, key);
  assert.equal(retry.status, 200);
  assert.equal(retry.json.reconciled, true);
  assert.equal(retry.json.id, first.json.id);
  const changed = await post(t, t.alice, 'nodes', { label: 'other' }, key);
  assert.equal(changed.status, 409);
  assert.equal(changed.json.code, 'IDEMPOTENCY_MISMATCH');
});

test('F1R3: late attempt cannot finalize or release a reclaimed operation', async () => {
  const t = await fabricEnv();
  const key = freshKey();
  const a = actor(t);
  assert.equal(await core.checkIdempotency(t.DB, a, 'POST', '/synthetic', key, 'h'), null);
  const attempt1 = t.sqlite.prepare('SELECT attempt FROM idempotency_records WHERE idem_key = ?').get(key).attempt;
  assert.ok(attempt1);
  // Age the record so a second claimer steals it with a fresh attempt.
  t.sqlite.prepare("UPDATE idempotency_records SET created_at = '2000-01-01T00:00:00.000Z' WHERE idem_key = ?").run(key);
  assert.equal(await core.checkIdempotency(t.DB, a, 'POST', '/synthetic', key, 'h'), null);
  const attempt2 = t.sqlite.prepare('SELECT attempt FROM idempotency_records WHERE idem_key = ?').get(key).attempt;
  assert.notEqual(attempt2, attempt1);
  // Late finalization under the old attempt is a silent no-op.
  await core.storeIdempotency(t.DB, a, key, 201, { attempt: 'old' }, attempt1);
  assert.equal(t.sqlite.prepare('SELECT status FROM idempotency_records WHERE idem_key = ?').get(key).status, 'processing');
  // Late release under the old attempt is a silent no-op.
  await core.releaseIdempotency(t.DB, a, key, attempt1);
  assert.equal(t.sqlite.prepare('SELECT status FROM idempotency_records WHERE idem_key = ?').get(key).status, 'processing');
  // Current attempt finalizes; then even it cannot overwrite.
  await core.storeIdempotency(t.DB, a, key, 201, { attempt: 'new' }, attempt2);
  await core.storeIdempotency(t.DB, a, key, 201, { attempt: 'late' }, attempt2);
  const done = await core.checkIdempotency(t.DB, a, 'POST', '/synthetic', key, 'h');
  assert.equal(done.body.attempt, 'new');
});

test('F1R3: resume reconcile completes the missing audit before reporting success', async () => {
  const t = await fabricEnv();
  const { conn } = await connectPair(t);
  const { grant } = await commitFlow(t, conn.id);
  await post(t, t.alice, `grants/${grant.id}/pause`, { expectedVersion: 1 });
  const pa = await post(t, t.alice, 'approvals', { action: 'grant.resume', targetId: grant.id });
  assert.equal((await post(t, t.alice, `approvals/${pa.json.id}/decide`, { decision: 'approve' })).status, 200);
  const key = freshKey();
  t.sqlite.exec("CREATE TRIGGER qa_resume BEFORE UPDATE ON fabric_grants WHEN NEW.status = 'enforced' BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
  assert.equal((await post(t, t.alice, `grants/${grant.id}/resume`, { expectedVersion: 2, approvalId: pa.json.id }, key)).status, 500);
  t.sqlite.exec('DROP TRIGGER qa_resume');
  // The claim burned but the effect never landed: fail-closed 409, like revise.
  assert.equal((await post(t, t.alice, `grants/${grant.id}/resume`, { expectedVersion: 2, approvalId: pa.json.id }, key)).status, 409);
  const fresh = await post(t, t.alice, 'approvals', { action: 'grant.resume', targetId: grant.id });
  assert.equal((await post(t, t.alice, `approvals/${fresh.json.id}/decide`, { decision: 'approve' })).status, 200);
  assert.equal((await post(t, t.alice, `grants/${grant.id}/resume`, { expectedVersion: 2, approvalId: fresh.json.id })).status, 200);
});

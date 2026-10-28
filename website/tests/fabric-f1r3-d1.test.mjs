/* Built with Meta Muse. F1R3 workerd-D1 transition tests: the real
 * store/transition code runs against a real local D1 binding (not the
 * node:sqlite shim) with all migrations applied. No Cloudflare account,
 * remote DB, or network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { MIGRATION_FILES } from './d1-shim.mjs';
import * as core from '../src/fabric/store.mjs';
import { SNAPSHOT_VALID, runBatch, changes, vetoWithdraw, acceptRecoverInsert } from '../src/fabric/transitions.mjs';

async function d1Env() {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("local-only")}}',
    compatibilityDate: '2026-10-01',
    d1Databases: { DB: 'f1r3-synthetic' },
    outboundService: () => new Response('blocked', { status: 403 })
  }));
  const db = await mf.getD1Database('DB');
  // D1 exec() runs one statement and rejects leading comments, so
  // strip full-line comments and apply statement by statement
  // (migration files contain no triggers or semicolons in strings).
  // Any setup failure disposes Miniflare: an undisposed instance
  // keeps the event loop alive and hangs the runner.
  try {
    for (const name of MIGRATION_FILES) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      const stripped = sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
      for (const stmt of stripped.split(';')) {
        // D1 exec() takes one single-line statement: collapse
        // newlines (no migration string literal spans lines).
        const s = stmt.replace(/\s+/g, ' ').trim();
        if (s) await db.exec(s);
      }
    }
  const now = new Date().toISOString();
  const mkuser = (id, name, email) => db.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)').bind(id, name, email, now, now).run();
    await mkuser('u_alice', 'Alice', 'alice@example.com');
    await mkuser('u_bob', 'Bob', 'bob@example.com');
    await db.prepare("INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, incarnation, imported_from, created_at) VALUES ('r_gpu1', 'u_alice', 'gpu1', 'gpu', 'local', 'x86', 'a100', 'gen1', NULL, ?)").bind(now).run();
  } catch (e) { await mf.dispose(); throw e; }
  return { mf, db, alice: { kind: 'session', user: { id: 'u_alice' } }, bob: { kind: 'session', user: { id: 'u_bob' } } };
}

test('local D1: full federation flow runs on the real binding', async () => {
  const t = await d1Env();
  try {
    const nA = await core.registerNode(t.db, t.alice, { label: 'a' });
    assert.equal(nA.status, 201);
    const nB = await core.registerNode(t.db, t.bob, { label: 'b' });
    assert.equal(nB.status, 201);
    const inv = await core.createInvitation(t.db, t.alice, { issuerNode: nA.body.id, recipientNode: nB.body.id, recipientWorkspace: 'default' });
    assert.equal(inv.status, 201);
    const acc = await core.acceptInvitation(t.db, t.bob, { token: inv.body.token, nodeId: nB.body.id, nodeKey: nB.body.nodeSecret });
    assert.equal(acc.status, 201);
    const conn = acc.body.id;
    const prev = await core.createPreview(t.db, t.alice, { connectionId: conn, resourceIds: ['r_gpu1'], consumers: ['bob-op'], models: ['llama'], maxTokens: 100, maxRequests: 10 });
    assert.equal(prev.status, 201);
    const appr = await core.requestApproval(t.db, t.alice, { previewId: prev.body.id });
    assert.equal(appr.status, 201);
    assert.equal((await core.decideApproval(t.db, t.alice, appr.body.id, { decision: 'approve' })).status, 200);
    const grant = await core.commitGrant(t.db, t.alice, { approvalId: appr.body.id, previewHash: prev.body.digest });
    assert.equal(grant.status, 201);
    const gid = grant.body.id;
    // Revise with a strict grant.revise approval.
    const p2 = await core.createPreview(t.db, t.alice, { connectionId: conn, resourceIds: ['r_gpu1'], consumers: ['bob-op'], models: ['llama'], maxTokens: 50, maxRequests: 10 });
    const a2 = await core.requestApproval(t.db, t.alice, { action: 'grant.revise', previewId: p2.body.id, targetId: gid });
    assert.equal(a2.status, 201);
    await core.decideApproval(t.db, t.alice, a2.body.id, { decision: 'approve' });
    const rev = await core.reviseGrant(t.db, t.alice, gid, { approvalId: a2.body.id, previewHash: p2.body.digest });
    assert.equal(rev.status, 200);
    assert.equal(rev.body.version, 2);
    // Pause / resume / revoke lifecycle.
    assert.equal((await core.pauseGrant(t.db, t.alice, gid, { expectedVersion: 2 })).status, 200);
    const a3 = await core.requestApproval(t.db, t.alice, { action: 'grant.resume', targetId: gid });
    await core.decideApproval(t.db, t.alice, a3.body.id, { decision: 'approve' });
    assert.equal((await core.resumeGrant(t.db, t.alice, gid, { expectedVersion: 3, approvalId: a3.body.id })).status, 200);
    assert.equal((await core.revokeGrant(t.db, t.alice, gid, { expectedVersion: 4 })).status, 200);
    // Authorization denies for the revoked grant; discovery omits it.
    const authz = await core.authorizationPreview(t.db, t.bob, { nodeId: nB.body.id, resourceId: 'r_gpu1', incarnation: 'gen1', consumer: 'bob-op', model: 'llama', maxTokens: 1 });
    assert.equal(authz.body.decision, 'deny');
    console.log('Local D1 full flow PASS');
  } finally { await t.mf.dispose(); }
});

test('local D1: claim xor, generation staleness, drift rejection, veto race', async () => {
  const t = await d1Env();
  try {
    const nA = await core.registerNode(t.db, t.alice, { label: 'a' });
    const nB = await core.registerNode(t.db, t.bob, { label: 'b' });
    const inv = await core.createInvitation(t.db, t.alice, { issuerNode: nA.body.id, recipientNode: nB.body.id, recipientWorkspace: 'default' });
    const acc = await core.acceptInvitation(t.db, t.bob, { token: inv.body.token, nodeId: nB.body.id, nodeKey: nB.body.nodeSecret });
    const conn = acc.body.id;
    const mk = async (limit) => {
      const p = await core.createPreview(t.db, t.alice, { connectionId: conn, resourceIds: ['r_gpu1'], consumers: ['bob-op'], models: ['llama'], maxTokens: limit, maxRequests: 10 });
      const a = await core.requestApproval(t.db, t.alice, { previewId: p.body.id });
      await core.decideApproval(t.db, t.alice, a.body.id, { decision: 'approve' });
      return { approvalId: a.body.id, previewHash: p.body.digest };
    };
    const g = await core.commitGrant(t.db, t.alice, await mk(9000));
    const gid = g.body.id;
    // Claim xor: one approval cannot feed commit and revise.
    const dual = await mk(50);
    const c1 = await core.commitGrant(t.db, t.alice, dual);
    const r1 = await core.reviseGrant(t.db, t.alice, gid, dual);
    assert.equal(c1.status, 201);
    assert.equal(r1.status, 409);
    const uses = await t.db.prepare('SELECT (SELECT count(*) FROM fabric_grants WHERE approval_id = ?) + (SELECT count(*) FROM fabric_grant_revisions WHERE approval_id = ?) n').bind(dual.approvalId, dual.approvalId).first();
    assert.equal(uses.n, 1);
    // Generation staleness: a pause between request and revise invalidates.
    // (Deterministic pre-read validation throws; REST renders the code.)
    const stale = await mk(60);
    assert.equal((await core.pauseGrant(t.db, t.alice, gid, { expectedVersion: 1 })).status, 200);
    await assert.rejects(core.reviseGrant(t.db, t.alice, gid, stale), { code: 'PREVIEW_STALE' });
    // Drift rejection through the json_each snapshot guard, on real D1.
    const drifted = await mk(70);
    await t.db.prepare("UPDATE resources SET owner_id = 'u_bob' WHERE id = 'r_gpu1'").run();
    await assert.rejects(core.commitGrant(t.db, t.alice, drifted), { code: 'PREVIEW_STALE' });
    // The production write-time guard itself, evaluated on real D1.
    const snap = JSON.stringify([{ resourceId: 'r_gpu1', incarnation: 'gen1' }]);
    const bad = await t.db.prepare(`SELECT (${SNAPSHOT_VALID}) AS v`).bind(snap, 'u_alice').first();
    assert.equal(bad.v, 0);
    await t.db.prepare("UPDATE resources SET owner_id = 'u_alice' WHERE id = 'r_gpu1'").run();
    const good = await t.db.prepare(`SELECT (${SNAPSHOT_VALID}) AS v`).bind(snap, 'u_alice').first();
    assert.equal(good.v, 1);
    // Veto race: exactly one restriction wins at one version. The loser
    // either throws at its stale pre-read or returns the write-race
    // value; both settle without corrupting the winner.
    const race = await Promise.allSettled([
      core.suspendConnection(t.db, t.alice, conn, { expectedVersion: 1 }),
      core.disconnectConnection(t.db, t.bob, conn, { expectedVersion: 1 })
    ]);
    const winners = race.filter((x) => x.status === 'fulfilled' && x.value.status === 200);
    assert.equal(winners.length, 1);
    const row = await t.db.prepare('SELECT version, state FROM connections WHERE id = ?').bind(conn).first();
    assert.equal(row.version, 2);
    assert.notEqual(row.state, 'active');
    // The winner withdraws with its own proof; the connection reactivates.
    const aliceWon = race[0].status === 'fulfilled' && race[0].value.status === 200;
    const w = aliceWon
      ? await core.resumeConnection(t.db, t.alice, conn, { expectedVersion: 2, nodeKey: nA.body.nodeSecret })
      : await core.resumeConnection(t.db, t.bob, conn, { expectedVersion: 2, nodeKey: nB.body.nodeSecret });
    assert.equal(w.status, 200);
    assert.equal(w.body.state, 'active');
    console.log('Local D1 invariants PASS');
  } finally { await t.mf.dispose(); }
});

test('local D1: ledger uncertain-reclaim and completed-immutability', async () => {
  const t = await d1Env();
  try {
    const key = 'd1-key-1';
    assert.equal(await core.checkIdempotency(t.db, t.alice, 'POST', '/synthetic', key, 'h1'), null);
    await core.releaseIdempotency(t.db, t.alice, key);
    const row = await t.db.prepare('SELECT status, request_hash FROM idempotency_records WHERE idem_key = ?').bind(key).first();
    assert.equal(row.status, 'uncertain');
    assert.equal(row.request_hash, 'h1');
    // Changed binding conflicts; same binding reclaims.
    await assert.rejects(core.checkIdempotency(t.db, t.alice, 'POST', '/synthetic', key, 'h2'), { code: 'IDEMPOTENCY_MISMATCH' });
    assert.equal(await core.checkIdempotency(t.db, t.alice, 'POST', '/synthetic', key, 'h1'), null);
    await core.storeIdempotency(t.db, t.alice, key, 201, { ok: true });
    await core.storeIdempotency(t.db, t.alice, key, 201, { ok: false });
    const done = await core.checkIdempotency(t.db, t.alice, 'POST', '/synthetic', key, 'h1');
    assert.equal(done.body.ok, true);
    console.log('Local D1 ledger PASS');
  } finally { await t.mf.dispose(); }
});

test('local D1: lost veto withdrawal and unaccepted recovery change nothing', async () => {
  const t = await d1Env();
  try {
    const nA = await core.registerNode(t.db, t.alice, { label: 'a' });
    const nB = await core.registerNode(t.db, t.bob, { label: 'b' });
    const inv = await core.createInvitation(t.db, t.alice, { issuerNode: nA.body.id, recipientNode: nB.body.id, recipientWorkspace: 'default' });
    // Recovery insert against a merely issued invitation: zero rows.
    const now = new Date().toISOString();
    const rec = acceptRecoverInsert({ connId: 'conn_d1probe', invId: inv.body.id, aNode: nA.body.id, bNode: nB.body.id, aWs: 'default', bWs: 'default', now, actorId: 'u_bob' });
    assert.equal(changes(await runBatch(t.db, [rec]), 0), 0);
    assert.equal(await t.db.prepare('SELECT count(*) n FROM connections').first('n'), 0);
    const acc = await core.acceptInvitation(t.db, t.bob, { token: inv.body.token, nodeId: nB.body.id, nodeKey: nB.body.nodeSecret });
    const conn = acc.body.id;
    assert.equal((await core.suspendConnection(t.db, t.alice, conn, { expectedVersion: 1 })).status, 200);
    assert.equal((await core.disconnectConnection(t.db, t.bob, conn, { expectedVersion: 2 })).status, 200);
    // A withdrawal pinned to a superseded version deletes no veto.
    const stale = vetoWithdraw({ connId: conn, sides: [nB.body.id], version: 2, newState: 'disconnected', suspendedBy: nA.body.id, mirror: JSON.stringify([nA.body.id]), remaining: 1, now, actorId: 'u_bob' });
    const res = await runBatch(t.db, stale);
    assert.equal(changes(res, 0), 0);
    assert.equal(changes(res, 1), 0);
    assert.equal(await t.db.prepare('SELECT count(*) n FROM connection_vetoes WHERE connection_id = ?').bind(conn).first('n'), 2);
    // The current version withdraws exactly the proven side.
    const live = vetoWithdraw({ connId: conn, sides: [nB.body.id], newState: 'disconnected', suspendedBy: nA.body.id, mirror: JSON.stringify([nA.body.id]), remaining: 1, now, actorId: 'u_bob', version: 3 });
    const ok = await runBatch(t.db, live);
    assert.equal(changes(ok, 0), 1);
    assert.equal(changes(ok, 1), 1);
    console.log('Local D1 review fences PASS');
  } finally { await t.mf.dispose(); }
});

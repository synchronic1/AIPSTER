import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fabricEnv } from './qa-helpers.mjs';
import { MIGRATION_FILES } from './d1-shim.mjs';
import * as core from '../src/fabric/store.mjs';

export async function revisionFixture(realD1 = false) {
  let db, close;
  if (!realD1) {
    const t = await fabricEnv(); db = t.DB; close = () => t.sqlite.close();
  } else {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
      script: 'export default {fetch(){return new Response("synthetic only")}}',
      compatibilityDate: '2026-10-01', d1Databases: { DB: 'revision-synthetic' },
      outboundService: () => new Response('blocked', { status: 403 }) }));
    close = () => mf.dispose();
    try {
      db = await mf.getD1Database('DB');
      for (const file of MIGRATION_FILES) {
        const sql = (await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'))
          .split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
        for (const stmt of sql.split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) await db.exec(stmt);
      }
      for (const who of ['alice', 'bob']) await db.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)')
        .bind('u_' + who, who, who + '@synthetic.invalid', '2026-01-01', '2026-01-01').run();
      await db.prepare("INSERT INTO resources (id,owner_id,name,kind,origin,cpu,gpu,incarnation,created_at) VALUES ('r_gpu1','u_alice','synthetic','local','declared','x86','none','gen1','2026-01-01')").run();
    } catch (e) { await close(); throw e; }
  }
  const alice = { kind: 'session', user: { id: 'u_alice' } }, bob = { kind: 'session', user: { id: 'u_bob' } };
  try {
    const a = (await core.registerNode(db, alice, { label: 'a' })).body;
    const b = (await core.registerNode(db, bob, { label: 'b' })).body;
    const inv = (await core.createInvitation(db, alice, { issuerNode: a.id, recipientNode: b.id, recipientWorkspace: 'default' })).body;
    const conn = (await core.acceptInvitation(db, bob, { token: inv.token, nodeId: b.id, nodeKey: b.nodeSecret })).body.id;
    const approval = async (limit, targetId) => {
      const p = (await core.createPreview(db, alice, { connectionId: conn, resourceIds: ['r_gpu1'], consumers: ['bob-op'], models: ['llama'], maxTokens: limit, maxRequests: 10 })).body;
      const ap = (await core.requestApproval(db, alice, { previewId: p.id, ...(targetId ? { action: 'grant.revise', targetId } : {}) })).body;
      assert.equal((await core.decideApproval(db, alice, ap.id, { decision: 'approve' })).status, 200);
      return { approvalId: ap.id, previewHash: p.digest };
    };
    const grant = (await core.commitGrant(db, alice, await approval(1000))).body.id;
    const before = await db.prepare('SELECT * FROM fabric_grants WHERE id = ?').bind(grant).first();
    const input = await approval(50, grant), op = { key: 'revision-original-operation', path: `/v1/fabric/grants/${grant}/revise` };
    const state = async () => ({
      grant: await db.prepare('SELECT * FROM fabric_grants WHERE id = ?').bind(grant).first(),
      receipts: (await db.prepare('SELECT * FROM fabric_revision_receipts ORDER BY before_version').all()).results,
      history: (await db.prepare('SELECT * FROM fabric_grant_revisions ORDER BY version').all()).results,
      audits: (await db.prepare("SELECT * FROM audit WHERE action = 'fabric.grant.revise' ORDER BY id").all()).results,
      generation: (await db.prepare('SELECT grant_gen FROM connections WHERE id = ?').bind(conn).first()).grant_gen,
    });
    return { db, close, alice, bob, conn, grant, input, op, before, approval, state,
      revise: (binding = db) => core.reviseGrant(binding, alice, grant, input, op) };
  } catch (e) { await close(); throw e; }
}

// Faults immediately before/after individual run() commits or batch commits.
// Native statements are passed through to real D1; no shim transaction claims
// are substituted for workerd's behavior.
export function faultOnce(db, match, phase = 'before', batch = false, hook = null) {
  let fired = false;
  const fail = () => { throw Object.assign(new Error('synthetic persistence fault'), { status: 500 }); };
  const wrap = (raw, sql) => ({ raw, sql,
    bind: (...p) => wrap(raw.bind(...p), sql),
    first: (...p) => raw.first(...p), all: (...p) => raw.all(...p),
    async run() {
      if (!batch && !fired && match.test(sql)) {
        fired = true;
        if (hook) { await hook(); return raw.run(); }
        if (phase === 'before') fail();
        const result = await raw.run(); fail(); return result;
      }
      return raw.run();
    }
  });
  return { prepare: sql => wrap(db.prepare(sql), sql), exec: sql => db.exec(sql),
    async batch(stmts) {
      const raw = stmts.map(s => s.raw || s);
      if (batch && !fired && stmts.some(s => match.test(s.sql || ''))) {
        fired = true;
        if (hook) { await hook(); return db.batch(raw); }
        if (phase === 'before') fail();
        const result = await db.batch(raw); fail(); return result;
      }
      return db.batch(raw);
    }
  };
}

export function assertComplete(s, before, input, after = s.grant) {
  // node:sqlite returns null-prototype rows; compare JSON content, not prototypes.
  before = { ...before }; after = { ...after };
  assert.equal(s.receipts.length, 1); assert.equal(s.history.length, 1); assert.equal(s.audits.length, 1);
  const r = s.receipts[0], h = s.history[0], a = s.audits[0];
  assert.deepEqual(JSON.parse(r.before_json), before);
  assert.deepEqual(JSON.parse(r.after_json), after);
  assert.equal(r.before_version, before.version); assert.equal(r.after_version, before.version + 1);
  assert.equal(r.approval_id, input.approvalId); assert.equal(r.actor_id, 'u_alice');
  const approval = JSON.parse(r.approval_json);
  assert.equal(approval.id, input.approvalId); assert.equal(approval.preview_digest, input.previewHash);
  assert.equal(approval.consumed_by_op, r.operation_id); assert.equal(approval.consumed_target, before.id);
  assert.equal(approval.consumed_action, 'grant.revise'); assert.equal(approval.approver, 'u_alice');
  assert.equal(approval.decision, 'approved');
  assert.deepEqual(JSON.parse(h.terms_json), { consumers: JSON.parse(before.consumers), snapshot: JSON.parse(before.snapshot),
    ceilings: JSON.parse(before.ceilings), before, after, operationId: r.operation_id, approval });
  assert.equal(h.version, before.version); assert.equal(h.approval_id, input.approvalId);
  assert.equal(h.superseded_at, r.applied_at); assert.equal(a.at, r.applied_at);
  assert.equal(a.actor_id, r.actor_id); assert.equal(a.target, before.id); assert.equal(a.detail, `v${r.after_version} via session`);
}

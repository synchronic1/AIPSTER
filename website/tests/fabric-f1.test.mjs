/* Built with Meta Muse. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { mintKey, verifierFor, KEY_PREFIX } from '../src/lib/keys.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let idemCounter = 0;
const freshKey = () => `test-idem-${++idemCounter}-${randomBytes(4).toString('hex')}`;

async function fabricEnv({ flag = true } = {}) {
  const t = await createTestEnv(flag ? { FEDERATION_ENABLED: '1' } : {});
  const now = new Date().toISOString();
  await t.DB.prepare(`INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated, online, usable, heartbeat_at, limits_json, scope, verification_json, credits_json, created_at)
    VALUES ('r_gpu1','u_alice','gpu-1','local','declared','x','y','[]',1,0,0,0,NULL,'{}','owner only','{}',NULL,?)`).bind(now).run();
  // Demo identity with a real session row (same session path as other users).
  const demoToken = randomBytes(32).toString('hex');
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, username, displayUsername, demo, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('u_demo', 'Synthetic Demo', 'demo@aipster.invalid', 0, null, 'demo', 'demo', 1, now, now).run();
  const future = new Date(Date.now() + 12 * 3600e3).toISOString();
  await t.DB.prepare('INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('s_demo01', future, demoToken, now, now, null, 'test', 'u_demo').run();
  t.demo = { id: 'u_demo', token: demoToken };
  // API keys for alice: inference-scoped (narrowing allowed) + read-scoped.
  t.apiKeys = {};
  for (const scope of ['inference', 'read']) {
    const { id, secret, short } = mintKey(KEY_PREFIX);
    const salt = randomBytes(16).toString('hex');
    await t.DB.prepare('INSERT INTO key_verifiers (id, owner_id, name, scope, salt, verifier, prefix, expires_at, metadata, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)')
      .bind(id, 'u_alice', `${scope} key`, scope, salt, await verifierFor(secret, salt), KEY_PREFIX + id + '_' + short, null, '', now).run();
    t.apiKeys[scope] = secret;
  }
  return t;
}

const S = (t, user, extra = {}) => ({ ...t.as(user), ...t.csrf, ...extra });
const K = (t, scope, extra = {}) => ({ Authorization: `Bearer ${t.apiKeys[scope]}`, ...extra });

// Full alice->bob connection; returns { nodeA, nodeB, keyA, keyB, conn }.
async function connectPair(t) {
  const regA = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { label: 'alice-node' } }));
  const regB = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: S(t, t.bob, { 'Idempotency-Key': freshKey() }), body: { label: 'bob-node' } }));
  assert.equal(regA.status, 201);
  assert.equal(regB.status, 201);
  const inv = await readJson(await t.call('/v1/fabric/invitations', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { issuerNode: regA.json.id, recipientNode: regB.json.id, recipientWorkspace: 'default', purpose: 'pair test' } }));
  assert.equal(inv.status, 201);
  const acc = await readJson(await t.call('/v1/fabric/invitations/accept', { method: 'POST', headers: S(t, t.bob, { 'Idempotency-Key': freshKey() }), body: { token: inv.json.token, nodeId: regB.json.id, nodeKey: regB.json.nodeSecret } }));
  assert.equal(acc.status, 201);
  return { nodeA: regA.json, nodeB: regB.json, conn: acc.json };
}

async function commitFlow(t, connId, resourceIds = ['r_gpu1']) {
  const prev = await readJson(await t.call('/v1/fabric/previews', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { connectionId: connId, resourceIds, consumers: ['bob-op'], models: ['llama'], maxTokens: 1000, maxRequests: 10 } }));
  assert.equal(prev.status, 201);
  const appr = await readJson(await t.call('/v1/fabric/approvals', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { previewId: prev.json.id } }));
  assert.equal(appr.status, 201);
  const dec = await readJson(await t.call(`/v1/fabric/approvals/${appr.json.id}/decide`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { decision: 'approve' } }));
  assert.equal(dec.status, 200);
  const grant = await readJson(await t.call('/v1/fabric/grants', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { approvalId: appr.json.id, previewHash: prev.json.digest } }));
  assert.equal(grant.status, 201);
  return { prev: prev.json, appr: appr.json, grant: grant.json };
}

// ---- A. flag, migrations, transport guards ----
test('F1: migration 0005 creates fabric tables and columns', async () => {
  const t = await fabricEnv();
  const names = t.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const tbl of ['fabric_nodes', 'invitations', 'connections', 'grant_previews', 'approvals', 'fabric_grants', 'fabric_grant_revisions', 'fabric_denies', 'idempotency_records']) {
    assert.ok(names.includes(tbl), `missing ${tbl}`);
  }
  const cols = (tbl) => t.sqlite.prepare('SELECT * FROM pragma_table_info(?)').all(tbl).map((c) => c.name);
  assert.ok(cols('resources').includes('incarnation'));
  assert.ok(cols('resources').includes('imported_from'));
  assert.ok(cols('key_verifiers').includes('delegate'));
});

test('F1: flag off hides every fabric route as 404', async () => {
  const t = await fabricEnv({ flag: false });
  for (const [method, p] of [['GET', '/v1/fabric/nodes'], ['POST', '/v1/fabric/nodes'], ['GET', '/v1/fabric/grants'], ['POST', '/v1/fabric/mcp']]) {
    const r = await readJson(await t.call(p, { method, headers: S(t, t.alice), body: method === 'POST' ? {} : undefined }));
    assert.equal(r.status, 404, `${method} ${p}`);
    assert.equal(r.json.code, 'NOT_FOUND');
  }
});

test('F1: unauthenticated fabric access is rejected', async () => {
  const t = await fabricEnv();
  const g = await readJson(await t.call('/v1/fabric/nodes'));
  assert.equal(g.status, 401);
  const p = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: { 'Idempotency-Key': freshKey() }, body: { label: 'x' } }));
  assert.equal(p.status, 401);
});

test('F1: session mutations need CSRF and an Idempotency-Key', async () => {
  const t = await fabricEnv();
  const noCsrf = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: { ...t.as(t.alice), 'Idempotency-Key': freshKey() }, body: { label: 'x' } }));
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.code, 'CSRF_REQUIRED');
  const noIdem = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: S(t, t.alice), body: { label: 'x' } }));
  assert.equal(noIdem.status, 400);
  assert.equal(noIdem.json.code, 'IDEMPOTENCY_REQUIRED');
});

test('F1: replayed Idempotency-Key returns the recorded response once', async () => {
  const t = await fabricEnv();
  const key = freshKey();
  const first = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': key }), body: { label: 'once' } }));
  assert.equal(first.status, 201);
  const replay = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': key }), body: { label: 'once' } }));
  assert.equal(replay.status, 201);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.id, first.json.id);
  const list = await readJson(await t.call('/v1/fabric/nodes', { headers: S(t, t.alice) }));
  assert.equal(list.json.total, 1);
  const clash = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': key }), body: { label: 'different' } }));
  assert.equal(clash.status, 409);
  assert.equal(clash.json.code, 'IDEMPOTENCY_MISMATCH');
});

test('F1: demo fabric is read-only', async () => {
  const t = await fabricEnv();
  const w = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: S(t, t.demo, { 'Idempotency-Key': freshKey() }), body: { label: 'demo-node' } }));
  assert.equal(w.status, 403);
  assert.equal(w.json.code, 'DEMO_RESTRICTED');
  const r = await readJson(await t.call('/v1/fabric/nodes', { headers: S(t, t.demo) }));
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 0);
});

// ---- B. nodes + invitations ----
test('F1: node secrets are one-time and never listed', async () => {
  const t = await fabricEnv();
  const reg = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { label: 'a1', workspace: 'lab' } }));
  assert.equal(reg.status, 201);
  assert.ok(reg.json.nodeSecret.length > 20);
  const get = await readJson(await t.call(`/v1/fabric/nodes/${reg.json.id}`, { headers: S(t, t.alice) }));
  assert.equal(get.status, 200);
  assert.ok(!('node_secret_verifier' in get.json) && !('nodeSecret' in get.json));
  const other = await readJson(await t.call(`/v1/fabric/nodes/${reg.json.id}`, { headers: S(t, t.bob) }));
  assert.equal(other.status, 404);
});

test('F1: API keys cannot register nodes or invite', async () => {
  const t = await fabricEnv();
  const reg = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: K(t, 'inference', { 'Idempotency-Key': freshKey() }), body: { label: 'k' } }));
  assert.equal(reg.status, 403);
  const inv = await readJson(await t.call('/v1/fabric/invitations', { method: 'POST', headers: K(t, 'inference', { 'Idempotency-Key': freshKey() }), body: {} }));
  assert.equal(inv.status, 403);
});

test('F1: invitation validation rejects unknown, self, and cross-tenant targets', async () => {
  const t = await fabricEnv();
  const reg = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { label: 'a1' } }));
  const ghost = await readJson(await t.call('/v1/fabric/invitations', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { issuerNode: reg.json.id, recipientNode: 'node_ghost', recipientWorkspace: 'default' } }));
  assert.equal(ghost.status, 404);
  const self = await readJson(await t.call('/v1/fabric/invitations', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { issuerNode: reg.json.id, recipientNode: reg.json.id, recipientWorkspace: 'default' } }));
  assert.equal(self.status, 400);
  const otherNode = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: S(t, t.bob, { 'Idempotency-Key': freshKey() }), body: { label: 'b1' } }));
  const cross = await readJson(await t.call('/v1/fabric/invitations', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { issuerNode: otherNode.json.id, recipientNode: reg.json.id, recipientWorkspace: 'default' } }));
  assert.equal(cross.status, 404);
});

test('F1: acceptance proves token + node ownership + node secret; single use', async () => {
  const t = await fabricEnv();
  const regA = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { label: 'a1' } }));
  const regB = await readJson(await t.call('/v1/fabric/nodes', { method: 'POST', headers: S(t, t.bob, { 'Idempotency-Key': freshKey() }), body: { label: 'b1' } }));
  const inv = await readJson(await t.call('/v1/fabric/invitations', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { issuerNode: regA.json.id, recipientNode: regB.json.id, recipientWorkspace: 'default' } }));
  const token = inv.json.token;
  const badKey = await readJson(await t.call('/v1/fabric/invitations/accept', { method: 'POST', headers: S(t, t.bob, { 'Idempotency-Key': freshKey() }), body: { token, nodeId: regB.json.id, nodeKey: 'wrong' } }));
  assert.equal(badKey.status, 403);
  const wrongNode = await readJson(await t.call('/v1/fabric/invitations/accept', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { token, nodeId: regA.json.id, nodeKey: regA.json.nodeSecret } }));
  assert.equal(wrongNode.status, 403);
  const okAcc = await readJson(await t.call('/v1/fabric/invitations/accept', { method: 'POST', headers: S(t, t.bob, { 'Idempotency-Key': freshKey() }), body: { token, nodeId: regB.json.id, nodeKey: regB.json.nodeSecret } }));
  assert.equal(okAcc.status, 201);
  assert.equal(okAcc.json.state, 'active');
  const again = await readJson(await t.call('/v1/fabric/invitations/accept', { method: 'POST', headers: S(t, t.bob, { 'Idempotency-Key': freshKey() }), body: { token, nodeId: regB.json.id, nodeKey: regB.json.nodeSecret } }));
  assert.equal(again.status, 409);
  // Acceptance alone grants zero access: discovery shows nothing new for bob.
  const disc = await readJson(await t.call('/v1/fabric/discovery', { headers: S(t, t.bob) }));
  assert.equal(disc.json.total, 0);
});

test('F1: invitation visibility is limited to issuer and recipient sides', async () => {
  const t = await fabricEnv();
  const { nodeA, nodeB } = await connectPair(t);
  assert.ok(nodeA.id && nodeB.id);
  const out = await readJson(await t.call('/v1/fabric/invitations?role=issued', { headers: S(t, t.alice) }));
  assert.equal(out.json.total, 1);
  assert.ok(!('token_verifier' in out.json.items[0]));
  const inc = await readJson(await t.call('/v1/fabric/invitations?role=received', { headers: S(t, t.bob) }));
  assert.equal(inc.json.total, 1);
  const demo = await readJson(await t.call('/v1/fabric/invitations?role=received', { headers: S(t, t.demo) }));
  assert.equal(demo.json.total, 0);
  const ghost = await readJson(await t.call(`/v1/fabric/invitations/${out.json.items[0].id}`, { headers: S(t, t.demo) }));
  assert.equal(ghost.status, 404);
});

// ---- C. previews, approvals, grants ----
test('F1: previews bind owner-controlled resources and report exclusions', async () => {
  const t = await fabricEnv();
  const { conn } = await connectPair(t);
  const foreign = await readJson(await t.call('/v1/fabric/previews', { method: 'POST', headers: S(t, t.bob, { 'Idempotency-Key': freshKey() }), body: { connectionId: conn.id, resourceIds: ['r_gpu1'], consumers: ['x'], models: ['llama'], maxTokens: 10, maxRequests: 1 } }));
  assert.equal(foreign.status, 422);
  const prev = await readJson(await t.call('/v1/fabric/previews', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { connectionId: conn.id, resourceIds: ['r_gpu1'], consumers: ['bob-op'], models: ['llama'], maxTokens: 1000, maxRequests: 10 } }));
  assert.equal(prev.status, 201);
  assert.match(prev.json.digest, /^[0-9a-f]{64}$/);
  assert.ok(prev.json.confirmation.includes('r_gpu1') || prev.json.confirmation.includes('1 resource'));
  assert.equal(prev.json.preview.route, 'fixture');
});

test('F1: commit requires an approved, hash-matching approval', async () => {
  const t = await fabricEnv();
  const { conn } = await connectPair(t);
  const prev = await readJson(await t.call('/v1/fabric/previews', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { connectionId: conn.id, resourceIds: ['r_gpu1'], consumers: ['bob-op'], models: ['llama'], maxTokens: 1000, maxRequests: 10 } }));
  const appr = await readJson(await t.call('/v1/fabric/approvals', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { previewId: prev.json.id } }));
  const early = await readJson(await t.call('/v1/fabric/grants', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { approvalId: appr.json.id, previewHash: prev.json.digest } }));
  assert.equal(early.status, 409);
  const importerDecide = await readJson(await t.call(`/v1/fabric/approvals/${appr.json.id}/decide`, { method: 'POST', headers: S(t, t.bob, { 'Idempotency-Key': freshKey() }), body: { decision: 'approve' } }));
  assert.equal(importerDecide.status, 403);
  await readJson(await t.call(`/v1/fabric/approvals/${appr.json.id}/decide`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { decision: 'approve' } }));
  const wrongHash = await readJson(await t.call('/v1/fabric/grants', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { approvalId: appr.json.id, previewHash: '0'.repeat(64) } }));
  assert.equal(wrongHash.status, 412);
  const keyCommit = await readJson(await t.call('/v1/fabric/grants', { method: 'POST', headers: K(t, 'inference', { 'Idempotency-Key': freshKey() }), body: { approvalId: appr.json.id, previewHash: prev.json.digest } }));
  assert.equal(keyCommit.status, 403);
  const okCommit = await readJson(await t.call('/v1/fabric/grants', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { approvalId: appr.json.id, previewHash: prev.json.digest } }));
  assert.equal(okCommit.status, 201);
  assert.equal(okCommit.json.status, 'enforced');
});

test('F1: committed grants authorize the importer and nobody else', async () => {
  const t = await fabricEnv();
  const { conn, nodeB } = await connectPair(t);
  const { grant } = await commitFlow(t, conn.id);
  const allow = await readJson(await t.call('/v1/fabric/authorization/preview', { method: 'POST', headers: S(t, t.bob), body: { nodeId: nodeB.id, resourceId: 'r_gpu1', incarnation: 'gen1', action: 'infer', model: 'llama', consumer: 'bob-op', maxTokens: 100 } }));
  assert.equal(allow.json.decision, 'allow');
  const wrongModel = await readJson(await t.call('/v1/fabric/authorization/preview', { method: 'POST', headers: S(t, t.bob), body: { nodeId: nodeB.id, resourceId: 'r_gpu1', incarnation: 'gen1', action: 'infer', model: 'other', consumer: 'bob-op', maxTokens: 100 } }));
  assert.equal(wrongModel.json.decision, 'deny');
  const third = await readJson(await t.call(`/v1/fabric/grants/${grant.id}`, { headers: S(t, t.demo) }));
  assert.equal(third.status, 404);
  const disc = await readJson(await t.call('/v1/fabric/discovery', { headers: S(t, t.bob) }));
  assert.equal(disc.json.total, 1);
  assert.equal(disc.json.items[0].via, 'grant');
});

test('F1: only the exporter pauses; inference keys may narrow, read keys may not', async () => {
  const t = await fabricEnv();
  const { conn, nodeB } = await connectPair(t);
  const { grant } = await commitFlow(t, conn.id);
  const importer = await readJson(await t.call(`/v1/fabric/grants/${grant.id}/pause`, { method: 'POST', headers: S(t, t.bob, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 1 } }));
  assert.equal(importer.status, 403);
  const stale = await readJson(await t.call(`/v1/fabric/grants/${grant.id}/pause`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 99 } }));
  assert.equal(stale.status, 412);
  const readKey = await readJson(await t.call(`/v1/fabric/grants/${grant.id}/pause`, { method: 'POST', headers: K(t, 'read', { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 1 } }));
  assert.equal(readKey.status, 403);
  const narrowed = await readJson(await t.call(`/v1/fabric/grants/${grant.id}/pause`, { method: 'POST', headers: K(t, 'inference', { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 1 } }));
  assert.equal(narrowed.status, 200);
  assert.equal(narrowed.json.status, 'paused');
  const denied = await readJson(await t.call('/v1/fabric/authorization/preview', { method: 'POST', headers: S(t, t.bob), body: { nodeId: nodeB.id, resourceId: 'r_gpu1', incarnation: 'gen1', action: 'infer', model: 'llama', consumer: 'bob-op', maxTokens: 100 } }));
  assert.equal(denied.json.decision, 'deny');
  // Resume is human-only and needs a fresh resume approval bound to the grant.
  const noAppr = await readJson(await t.call(`/v1/fabric/grants/${grant.id}/resume`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 2 } }));
  assert.equal(noAppr.status, 409);
  const rappr = await readJson(await t.call('/v1/fabric/approvals', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { action: 'grant.resume', targetId: grant.id } }));
  await readJson(await t.call(`/v1/fabric/approvals/${rappr.json.id}/decide`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { decision: 'approve' } }));
  const resumed = await readJson(await t.call(`/v1/fabric/grants/${grant.id}/resume`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 2, approvalId: rappr.json.id } }));
  assert.equal(resumed.json.status, 'enforced');
  const revoked = await readJson(await t.call(`/v1/fabric/grants/${grant.id}/revoke`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 3 } }));
  assert.equal(revoked.json.status, 'revoked');
  const again = await readJson(await t.call(`/v1/fabric/grants/${grant.id}/revoke`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 4 } }));
  assert.equal(again.json.status, 'revoked');
});

test('F1: revise supersedes terms with a recorded revision', async () => {
  const t = await fabricEnv();
  const { conn } = await connectPair(t);
  const { grant } = await commitFlow(t, conn.id);
  const prev = await readJson(await t.call('/v1/fabric/previews', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { connectionId: conn.id, resourceIds: ['r_gpu1'], consumers: ['bob-op', 'bob-batch'], models: ['llama'], maxTokens: 500, maxRequests: 5 } }));
  const appr = await readJson(await t.call('/v1/fabric/approvals', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { previewId: prev.json.id } }));
  await readJson(await t.call(`/v1/fabric/approvals/${appr.json.id}/decide`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { decision: 'approve' } }));
  const rev = await readJson(await t.call(`/v1/fabric/grants/${grant.id}/revise`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { approvalId: appr.json.id, previewHash: prev.json.digest } }));
  assert.equal(rev.status, 200);
  assert.equal(rev.json.version, 2);
  const got = await readJson(await t.call(`/v1/fabric/grants/${grant.id}`, { headers: S(t, t.alice) }));
  assert.deepEqual(got.json.consumers, ['bob-op', 'bob-batch']);
  const rows = t.sqlite.prepare('SELECT * FROM fabric_grant_revisions WHERE grant_id = ?').all(grant.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, 1);
});

// ---- D. connections, denies ----
test('F1: suspend/disconnect gate enforcement; resume needs a side node secret', async () => {
  const t = await fabricEnv();
  const { conn, nodeA, nodeB } = await connectPair(t);
  await commitFlow(t, conn.id);
  const susp = await readJson(await t.call(`/v1/fabric/connections/${conn.id}/suspend`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 1 } }));
  assert.equal(susp.json.state, 'suspended');
  const gated = await readJson(await t.call('/v1/fabric/authorization/preview', { method: 'POST', headers: S(t, t.bob), body: { nodeId: nodeB.id, resourceId: 'r_gpu1', incarnation: 'gen1', action: 'infer', model: 'llama', consumer: 'bob-op', maxTokens: 100 } }));
  assert.equal(gated.json.decision, 'deny');
  const noProof = await readJson(await t.call(`/v1/fabric/connections/${conn.id}/resume`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 2, nodeKey: 'wrong' } }));
  assert.equal(noProof.status, 403);
  const resumed = await readJson(await t.call(`/v1/fabric/connections/${conn.id}/resume`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 2, nodeKey: nodeA.nodeSecret } }));
  assert.equal(resumed.json.state, 'active');
  const disc = await readJson(await t.call(`/v1/fabric/connections/${conn.id}/disconnect`, { method: 'POST', headers: K(t, 'inference', { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 3 } }));
  assert.equal(disc.json.state, 'disconnected');
  const prev = await readJson(await t.call('/v1/fabric/previews', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { connectionId: conn.id, resourceIds: ['r_gpu1'], consumers: ['x'], models: ['llama'], maxTokens: 1, maxRequests: 1 } }));
  assert.equal(prev.status, 409);
});

test('F1: denies override matching grants and are owner-scoped', async () => {
  const t = await fabricEnv();
  const { conn, nodeB } = await connectPair(t);
  await commitFlow(t, conn.id);
  const deny = await readJson(await t.call('/v1/fabric/denies', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { resourceId: 'r_gpu1', action: 'infer' } }));
  assert.equal(deny.status, 201);
  const blocked = await readJson(await t.call('/v1/fabric/authorization/preview', { method: 'POST', headers: S(t, t.bob), body: { nodeId: nodeB.id, resourceId: 'r_gpu1', incarnation: 'gen1', action: 'infer', model: 'llama', consumer: 'bob-op', maxTokens: 100 } }));
  assert.equal(blocked.json.decision, 'deny');
  const foreign = await readJson(await t.call('/v1/fabric/denies', { method: 'POST', headers: S(t, t.bob, { 'Idempotency-Key': freshKey() }), body: { resourceId: 'r_gpu1' } }));
  assert.equal(foreign.status, 404);
  await readJson(await t.call(`/v1/fabric/denies/${deny.json.id}`, { method: 'DELETE', headers: S(t, t.alice) }));
  const open = await readJson(await t.call('/v1/fabric/authorization/preview', { method: 'POST', headers: S(t, t.bob), body: { nodeId: nodeB.id, resourceId: 'r_gpu1', incarnation: 'gen1', action: 'infer', model: 'llama', consumer: 'bob-op', maxTokens: 100 } }));
  assert.equal(open.json.decision, 'allow');
});

// ---- E. MCP parity ----
test('F1: MCP tools mirror REST reads and enforce the same guards', async () => {
  const t = await fabricEnv();
  const { nodeA } = await connectPair(t);
  const mcp = (tool, params, headers, key) => t.call('/v1/fabric/mcp', { method: 'POST', headers, body: { tool, params, ...(key ? { idempotencyKey: key } : {}) } });
  const rest = await readJson(await t.call('/v1/fabric/nodes', { headers: S(t, t.alice) }));
  const viaMcp = await readJson(await mcp('fabric.list_nodes', {}, S(t, t.alice)));
  assert.equal(viaMcp.status, 200);
  assert.deepEqual(viaMcp.json.result.items.map((n) => n.id).sort(), rest.json.items.map((n) => n.id).sort());
  const unknown = await readJson(await mcp('fabric.nope', {}, S(t, t.alice)));
  assert.equal(unknown.status, 400);
  const anonKnown = await readJson(await t.call('/v1/fabric/mcp', { method: 'POST', body: { tool: 'fabric.list_nodes', params: {} } }));
  assert.equal(anonKnown.status, 401);
  const anonUnknown = await readJson(await t.call('/v1/fabric/mcp', { method: 'POST', body: { tool: 'fabric.nope', params: {} } }));
  assert.equal(anonUnknown.status, 401);
  const noKey = await readJson(await mcp('fabric.register_node', { label: 'm' }, S(t, t.alice)));
  assert.equal(noKey.status, 400);
  assert.equal(noKey.json.code, 'IDEMPOTENCY_REQUIRED');
  const keyCommit = await readJson(await mcp('fabric.commit_grant', { approvalId: 'x', previewHash: 'y' }, K(t, 'inference'), freshKey()));
  assert.equal(keyCommit.status, 403);
  const created = await readJson(await mcp('fabric.register_node', { label: 'via-mcp' }, S(t, t.alice), freshKey()));
  assert.equal(created.status, 201);
  assert.ok(created.json.result.nodeSecret);
  assert.ok(nodeA.id);
  const missingId = await readJson(await mcp('fabric.get_grant', {}, S(t, t.alice)));
  assert.equal(missingId.status, 404);
  const missingPause = await readJson(await mcp('fabric.pause_grant', {}, S(t, t.alice), freshKey()));
  assert.equal(missingPause.status, 404);
});

test('F1: MCP narrowing and replay match REST semantics', async () => {
  const t = await fabricEnv();
  const { conn } = await connectPair(t);
  const { grant } = await commitFlow(t, conn.id);
  const mcp = (tool, params, headers, key) => t.call('/v1/fabric/mcp', { method: 'POST', headers, body: { tool, params, ...(key ? { idempotencyKey: key } : {}) } });
  const key = freshKey();
  const paused = await readJson(await mcp('fabric.pause_grant', { id: grant.id, expectedVersion: 1 }, K(t, 'inference'), key));
  assert.equal(paused.status, 200);
  assert.equal(paused.json.result.status, 'paused');
  const replay = await readJson(await mcp('fabric.pause_grant', { id: grant.id, expectedVersion: 1 }, K(t, 'inference'), key));
  assert.equal(replay.json.replayed, true);
  const got = await readJson(await t.call(`/v1/fabric/grants/${grant.id}`, { headers: S(t, t.alice) }));
  assert.equal(got.json.version, 2);
});

// ---- F. UI static coverage: every fab id is wired and cleared ----
test('F1: federation UI ids are all referenced and secrets cleared on reset', async () => {
  const html = await readFile(path.join(ROOT, 'public', 'app', 'index.html'), 'utf8');
  const js = await readFile(path.join(ROOT, 'public', 'app', 'app.js'), 'utf8');
  const ids = [...html.matchAll(/id="(fab-[a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 20, 'federation tab markup present');
  assert.ok(html.includes('data-tab="federation"'));
  for (const id of new Set(ids)) {
    assert.ok(js.includes(id), `app.js references ${id}`);
  }
  assert.ok(js.includes('federation: loadFederation'));
  assert.ok(js.includes('Idempotency-Key'));
  const reset = js.slice(js.indexOf('function resetState()'), js.indexOf('document.querySelectorAll(\'[data-tab]\')'));
  for (const secret of ['fab-node-secret', 'fab-inv-secret']) {
    assert.ok(reset.includes(`$('${secret}').textContent = ''`), `${secret} cleared`);
  }
  assert.ok(reset.includes('fabPreview = null'), 'pending preview cleared');
  assert.ok(reset.includes('fab-commit-box'), 'commit box hidden');
});

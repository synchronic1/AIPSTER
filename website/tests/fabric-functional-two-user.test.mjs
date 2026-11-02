/* Federation functional lane: two-identity isolated acceptance (step 2).
 * Synthetic identities (u_alice/u_bob) through the CURRENT REAL handlers
 * (sqlite shim, FEDERATION_ENABLED=1). Covers per-user fabrics,
 * invites/connections, grants/shared-resource visibility, routing
 * eligibility, quota, revocation and audit. No fixes assumed: any failure
 * below is a reproduced defect, not a test bug, until proven otherwise. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fabricEnv, connectPair, commitFlow, S, freshKey, readJson } from './qa-helpers.mjs';
import { budgetWindow } from '../src/lib/quotas.js';

const post = async (t, path, user, body = {}) =>
  readJson(await t.call(path, { method: 'POST', headers: S(t, user, { 'Idempotency-Key': freshKey() }), body }));
const get = async (t, path, user) => readJson(await t.call(path, { headers: S(t, user) }));

test('two-user: per-user fabrics are isolated, connection is shared', async c => {
  const t = await fabricEnv(); c.after(() => t.sqlite.close());
  const { nodeA, nodeB, conn } = await connectPair(t);

  const aNodes = await get(t, '/v1/fabric/nodes', t.alice);
  const bNodes = await get(t, '/v1/fabric/nodes', t.bob);
  assert.deepEqual(aNodes.json.items.map(n => n.id), [nodeA.id]);
  assert.deepEqual(bNodes.json.items.map(n => n.id), [nodeB.id]);
  // Connection peers see a redacted view (no secret material); strangers see nothing.
  const peerView = await get(t, `/v1/fabric/nodes/${nodeA.id}`, t.bob);
  assert.equal(peerView.status, 200);
  assert.equal(peerView.json.mine, false);
  assert.ok(!('node_secret_verifier' in peerView.json) && !('node_secret_salt' in peerView.json), 'peer view leaks no node secrets');
  assert.equal((await get(t, `/v1/fabric/nodes/${nodeA.id}`, t.demo)).status, 404);
  assert.equal((await get(t, `/v1/fabric/nodes/${nodeB.id}`, t.demo)).status, 404);

  const bIncoming = await readJson(await t.call('/v1/fabric/invitations?role=received', { headers: S(t, t.bob) }));
  assert.ok(bIncoming.json.items.length >= 1, 'bob sees the incoming invitation');

  const aConns = await get(t, '/v1/fabric/connections', t.alice);
  const bConns = await get(t, '/v1/fabric/connections', t.bob);
  assert.ok(aConns.json.items.some(x => x.id === conn.id), 'alice sees the connection');
  assert.ok(bConns.json.items.some(x => x.id === conn.id), 'bob sees the connection');
  assert.equal((await get(t, `/v1/fabric/connections/${conn.id}`, t.demo)).status, 404);
});

test('two-user: grant visibility, discovery and routing eligibility', async c => {
  const t = await fabricEnv(); c.after(() => t.sqlite.close());
  const { nodeB, conn } = await connectPair(t);
  const { grant } = await commitFlow(t, conn.id);

  const bIn = await readJson(await t.call('/v1/fabric/grants?scope=incoming', { headers: S(t, t.bob) }));
  const aOut = await readJson(await t.call('/v1/fabric/grants?scope=outgoing', { headers: S(t, t.alice) }));
  assert.ok(bIn.json.items.some(g => g.id === grant.id), 'bob sees the incoming grant');
  assert.ok(aOut.json.items.some(g => g.id === grant.id), 'alice sees the outgoing grant');
  assert.equal((await get(t, `/v1/fabric/grants/${grant.id}`, t.demo)).status, 404);

  const disc = await get(t, '/v1/fabric/discovery', t.bob);
  const shared = disc.json.items.find(i => i.id === 'r_gpu1');
  assert.ok(shared, 'bob discovers the shared resource');
  assert.equal(shared.via, 'grant');

  const allow = await post(t, '/v1/fabric/authorization/preview', t.bob,
    { nodeId: nodeB.id, resourceId: 'r_gpu1', incarnation: 'gen1', action: 'infer', model: 'llama', consumer: 'bob-op', maxTokens: 100 });
  assert.equal(allow.json.decision, 'allow');
  const wrongConsumer = await post(t, '/v1/fabric/authorization/preview', t.bob,
    { nodeId: nodeB.id, resourceId: 'r_gpu1', incarnation: 'gen1', action: 'infer', model: 'llama', consumer: 'mallory-op', maxTokens: 100 });
  assert.equal(wrongConsumer.json.decision, 'deny');
});

test('two-user: per-owner write quota caps federation mutations', async c => {
  const t = await fabricEnv(); c.after(() => t.sqlite.close());
  t.sqlite.prepare('INSERT INTO write_budget VALUES (?,?,119)').run('u_alice', budgetWindow());
  const ok = await post(t, '/v1/fabric/nodes', t.alice, { label: 'last-free' });
  assert.equal(ok.status, 201);
  const over = await post(t, '/v1/fabric/nodes', t.alice, { label: 'over-budget' });
  assert.equal(over.status, 429);
  const bobOk = await post(t, '/v1/fabric/nodes', t.bob, { label: 'bob-unaffected' });
  assert.equal(bobOk.status, 201, 'quota is per-owner: bob is unaffected');
});

test('two-user: revocation ends eligibility and mutations leave audit rows', async c => {
  const t = await fabricEnv(); c.after(() => t.sqlite.close());
  const { nodeB, conn } = await connectPair(t);
  const { grant } = await commitFlow(t, conn.id);

  const revoke = await post(t, `/v1/fabric/grants/${grant.id}/revoke`, t.alice, { expectedVersion: grant.version });
  assert.equal(revoke.status, 200, JSON.stringify(revoke.json));
  const after = await post(t, '/v1/fabric/authorization/preview', t.bob,
    { nodeId: nodeB.id, resourceId: 'r_gpu1', incarnation: 'gen1', action: 'infer', model: 'llama', consumer: 'bob-op', maxTokens: 100 });
  assert.equal(after.json.decision, 'deny', 'revocation ends routing eligibility');
  const disc = await get(t, '/v1/fabric/discovery', t.bob);
  assert.ok(!disc.json.items.some(i => i.id === 'r_gpu1' && i.via === 'grant'), 'revoked resource drops from discovery');

  const rows = t.sqlite.prepare("SELECT actor_kind, method, path FROM fabric_operation_admissions WHERE owner_id='u_alice'").all();
  const paths = rows.map(r => `${r.method} ${r.path}`);
  for (const p of ['POST /v1/fabric/nodes', 'POST /v1/fabric/invitations', 'POST /v1/fabric/previews', 'POST /v1/fabric/approvals', 'POST /v1/fabric/grants']) {
    assert.ok(paths.includes(p), `audit row present for ${p}`);
  }
  assert.ok(rows.every(r => r.actor_kind === 'session'), 'audit rows carry the actor kind');
});

test('two-user: cross-user writes fail and suspend gates enforcement', async c => {
  const t = await fabricEnv(); c.after(() => t.sqlite.close());
  const { nodeB, conn } = await connectPair(t);
  const { grant } = await commitFlow(t, conn.id);

  const bobRevoke = await post(t, `/v1/fabric/grants/${grant.id}/revoke`, t.bob, { expectedVersion: grant.version });
  assert.ok(bobRevoke.status === 403 || bobRevoke.status === 404, `bob cannot revoke alice's grant (got ${bobRevoke.status})`);

  const bobPreview = await post(t, '/v1/fabric/previews', t.bob,
    { connectionId: conn.id, resourceIds: ['r_gpu1'], consumers: ['bob-op'], models: ['llama'], maxTokens: 100, maxRequests: 10 });
  assert.ok(bobPreview.status >= 400, `bob cannot preview alice's resource (got ${bobPreview.status})`);

  const connNow = await get(t, `/v1/fabric/connections/${conn.id}`, t.alice);
  const susp = await post(t, `/v1/fabric/connections/${conn.id}/suspend`, t.alice, { expectedVersion: connNow.json.version });
  assert.equal(susp.status, 200, JSON.stringify(susp.json));
  const gated = await post(t, '/v1/fabric/authorization/preview', t.bob,
    { nodeId: nodeB.id, resourceId: 'r_gpu1', incarnation: 'gen1', action: 'infer', model: 'llama', consumer: 'bob-op', maxTokens: 100 });
  assert.equal(gated.json.decision, 'deny', 'suspended connection gates enforcement');
});

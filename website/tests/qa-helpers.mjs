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


export { fabricEnv, connectPair, commitFlow, S, K, freshKey, readJson };


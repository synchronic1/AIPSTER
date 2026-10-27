/* Built with Meta Muse. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { disableUserStatements } from '../scripts/lib/operator-sql.mjs';

const DEMO_PASSWORD = 'demo-test-password-01';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function seedDemo(t) {
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, username, displayUsername, demo, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('u_demo', 'Demo explorer', 'demo@aipster.invalid', 0, null, 'demo', 'demo', 1, now, now).run();
  await t.DB.prepare('INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('acc_demo_credential', 'u_demo', 'credential', 'u_demo', await hashPassword(DEMO_PASSWORD), now, now).run();
  const res = await t.call('/api/auth/sign-in/username', { method: 'POST', body: { username: 'demo', password: DEMO_PASSWORD } });
  assert.equal(res.status, 200);
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return { Cookie: setCookies.find((c) => c && c.startsWith('better-auth.session_token=')).split(';')[0] };
}

async function registerAs(t, user, name) {
  const out = await readJson(await t.call('/api/inventory', { method: 'POST', headers: { ...t.as(user), ...t.csrf }, body: { name } }));
  assert.equal(out.status, 201);
  return out.json;
}

// Finding 1 (write side): a real owner cannot grant to the demo tenant.
test('real-to-demo grant creation is rejected at the boundary', async () => {
  const t = await createTestEnv();
  await seedDemo(t);
  const r = await registerAs(t, t.alice, 'owner canary');
  const g = await readJson(await t.call('/api/grants', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { resourceId: r.id, grantee: 'demo@aipster.invalid', maxJobs: 5, maxTokens: 500 } }));
  assert.equal(g.status, 403);
  assert.equal(g.json.code, 'DEMO_RESTRICTED');
  const rows = await t.DB.prepare('SELECT id FROM grants').all();
  assert.equal(rows.results.length, 0, 'no cross-boundary row may be created');
});

// Finding 1 (read side): legacy/stale cross-boundary rows authorize nothing,
// in both directions, for sessions and keys.
test('non-string resourceId is a 400, never a 500', async () => {
  const t = await createTestEnv();
  const bad = await readJson(await t.call('/api/grants', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { resourceId: { value: 'r_x' }, grantee: 'bob@example.com', maxJobs: 5, maxTokens: 500 } }));
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'BAD_RESOURCE');
});

// Finding 1 (read side): legacy/stale cross-boundary rows authorize nothing,
// in both directions, for sessions and keys.
test('legacy real-to-demo grants authorize no reads', async () => {
  const t = await createTestEnv();
  const cookie = await seedDemo(t);
  const r = await registerAs(t, t.alice, 'owner canary');
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO grants (id, resource_id, owner_id, grantee_id, max_jobs, max_tokens, used_jobs, used_tokens, inference_only, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, ?, NULL)')
    .bind('g_legacy', r.id, 'u_alice', 'u_demo', 5, 500, now).run();
  const detail = await readJson(await t.call('/api/inventory/' + r.id, { headers: cookie }));
  assert.equal(detail.status, 404);
  const shared = await readJson(await t.call('/api/shared-with-me', { headers: cookie }));
  assert.equal(shared.json.total, 0);
  const key = await readJson(await t.call('/api/keys', { method: 'POST', headers: { ...cookie, ...t.csrf }, body: { name: 'dk', scope: 'read' } }));
  assert.equal(key.status, 201);
  const viaKey = await readJson(await t.call('/api/inventory/' + r.id, { headers: { Authorization: 'Bearer ' + key.json.secret } }));
  assert.equal(viaKey.status, 404);
  const ownerList = await readJson(await t.call('/api/grants', { headers: t.as(t.alice) }));
  assert.equal(ownerList.json.total, 0, 'dead cross-boundary rows are not listed as active');
});

test('legacy demo-to-real grants authorize no reads', async () => {
  const t = await createTestEnv();
  await seedDemo(t);
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated, online, usable, heartbeat_at, limits_json, scope, verification_json, credits_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, NULL, ?, ?, ?, NULL, ?)')
    .bind('r_demo_x', 'u_demo', 'demo canary', 'local', 'demo-fixture', 'cpu', 'none', '[]', '{}', 'owner only', '{}', now).run();
  await t.DB.prepare('INSERT INTO grants (id, resource_id, owner_id, grantee_id, max_jobs, max_tokens, used_jobs, used_tokens, inference_only, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, ?, NULL)')
    .bind('g_legacy2', 'r_demo_x', 'u_demo', 'u_bob', 5, 500, now).run();
  const detail = await readJson(await t.call('/api/inventory/r_demo_x', { headers: t.as(t.bob) }));
  assert.equal(detail.status, 404);
  const shared = await readJson(await t.call('/api/shared-with-me', { headers: t.as(t.bob) }));
  assert.equal(shared.json.total, 0);
});

// Finding 2: the operator disable operation preserves demo classification,
// revokes sessions/keys, and blocks future sign-ins. The test executes the
// exact canonical statements, not a separately written flag update.
test('operator disable keeps demo immutable and revokes everything', async () => {
  const t = await createTestEnv();
  const cookie = await seedDemo(t);
  const csrf = { ...cookie, ...t.csrf };
  const key = await readJson(await t.call('/api/keys', { method: 'POST', headers: csrf, body: { name: 'pre-disable', scope: 'inference' } }));
  assert.equal(key.status, 201);
  assert.ok(key.json.secret.startsWith('aip_demo_'));

  const statements = disableUserStatements({ userId: 'u_demo', email: 'demo@aipster.invalid', deletePassword: true });
  assert.ok(!/"?demo"?\s*=/i.test(statements.join(';')), 'disable statements never assign the demo column');
  for (const s of statements) await t.DB.prepare(s).run();

  const identity = await t.DB.prepare('SELECT demo, disabled FROM "user" WHERE id = ?').bind('u_demo').first();
  assert.equal(Number(identity.demo), 1, 'demo classification immutable');
  assert.equal(Number(identity.disabled), 1);
  const sessions = await t.DB.prepare('SELECT id FROM session WHERE userId = ?').bind('u_demo').all();
  assert.equal(sessions.results.length, 0, 'sessions revoked');
  const keys = await t.DB.prepare('SELECT revoked_at FROM key_verifiers WHERE owner_id = ?').bind('u_demo').all();
  assert.ok(keys.results.length === 1 && keys.results[0].revoked_at, 'keys revoked');
  const cred = await t.DB.prepare("SELECT id FROM account WHERE providerId = 'credential' AND userId = ?").bind('u_demo').all();
  assert.equal(cred.results.length, 0, 'password credential removed');

  assert.equal((await readJson(await t.call('/api/inventory', { headers: cookie }))).status, 401, 'old session dead');
  assert.equal((await readJson(await t.call('/api/inventory', { headers: { Authorization: 'Bearer ' + key.json.secret } }))).status, 401, 'old key dead');
  const signin = await readJson(await t.call('/api/auth/sign-in/username', { method: 'POST', body: { username: 'demo', password: DEMO_PASSWORD } }));
  assert.equal(signin.status, 401, 'future sign-ins blocked');
});

// Finding 2 (docs): the unsafe "disable by demo=0" recipe must be gone.
test('unsafe demo=0 disable recipe is absent from scripts and docs', () => {
  for (const p of ['scripts/setup-demo.mjs', '../docs/cloudflare-integration-plan.md']) {
    const src = readFileSync(path.join(ROOT, p), 'utf8');
    assert.ok(!/SET\s+demo\s*=\s*0/i.test(src), `unsafe recipe in ${p}`);
  }
});

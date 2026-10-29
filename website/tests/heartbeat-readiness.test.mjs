// P2 regression (PR #27 review): readiness must require the 0013
// key_verifiers.resource_id column. Key creation always inserts that
// column, so a 0005-without-0013 database breaks every API-key scope;
// /api/health must report ready:false (which verify:live rejects)
// instead of a green check over a broken deployment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { applyMigrations, createTestEnv, readJson, sessionCookieHeader,
  TEST_SECRET, MIGRATION_FILES } from './d1-shim.mjs';

const PRE_0013 = MIGRATION_FILES.filter((n) => n !== '0013_heartbeat_binding.sql');

async function seedUser(t, email, name, id) {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  await t.DB.prepare('INSERT INTO allowlist (email, added_at) VALUES (?, ?)').bind(email, now).run();
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, name, email, 1, null, now, now).run();
  const token = randomBytes(32).toString('hex');
  await t.DB.prepare('INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('s_' + token.slice(0, 8), future, token, now, now, null, 'test', id).run();
  return { id, token };
}

test('readiness is false on a 0005-without-0013 database', async () => {
  const t = await createTestEnv({ skipMigrations: true });
  applyMigrations(t.sqlite, PRE_0013);
  const res = await readJson(await t.call('/api/health'));
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.ready, false);
  assert.equal(res.json.detail.schema, false);
});

test('readiness is true with 0013 applied', async () => {
  const t = await createTestEnv();
  const res = await readJson(await t.call('/api/health'));
  assert.equal(res.status, 200);
  assert.equal(res.json.ready, true);
  assert.equal(res.json.detail.schema, true);
});

test('key creation breaks without 0013 (blast radius the probe surfaces)', async () => {
  const t = await createTestEnv({ skipMigrations: true });
  applyMigrations(t.sqlite, PRE_0013);
  const user = await seedUser(t, 'alice@example.com', 'Alice', 'u_alice');
  const res = await readJson(await t.call('/api/keys', { method: 'POST',
    headers: { Cookie: sessionCookieHeader(user.token, TEST_SECRET), 'X-Aipster-CSRF': '1' },
    body: { name: 'read-key', scope: 'read' } }));
  assert.equal(res.status, 500, `unmigrated mint must fail, got ${res.status}: ${res.text}`);
  assert.equal(res.json.code, 'INTERNAL');
});

test('key creation succeeds with 0013 applied (control)', async () => {
  const t = await createTestEnv();
  const res = await readJson(await t.call('/api/keys', { method: 'POST',
    headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'read-key', scope: 'read' } }));
  assert.equal(res.status, 201, res.text);
});

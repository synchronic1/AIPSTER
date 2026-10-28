/* Built with Meta Muse. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from 'better-auth/crypto';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { createAuth, stripProviderTokens } from '../src/lib/auth.js';

async function seedCredential(t, userId, username, password) {
  const now = new Date().toISOString();
  await t.DB.prepare('UPDATE "user" SET username = ?, displayUsername = ? WHERE id = ?').bind(username, username, userId).run();
  await t.DB.prepare('INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('acc_' + userId, userId, 'credential', userId, await hashPassword(password), now, now).run();
}

test('provider tokens are stripped before persistence, passwords kept', async () => {
  const t = await createTestEnv();
  const auth = createAuth(t.env);
  const oauth = { providerId: 'github', accountId: '123', userId: 'u_x', accessToken: 'AT', refreshToken: 'RT', idToken: 'ID', accessTokenExpiresAt: 'e1', refreshTokenExpiresAt: 'e2', scope: 'read:user' };
  for (const hook of [auth.options.databaseHooks.account.create.before, auth.options.databaseHooks.account.update.before]) {
    const out = await hook({ ...oauth });
    for (const f of ['accessToken', 'refreshToken', 'idToken', 'accessTokenExpiresAt', 'refreshTokenExpiresAt']) {
      assert.equal(out.data[f], null, f);
    }
    assert.equal(out.data.scope, 'read:user');
  }
  const cred = stripProviderTokens({ providerId: 'credential', password: 'scrypt-hash', accessToken: 'AT' });
  assert.equal(cred.password, 'scrypt-hash', 'credential password untouched');
  assert.equal(cred.accessToken, null);
});

test('disabled account: existing session and keys authorize nothing', async () => {
  const t = await createTestEnv();
  const key = await readJson(await t.call('/api/keys', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'k', scope: 'read' } }));
  assert.equal(key.status, 201);
  await t.DB.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').bind(t.alice.id).run();
  const viaSession = await readJson(await t.call('/api/inventory', { headers: t.as(t.alice) }));
  assert.equal(viaSession.status, 401);
  const viaKey = await readJson(await t.call('/api/inventory', { headers: { Authorization: 'Bearer ' + key.json.secret } }));
  assert.equal(viaKey.status, 401);
  const bob = await readJson(await t.call('/api/inventory', { headers: t.as(t.bob) }));
  assert.equal(bob.status, 200, 'other tenants unaffected');
});

test('disabled account: new sessions are refused at creation', async () => {
  const t = await createTestEnv();
  await seedCredential(t, t.alice.id, 'alicecred', 'alice-cred-password-01');
  const auth = createAuth(t.env);
  const hook = auth.options.databaseHooks.session.create.before;
  assert.ok((await hook({ userId: t.alice.id })).data, 'enabled user mints sessions');
  await t.DB.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').bind(t.alice.id).run();
  const err = await hook({ userId: t.alice.id }).then(() => null, (e) => e);
  assert.ok(err, 'disabled user rejected');
  assert.equal(err.body && err.body.code, 'ACCOUNT_DISABLED');
  const signin = await readJson(await t.call('/api/auth/sign-in/username', { method: 'POST', body: { username: 'alicecred', password: 'alice-cred-password-01' } }));
  assert.equal(signin.status, 403);
  assert.equal(signin.json.code, 'ACCOUNT_DISABLED');
});

test('health reports readiness only with the full schema, no secret metrics', async () => {
  const bare = await createTestEnv({ skipMigrations: true });
  const unready = await readJson(await bare.call('/api/health'));
  assert.equal(unready.json.ready, false);
  assert.equal(unready.json.detail.schema, false);
  assert.equal(unready.json.auth_configured, true, 'secret+url present, schema missing');
  assert.ok(!('secretLen' in unready.json.detail), 'no secret-length diagnostic');
  const t = await createTestEnv();
  const ready = await readJson(await t.call('/api/health'));
  assert.equal(ready.json.ready, true);
  assert.equal(ready.json.detail.schema, true);
  assert.ok(!('secretLen' in ready.json.detail));
});

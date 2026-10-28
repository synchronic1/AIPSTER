/* Built with Meta Muse. Per-user write quotas (Codex security review on
 * public registration): hourly write budget, per-object caps, throttled
 * key last-used writes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from 'better-auth/crypto';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { budgetWindow, WRITE_BUDGET_PER_HOUR, MAX_RESOURCES_PER_USER, MAX_KEYS_PER_USER, MAX_GRANTS_PER_USER } from '../src/lib/quotas.js';

const patchName = (t, user, name) => t.call('/api/settings', {
  method: 'PATCH', headers: { ...t.as(user), ...t.csrf }, body: { displayName: name }
});

test('hourly write budget allows 120 writes, rejects the 121st', async () => {
  const t = await createTestEnv();
  for (let i = 0; i < WRITE_BUDGET_PER_HOUR; i++) {
    const out = await readJson(await patchName(t, t.alice, 'Alice ' + i));
    assert.equal(out.status, 200, `write ${i}: ${out.text}`);
  }
  const over = await readJson(await patchName(t, t.alice, 'Alice over'));
  assert.equal(over.status, 429);
  assert.equal(over.json.code, 'WRITE_RATE_LIMITED');
});

test('write budget is per user and stale windows are ignored', async () => {
  const t = await createTestEnv();
  for (let i = 0; i < WRITE_BUDGET_PER_HOUR; i++) await patchName(t, t.alice, 'A' + i);
  assert.equal((await readJson(await patchName(t, t.alice, 'A!'))).status, 429);
  const bob = await readJson(await patchName(t, t.bob, 'Bob fresh'));
  assert.equal(bob.status, 200, 'bob has his own budget');
  // A saturated *old* bucket does not affect the current one.
  const stale = budgetWindow(new Date(Date.now() - 3 * 3600 * 1000));
  await t.DB.prepare('INSERT INTO write_budget (user_id, window, count) VALUES (?, ?, ?)').bind(t.bob.id, stale, 99999).run();
  const again = await readJson(await patchName(t, t.bob, 'Bob again'));
  assert.equal(again.status, 200, again.text);
});

test('resource cap rejects the 101st resource', async () => {
  const t = await createTestEnv();
  const now = new Date().toISOString();
  for (let i = 0; i < MAX_RESOURCES_PER_USER; i++) {
    await t.DB.prepare(`INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated, online, usable, heartbeat_at, limits_json, scope, verification_json, credits_json, created_at)
      VALUES (?, ?, ?, 'local', 'seed', 'x', 'y', '[]', 1, 0, 0, 0, NULL, '{}', 'owner only', '{}', NULL, ?)`)
      .bind('r_seed_' + i, t.alice.id, 'seed-' + i, now).run();
  }
  const out = await readJson(await t.call('/api/inventory', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'one-too-many' } }));
  assert.equal(out.status, 409);
  assert.equal(out.json.code, 'RESOURCE_LIMIT');
  const n = await t.DB.prepare('SELECT COUNT(*) AS n FROM resources WHERE owner_id = ?').bind(t.alice.id).first();
  assert.equal(n.n, MAX_RESOURCES_PER_USER, 'rejected insert adds no row');
});

test('key cap counts active keys; revoking frees a slot', async () => {
  const t = await createTestEnv();
  const now = new Date().toISOString();
  for (let i = 0; i < MAX_KEYS_PER_USER; i++) {
    await t.DB.prepare('INSERT INTO key_verifiers (id, owner_id, name, scope, salt, verifier, prefix, expires_at, metadata, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)')
      .bind('k_seed_' + i, t.alice.id, 'seed-' + i, 'read', 's', 'v', 'aip_live_k_seed', null, '', now).run();
  }
  const mk = () => t.call('/api/keys', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'extra', scope: 'read' } });
  assert.equal((await readJson(await mk())).json.code, 'KEY_LIMIT');
  const kn = await t.DB.prepare('SELECT COUNT(*) AS n FROM key_verifiers WHERE owner_id = ?').bind(t.alice.id).first();
  assert.equal(kn.n, MAX_KEYS_PER_USER, 'rejected insert adds no row');
  const rev = await readJson(await t.call('/api/keys/k_seed_0', { method: 'DELETE', headers: { ...t.as(t.alice), ...t.csrf } }));
  assert.equal(rev.status, 200);
  const ok = await readJson(await mk());
  assert.equal(ok.status, 201, ok.text);
});

test('grant cap counts active outgoing grants', async () => {
  const t = await createTestEnv();
  const now = new Date().toISOString();
  for (let i = 0; i <= MAX_GRANTS_PER_USER; i++) {
    await t.DB.prepare(`INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated, online, usable, heartbeat_at, limits_json, scope, verification_json, credits_json, created_at)
      VALUES (?, ?, ?, 'local', 'seed', 'x', 'y', '[]', 1, 0, 0, 0, NULL, '{}', 'owner only', '{}', NULL, ?)`)
      .bind('r_cap_' + i, t.alice.id, 'cap-box-' + i, now).run();
    if (i < MAX_GRANTS_PER_USER) {
      await t.DB.prepare('INSERT INTO grants (id, resource_id, owner_id, grantee_id, max_jobs, max_tokens, used_jobs, used_tokens, inference_only, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, ?, NULL)')
        .bind('g_seed_' + i, 'r_cap_' + i, t.alice.id, t.bob.id, 50, 50000, now).run();
    }
  }
  const out = await readJson(await t.call('/api/grants', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { resourceId: 'r_cap_' + MAX_GRANTS_PER_USER, grantee: 'bob@example.com', maxJobs: 50, maxTokens: 50000 } }));
  assert.equal(out.status, 409);
  assert.equal(out.json.code, 'GRANT_LIMIT');
  const gn = await t.DB.prepare('SELECT COUNT(*) AS n FROM grants WHERE owner_id = ?').bind(t.alice.id).first();
  assert.equal(gn.n, MAX_GRANTS_PER_USER, 'rejected insert adds no row');
});

test('key last-used writes at most once per hour', async () => {
  const t = await createTestEnv();
  const mk = await readJson(await t.call('/api/keys', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'metered', scope: 'read' } }));
  const auth = { Authorization: 'Bearer ' + mk.json.secret };
  assert.equal((await readJson(await t.call('/api/inventory', { headers: auth }))).status, 200);
  const t1 = (await t.DB.prepare('SELECT last_used_at FROM key_verifiers WHERE id = ?').bind(mk.json.id).first()).last_used_at;
  assert.ok(t1, 'first use stamps last_used_at');
  assert.equal((await readJson(await t.call('/api/inventory', { headers: auth }))).status, 200);
  const t2 = (await t.DB.prepare('SELECT last_used_at FROM key_verifiers WHERE id = ?').bind(mk.json.id).first()).last_used_at;
  assert.equal(t2, t1, 'second use within the hour skips the write');
  await t.DB.prepare('UPDATE key_verifiers SET last_used_at = ? WHERE id = ?').bind('2000-01-01T00:00:00.000Z', mk.json.id).run();
  assert.equal((await readJson(await t.call('/api/inventory', { headers: auth }))).status, 200);
  const t3 = (await t.DB.prepare('SELECT last_used_at FROM key_verifiers WHERE id = ?').bind(mk.json.id).first()).last_used_at;
  assert.ok(Date.parse(t3) > Date.parse('2000-01-01T00:00:00.000Z'), 'stale stamp refreshes');
});

test('exhausted users can still revoke keys and grants', async () => {
  const t = await createTestEnv();
  const as = { ...t.as(t.alice), ...t.csrf };
  const key = await readJson(await t.call('/api/keys', { method: 'POST', headers: as, body: { name: 'leaked?', scope: 'read' } }));
  const res = await readJson(await t.call('/api/inventory', { method: 'POST', headers: as, body: { name: 'shared-box' } }));
  const grant = await readJson(await t.call('/api/grants', { method: 'POST', headers: as, body: { resourceId: res.json.id, grantee: 'bob@example.com', maxJobs: 50, maxTokens: 50000 } }));
  assert.equal(grant.status, 201, grant.text);
  for (let i = 3; i < WRITE_BUDGET_PER_HOUR; i++) await patchName(t, t.alice, 'F' + i);
  assert.equal((await readJson(await patchName(t, t.alice, 'F!'))).json.code, 'WRITE_RATE_LIMITED');
  const rk = await readJson(await t.call('/api/keys/' + key.json.id, { method: 'DELETE', headers: as }));
  assert.equal(rk.status, 200, 'leaked key revokes despite spent budget');
  const rg = await readJson(await t.call('/api/grants/' + grant.json.id, { method: 'DELETE', headers: as }));
  assert.equal(rg.status, 200, 'grant revokes despite spent budget');
  const used = await readJson(await t.call('/api/inventory', { headers: { Authorization: 'Bearer ' + key.json.secret } }));
  assert.equal(used.status, 401, 'revoked key is dead');
});

test('repeat revocation is a no-op without a second audit row', async () => {
  const t = await createTestEnv();
  const as = { ...t.as(t.alice), ...t.csrf };
  const key = await readJson(await t.call('/api/keys', { method: 'POST', headers: as, body: { name: 'x', scope: 'read' } }));
  assert.equal((await readJson(await t.call('/api/keys/' + key.json.id, { method: 'DELETE', headers: as }))).status, 200);
  assert.equal((await readJson(await t.call('/api/keys/' + key.json.id, { method: 'DELETE', headers: as }))).status, 200);
  const audits = await t.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'key.revoke' AND target = ?").bind(key.json.id).first();
  assert.equal(audits.n, 1, 'one audit row for any number of repeats');
});

test('rejected over-budget requests perform no D1 write', async () => {
  const t = await createTestEnv();
  for (let i = 0; i < WRITE_BUDGET_PER_HOUR; i++) await patchName(t, t.alice, 'W' + i);
  const window = budgetWindow();
  const before = (await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind(t.alice.id, window).first()).count;
  assert.equal(before, WRITE_BUDGET_PER_HOUR);
  for (let i = 0; i < 5; i++) assert.equal((await readJson(await patchName(t, t.alice, 'W!'))).status, 429);
  const after = (await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind(t.alice.id, window).first()).count;
  assert.equal(after, WRITE_BUDGET_PER_HOUR, 'counter untouched by rejections');
});

test('atomic budget: exactly 120 of 200 rapid claims succeed, counter exact', async () => {
  // node:sqlite serializes in-process callers, so this cannot exhibit a
  // true race; it pins the exact accounting the atomic UPDATE guarantees
  // under serialization (200 parallel claims admit exactly 120 on D1).
  const t = await createTestEnv();
  let admitted = 0, rejected = 0;
  await Promise.all(Array.from({ length: 200 }, async (_, i) => {
    const out = await readJson(await patchName(t, t.alice, 'R' + i));
    if (out.status === 200) admitted++; else if (out.status === 429) rejected++;
    else assert.fail('unexpected status ' + out.status);
  }));
  assert.equal(admitted, WRITE_BUDGET_PER_HOUR);
  assert.equal(rejected, 200 - WRITE_BUDGET_PER_HOUR);
  const row = await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind(t.alice.id, budgetWindow()).first();
  assert.equal(row.count, WRITE_BUDGET_PER_HOUR, 'counter matches admissions exactly');
});

// PR11 independent-review block: authenticated Better Auth profile writes
// must honor the same budget (update-user returned 200 + mutated rows at
// a spent budget). Exhaustion is seeded by direct SQL, matching the
// independent repro; the property asserted is rejection with zero
// mutation and zero accounting drift.
async function exhaustBudget(t, user) {
  await t.DB.prepare('INSERT INTO write_budget (user_id, window, count) VALUES (?, ?, ?)').bind(user.id, budgetWindow(), WRITE_BUDGET_PER_HOUR).run();
}
async function budgetCount(t, user) {
  const r = await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind(user.id, budgetWindow()).first();
  return r ? Number(r.count) : 0;
}

test('auth bypass closed: update-user is denied with zero mutation at exhaustion', async () => {
  const t = await createTestEnv();
  await exhaustBudget(t, t.alice);
  assert.equal((await readJson(await patchName(t, t.alice, 'X'))).json.code, 'WRITE_RATE_LIMITED');
  const upd = await readJson(await t.call('/api/auth/update-user', { method: 'POST', headers: { ...t.as(t.alice), Origin: 'http://localhost:8787' }, body: { name: 'Bypassed' } }));
  assert.equal(upd.status, 429);
  assert.equal(upd.json.code, 'WRITE_RATE_LIMITED');
  const u = await t.DB.prepare('SELECT name FROM "user" WHERE id = ?').bind(t.alice.id).first();
  assert.equal(u.name, 'Alice', 'profile unchanged');
  assert.equal(await budgetCount(t, t.alice), WRITE_BUDGET_PER_HOUR, 'no accounting drift');
});

test('update-user consumes one budget claim when allowed', async () => {
  const t = await createTestEnv();
  const upd = await readJson(await t.call('/api/auth/update-user', { method: 'POST', headers: { ...t.as(t.alice), Origin: 'http://localhost:8787' }, body: { name: 'Alice New' } }));
  assert.equal(upd.status, 200, upd.text);
  const u = await t.DB.prepare('SELECT name FROM "user" WHERE id = ?').bind(t.alice.id).first();
  assert.equal(u.name, 'Alice New');
  assert.equal(await budgetCount(t, t.alice), 1);
});

test('change-password is budgeted; new credential works', async () => {
  const t = await createTestEnv();
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)').bind('acc_alice', t.alice.id, 'credential', t.alice.id, await hashPassword('old-password-01'), now, now).run();
  const ch = await readJson(await t.call('/api/auth/change-password', { method: 'POST', headers: { ...t.as(t.alice), Origin: 'http://localhost:8787' }, body: { currentPassword: 'old-password-01', newPassword: 'new-password-02' } }));
  assert.equal(ch.status, 200, ch.text);
  assert.equal(await budgetCount(t, t.alice), 1);
  const login = await readJson(await t.call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'alice@example.com', password: 'new-password-02' } }));
  assert.equal(login.status, 200, 'new password authenticates');
  await exhaustBudget(t, t.bob);
  const denied = await readJson(await t.call('/api/auth/change-password', { method: 'POST', headers: { ...t.as(t.bob), Origin: 'http://localhost:8787' }, body: { currentPassword: 'x', newPassword: 'y-abcdefgh' } }));
  assert.equal(denied.status, 429);
  assert.equal(await budgetCount(t, t.bob), WRITE_BUDGET_PER_HOUR);
});

test('change-email, link-social, update-session, delete-user honor exhaustion', async () => {
  const t = await createTestEnv();
  await exhaustBudget(t, t.alice);
  const as = { ...t.as(t.alice), Origin: 'http://localhost:8787' };
  for (const [p, body] of [
    ['/api/auth/change-email', { newEmail: 'new@example.com' }],
    ['/api/auth/link-social', { provider: 'github', callbackURL: 'http://localhost:8787/app/' }],
    ['/api/auth/update-session', { foo: 'bar' }],
    ['/api/auth/delete-user', { callbackURL: 'http://localhost:8787/' }],
  ]) {
    const out = await readJson(await t.call(p, { method: 'POST', headers: as, body }));
    assert.equal(out.status, 429, p + ': ' + out.text);
    assert.equal(out.json.code, 'WRITE_RATE_LIMITED');
  }
  assert.equal(await budgetCount(t, t.alice), WRITE_BUDGET_PER_HOUR);
  const u = await t.DB.prepare('SELECT name, email FROM "user" WHERE id = ?').bind(t.alice.id).first();
  assert.deepEqual([u.name, u.email], ['Alice', 'alice@example.com'], 'no profile drift');
  const link = await readJson(await t.call('/api/auth/link-social', { method: 'POST', headers: { ...t.as(t.bob), Origin: 'http://localhost:8787' }, body: { provider: 'github', callbackURL: 'http://localhost:8787/app/' } }));
  assert.equal(link.status, 200, 'link initiation works when budgeted');
  assert.ok(String(link.json.url || link.json.redirect).includes('github.com'), 'provider URL returned');
});

test('logout, revocation, unlink, and reads stay available at exhaustion', async () => {
  const t = await createTestEnv();
  await exhaustBudget(t, t.alice);
  const as = { ...t.as(t.alice), Origin: 'http://localhost:8787' };
  const session = await readJson(await t.call('/api/auth/get-session', { headers: as }));
  assert.equal(session.status, 200, 'session reads unaffected');
  const rev = await readJson(await t.call('/api/auth/revoke-other-sessions', { method: 'POST', headers: as, body: {} }));
  assert.equal(rev.status, 200, 'revocation available: ' + rev.text);
  const unl = await readJson(await t.call('/api/auth/unlink-account', { method: 'POST', headers: as, body: { providerId: 'github' } }));
  assert.notEqual(unl.status, 429, 'unlink never budget-blocked: ' + unl.text);
  assert.equal(await budgetCount(t, t.alice), WRITE_BUDGET_PER_HOUR, 'termination paths bill nothing');
  const bye = await readJson(await t.call('/api/auth/sign-out', { method: 'POST', headers: as, body: {} }));
  assert.equal(bye.status, 200, 'logout available: ' + bye.text);
  const after = await readJson(await t.call('/api/auth/get-session', { headers: as }));
  assert.ok(after.json === null || after.status === 401, 'session ended');
});

test('auth budget ignores wrong-method and cross-origin requests', async () => {
  const t = await createTestEnv();
  const as = { ...t.as(t.alice), Origin: 'http://localhost:8787' };
  const get = await readJson(await t.call('/api/auth/update-user', { headers: as }));
  assert.notEqual(get.status, 429, 'bare GET never billed: ' + get.status);
  assert.equal(await budgetCount(t, t.alice), 0);
  for (const forged of [{ Origin: 'https://evil.example' }, { Referer: 'https://evil.example/x' }]) {
    const out = await readJson(await t.call('/api/auth/update-user', { method: 'POST', headers: { ...t.as(t.alice), ...forged }, body: { name: 'Forged' } }));
    assert.equal(out.status, 403, 'cross-site POST rejected: ' + out.text);
  }
  assert.equal(await budgetCount(t, t.alice), 0, 'rejected forgeries bill nothing');
  const u = await t.DB.prepare('SELECT name FROM "user" WHERE id = ?').bind(t.alice.id).first();
  assert.equal(u.name, 'Alice');
});

test('delete-user/callback bills only token-bearing GETs', async () => {
  const t = await createTestEnv();
  const as = { ...t.as(t.alice), Origin: 'http://localhost:8787' };
  await readJson(await t.call('/api/auth/delete-user/callback', { headers: as }));
  assert.equal(await budgetCount(t, t.alice), 0, 'tokenless GET unbilled');
  const tok = await readJson(await t.call('/api/auth/delete-user/callback?token=fake&callbackURL=http://localhost:8787/', { headers: as }));
  assert.ok(tok.status >= 400 && tok.status !== 429, 'flow rejects, budget claimed: ' + tok.status);
  assert.equal(await budgetCount(t, t.alice), 1);
  await exhaustBudget(t, t.bob);
  const denied = await readJson(await t.call('/api/auth/delete-user/callback?token=fake&callbackURL=http://localhost:8787/', { headers: { ...t.as(t.bob), Origin: 'http://localhost:8787' } }));
  assert.equal(denied.status, 429);
});


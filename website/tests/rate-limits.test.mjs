/* Built with Meta Muse. Per-user write quotas (Codex security review on
 * public registration): hourly write budget, per-object caps, throttled
 * key last-used writes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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


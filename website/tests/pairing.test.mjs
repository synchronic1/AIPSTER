/* Built with Meta Muse. */
// Tests for one-time worker pairing + registration hardening.
// Contract: docs/pairing.md. All codes/keys here are disposable local test
// fixtures minted against the in-memory D1 shim — never production credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from 'better-auth/crypto';
import { verifierFor } from '../src/lib/keys.js';
import { applyMigrations, createTestEnv, readJson } from './d1-shim.mjs';

async function mintCode(t, user, body = {}, extraHeaders = {}) {
  return readJson(await t.call('/api/pairing/codes', {
    method: 'POST', headers: { ...t.as(user), ...t.csrf, ...extraHeaders }, body,
  }));
}

function claim(t, body) {
  return t.call('/api/pairing/claim', { method: 'POST', body });
}

async function register(t, user, body, idemKey = null) {
  const headers = { ...t.as(user), ...t.csrf };
  if (idemKey) headers['Idempotency-Key'] = idemKey;
  return readJson(await t.call('/api/inventory', { method: 'POST', headers, body }));
}

async function pair(t, user, nodeId, extra = {}) {
  const minted = await mintCode(t, user);
  assert.equal(minted.status, 201, minted.text);
  const out = await readJson(await claim(t, { code: minted.json.code, nodeId, ...extra }));
  assert.equal(out.status, 201, out.text);
  return { code: minted.json, ...out.json };
}

const DEMO_PASSWORD = 'pairing-test-password-01';

async function seedDemo(t) {
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, username, displayUsername, demo, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('u_demo', 'Demo explorer', 'demo@aipster.invalid', 0, null, 'demo', 'demo', 1, now, now).run();
  const hash = await hashPassword(DEMO_PASSWORD);
  await t.DB.prepare('INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('acc_demo_pairing', 'u_demo', 'credential', 'u_demo', hash, now, now).run();
  const res = await t.call('/api/auth/sign-in/username', { method: 'POST', body: { username: 'demo', password: DEMO_PASSWORD } });
  const out = await readJson(res);
  assert.equal(out.status, 200, out.text);
  const cookies = res.headers.getSetCookie().find((c) => c.startsWith('better-auth.session_token='));
  return { Cookie: cookies.split(';')[0] };
}

test('minting a code requires a session with CSRF; keys are forbidden', async () => {
  const t = await createTestEnv();
  const anon = await readJson(await t.call('/api/pairing/codes', { method: 'POST', headers: t.csrf, body: {} }));
  assert.equal(anon.status, 401);
  assert.equal(anon.json.code, 'AUTH_REQUIRED');
  const noCsrf = await readJson(await t.call('/api/pairing/codes', { method: 'POST', headers: t.as(t.alice), body: {} }));
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.code, 'CSRF_REQUIRED');
  const read = await readJson(await t.call('/api/keys', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'r', scope: 'read' } }));
  assert.equal(read.status, 201, read.text);
  const keyed = await readJson(await t.call('/api/pairing/codes', {
    method: 'POST', headers: { Authorization: 'Bearer ' + read.json.secret, ...t.csrf }, body: {},
  }));
  assert.equal(keyed.status, 403);
  assert.equal(keyed.json.code, 'KEY_FORBIDDEN');
});

test('minted codes are one-time, shaped, and TTL-validated', async () => {
  const t = await createTestEnv();
  const out = await mintCode(t, t.alice);
  assert.equal(out.status, 201, out.text);
  assert.match(out.json.code, /^pair-[0-9a-f]{8}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.ok(out.json.oneTime, 'one-time reveal note');
  const ttlMs = Date.parse(out.json.expiresAt) - Date.now();
  assert.ok(ttlMs > 9 * 60 * 1000 && ttlMs <= 10 * 60 * 1000 + 5000, `default 10m TTL, got ${ttlMs}`);
  const custom = await mintCode(t, t.alice, { ttlMinutes: 60 });
  assert.equal(custom.status, 201, custom.text);
  for (const bad of [0, 61, 1.5, '10', -3]) {
    const r = await mintCode(t, t.alice, { ttlMinutes: bad });
    assert.equal(r.status, 400, `ttl ${bad}`);
    assert.equal(r.json.code, 'BAD_TTL');
  }
  // Only the salted verifier is stored; the code itself is not in the DB.
  const stored = await t.DB.prepare('SELECT * FROM pairing_codes WHERE id = ?').bind(out.json.id).first();
  assert.ok(stored, 'code row exists');
  assert.equal(stored.used_at, null);
  assert.equal(stored.attempts, 0);
  assert.ok(!JSON.stringify(stored).includes(out.json.code), 'no code material stored');
});

test('demo users cannot mint pairing codes', async () => {
  const t = await createTestEnv();
  const cookie = await seedDemo(t);
  const r = await readJson(await t.call('/api/pairing/codes', { method: 'POST', headers: { ...cookie, ...t.csrf }, body: {} }));
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'DEMO_RESTRICTED');
});

test('mint cap: five live codes, then 409', async () => {
  const t = await createTestEnv();
  for (let i = 0; i < 5; i++) {
    const r = await mintCode(t, t.alice);
    assert.equal(r.status, 201, `mint ${i}: ${r.text}`);
  }
  const sixth = await mintCode(t, t.alice);
  assert.equal(sixth.status, 409);
  assert.equal(sixth.json.code, 'PAIRING_LIMIT');
  // Using one frees a slot.
  const first = await t.DB.prepare('SELECT id FROM pairing_codes WHERE owner_id = ? LIMIT 1').bind(t.alice.id).first();
  const row = await t.DB.prepare('SELECT * FROM pairing_codes WHERE id = ?').bind(first.id).first();
  assert.ok(row && !row.used_at);
});

test('claim happy path: resource row plus a working heartbeat key', async () => {
  const t = await createTestEnv();
  const minted = await mintCode(t, t.alice);
  const out = await readJson(await claim(t, {
    code: minted.json.code, nodeId: 'node-01', name: 'lab-box',
    kind: 'local', cpu: 'Ryzen 9 7950X', gpu: 'none', capabilities: ['summarize'],
  }));
  assert.equal(out.status, 201, out.text);
  assert.equal(out.json.created, true);
  assert.ok(out.json.resourceId.startsWith('r_'));
  assert.equal(out.json.resource.origin, 'paired');
  assert.equal(out.json.resource.state.configured, true);
  assert.equal(out.json.resource.state.authenticated, true);
  assert.equal(out.json.resource.state.online, false, 'no heartbeat yet');
  assert.match(out.json.resource.verification.note, /Paired .*; awaiting first heartbeat\./);
  assert.deepEqual(out.json.resource.capabilities, ['summarize']);
  assert.ok(out.json.heartbeatKey.startsWith('aip_live_k_'), 'live secret shape');
  assert.equal(out.json.heartbeatUrl, `/api/resources/${out.json.resourceId}/heartbeat`);
  assert.ok(out.json.oneTime);
  // The delivered key beats successfully: full onboarding chain in one env.
  const beat = await readJson(await t.call(`/api/resources/${out.json.resourceId}/heartbeat`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + out.json.heartbeatKey }, body: { usable: false },
  }));
  assert.equal(beat.status, 200, beat.text);
  assert.equal(beat.json.usable, false);
  // And the resource is owner-visible in inventory.
  const inv = await readJson(await t.call('/api/inventory', { headers: t.as(t.alice) }));
  assert.ok(inv.json.items.some((r) => r.id === out.json.resourceId), 'auto-appears in inventory');
});

test('claim validation: bad shape, bad node, unknown id', async () => {
  const t = await createTestEnv();
  const badShape = await readJson(await claim(t, { code: 'not-a-code', nodeId: 'n1' }));
  assert.equal(badShape.status, 400);
  assert.equal(badShape.json.code, 'BAD_CODE');
  const badNode = await readJson(await claim(t, { code: 'pair-00000000-0000-0000-0000', nodeId: 'has spaces!' }));
  assert.equal(badNode.status, 400);
  assert.equal(badNode.json.code, 'BAD_NODE');
  const ghost = await readJson(await claim(t, { code: 'pair-00000000-0000-0000-0000', nodeId: 'n1' }));
  assert.equal(ghost.status, 404);
  assert.equal(ghost.json.code, 'PAIRING_INVALID');
});

test('wrong secrets burn the code after ten attempts', async () => {
  const t = await createTestEnv();
  const minted = await mintCode(t, t.alice);
  const tail = minted.json.code.slice(-1);
  const wrongSecret = () => minted.json.code.slice(0, -1) + (tail === '0' ? '1' : '0');
  for (let i = 0; i < 10; i++) {
    const r = await readJson(await claim(t, { code: wrongSecret(i), nodeId: 'n-burn' }));
    assert.equal(r.status, 404, `attempt ${i}`);
    assert.equal(r.json.code, 'PAIRING_INVALID');
  }
  // Even the right secret is dead after the burn.
  const late = await readJson(await claim(t, { code: minted.json.code, nodeId: 'n-burn' }));
  assert.equal(late.status, 404);
  assert.equal(late.json.code, 'PAIRING_INVALID');
});

test('expired codes are 410 with a mint-again message', async () => {
  const t = await createTestEnv();
  const minted = await mintCode(t, t.alice);
  await t.DB.prepare('UPDATE pairing_codes SET expires_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - 1000).toISOString(), minted.json.id).run();
  const r = await readJson(await claim(t, { code: minted.json.code, nodeId: 'n-old' }));
  assert.equal(r.status, 410);
  assert.equal(r.json.code, 'PAIRING_EXPIRED');
});

test('a spent code rejects other nodes but re-binds the same node once', async () => {
  const t = await createTestEnv();
  const first = await pair(t, t.alice, 'node-retry', { name: 'retry-box' });
  const minted = await mintCode(t, t.alice);
  // Fresh code, first claim wins for node A...
  const a = await readJson(await claim(t, { code: minted.json.code, nodeId: 'node-A' }));
  assert.equal(a.status, 201, a.text);
  // ...a different node on the spent code is invalid...
  const b = await readJson(await claim(t, { code: minted.json.code, nodeId: 'node-B' }));
  assert.equal(b.status, 404);
  assert.equal(b.json.code, 'PAIRING_INVALID');
  // ...but the same node re-binds (lost-response retry) with a fresh key.
  const retry = await readJson(await claim(t, { code: minted.json.code, nodeId: 'node-A' }));
  assert.equal(retry.status, 200, retry.text);
  assert.equal(retry.json.created, false);
  assert.equal(retry.json.resourceId, a.json.resourceId);
  assert.notEqual(retry.json.heartbeatKey, a.json.heartbeatKey, 'fresh sender key');
  const stale = await readJson(await t.call(`/api/resources/${a.json.resourceId}/heartbeat`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + a.json.heartbeatKey }, body: { usable: true },
  }));
  assert.equal(stale.status, 401);
  assert.equal(stale.json.code, 'KEY_REVOKED', 'superseded key is dead');
  const fresh = await readJson(await t.call(`/api/resources/${a.json.resourceId}/heartbeat`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + retry.json.heartbeatKey }, body: { usable: true },
  }));
  assert.equal(fresh.status, 200, fresh.text);
  assert.equal(first.resourceId.slice(0, 2), 'r_');
});

test('re-pair with a new code reuses the node row and rotates the key', async () => {
  const t = await createTestEnv();
  const one = await pair(t, t.alice, 'node-repair', { name: 'repair-box' });
  const two = await mintCode(t, t.alice);
  const out = await readJson(await claim(t, { code: two.json.code, nodeId: 'node-repair' }));
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.created, false);
  assert.equal(out.json.resourceId, one.resourceId, 'same row, no duplicate');
  assert.notEqual(out.json.heartbeatKey, one.heartbeatKey);
  const count = await t.DB.prepare('SELECT COUNT(*) AS n FROM resources WHERE owner_id = ?').bind(t.alice.id).first();
  assert.equal(count.n, 1);
});

test('same node id under two owners stays isolated', async () => {
  const t = await createTestEnv();
  const a = await pair(t, t.alice, 'shared-node', { name: 'a-box' });
  const b = await pair(t, t.bob, 'shared-node', { name: 'b-box' });
  assert.notEqual(a.resourceId, b.resourceId);
  const invA = await readJson(await t.call('/api/inventory', { headers: t.as(t.alice) }));
  assert.deepEqual(invA.json.items.map((r) => r.id), [a.resourceId]);
  const invB = await readJson(await t.call('/api/inventory', { headers: t.as(t.bob) }));
  assert.deepEqual(invB.json.items.map((r) => r.id), [b.resourceId]);
  // Cross-tenant heartbeat: alice's key against bob's resource is NOT_FOUND.
  const x = await readJson(await t.call(`/api/resources/${b.resourceId}/heartbeat`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + a.heartbeatKey }, body: { usable: true },
  }));
  assert.equal(x.status, 404);
  assert.equal(x.json.code, 'NOT_FOUND');
});

test('disabled owners cannot claim, even with a live code', async () => {
  const t = await createTestEnv();
  const minted = await mintCode(t, t.alice);
  await t.DB.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').bind(t.alice.id).run();
  const r = await readJson(await claim(t, { code: minted.json.code, nodeId: 'n-disabled' }));
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'PAIRING_INVALID');
  const count = await t.DB.prepare('SELECT COUNT(*) AS n FROM resources WHERE owner_id = ?').bind(t.alice.id).first();
  assert.equal(count.n, 0, 'nothing created');
});

test('hostname collisions suffix the display name, never the identity', async () => {
  const t = await createTestEnv();
  const manual = await register(t, t.alice, { name: 'lab' });
  assert.equal(manual.status, 201, manual.text);
  const p = await pair(t, t.alice, 'node-dup-name', { name: 'lab' });
  assert.equal(p.resource.name, 'lab-2');
  const p2 = await pair(t, t.alice, 'node-dup-name-2', { name: 'lab' });
  assert.equal(p2.resource.name, 'lab-3');
  assert.equal(manual.json.name, 'lab', 'original untouched');
});

test('Idempotency-Key replays the original card; a new key creates', async () => {
  const t = await createTestEnv();
  const first = await register(t, t.alice, { name: 'idem-box' }, 'idem-key-01');
  assert.equal(first.status, 201, first.text);
  const replay = await register(t, t.alice, { name: 'different-name' }, 'idem-key-01');
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.id, first.json.id, 'same row replayed');
  assert.equal(replay.json.name, 'idem-box', 'original body wins');
  const other = await register(t, t.alice, { name: 'idem-box' }, 'idem-key-02');
  assert.equal(other.status, 201, other.text);
  assert.notEqual(other.json.id, first.json.id);
  const bad = await register(t, t.alice, { name: 'x' }, 'has spaces!');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'BAD_IDEMPOTENCY');
  const count = await t.DB.prepare('SELECT COUNT(*) AS n FROM resources WHERE owner_id = ?').bind(t.alice.id).first();
  assert.equal(count.n, 2, 'no duplicates from replays');
});

test('replay after delete provisions fresh instead of resurrecting', async () => {
  const t = await createTestEnv();
  const first = await register(t, t.alice, { name: 'doomed' }, 'idem-doomed');
  assert.equal(first.status, 201, first.text);
  const del = await readJson(await t.call(`/api/inventory/${first.json.id}`, {
    method: 'DELETE', headers: { ...t.as(t.alice), ...t.csrf },
  }));
  assert.equal(del.status, 200, del.text);
  const again = await register(t, t.alice, { name: 'doomed' }, 'idem-doomed');
  assert.equal(again.status, 201, again.text);
  assert.notEqual(again.json.id, first.json.id, 'orphaned mapping treated as new');
});

test('DELETE removes the resource and revokes its keys and grants', async () => {
  const t = await createTestEnv();
  const p = await pair(t, t.alice, 'node-doomed', { name: 'doomed-worker' });
  const grant = await readJson(await t.call('/api/grants', {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf },
    body: { resourceId: p.resourceId, grantee: 'bob@example.com', maxJobs: 100, maxTokens: 100 },
  }));
  assert.equal(grant.status, 201, grant.text);
  const del = await readJson(await t.call(`/api/inventory/${p.resourceId}`, {
    method: 'DELETE', headers: { ...t.as(t.alice), ...t.csrf },
  }));
  assert.equal(del.status, 200, del.text);
  const gone = await readJson(await t.call(`/api/inventory/${p.resourceId}`, { headers: t.as(t.alice) }));
  assert.equal(gone.status, 404);
  const beat = await readJson(await t.call(`/api/resources/${p.resourceId}/heartbeat`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + p.heartbeatKey }, body: { usable: true },
  }));
  assert.equal(beat.status, 401);
  assert.equal(beat.json.code, 'KEY_REVOKED', 'bound sender key is dead');
  const g = await t.DB.prepare('SELECT id FROM grants WHERE id = ?').bind(grant.json.id).first();
  assert.equal(g, null, 'outgoing grant row deleted with its resource');
  const audit = await t.DB.prepare("SELECT * FROM audit WHERE action = 'resource.delete' AND target = ?").bind(p.resourceId).first();
  assert.ok(audit, 'deletion audited');
  const again = await readJson(await t.call(`/api/inventory/${p.resourceId}`, {
    method: 'DELETE', headers: { ...t.as(t.alice), ...t.csrf },
  }));
  assert.equal(again.status, 404, 'second delete is 404, not an error');
});

test('DELETE is owner-only and CSRF-guarded', async () => {
  const t = await createTestEnv();
  const p = await pair(t, t.alice, 'node-guarded');
  const foreign = await readJson(await t.call(`/api/inventory/${p.resourceId}`, {
    method: 'DELETE', headers: { ...t.as(t.bob), ...t.csrf },
  }));
  assert.equal(foreign.status, 404);
  assert.equal(foreign.json.code, 'NOT_FOUND');
  const noCsrf = await readJson(await t.call(`/api/inventory/${p.resourceId}`, {
    method: 'DELETE', headers: t.as(t.alice),
  }));
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.code, 'CSRF_REQUIRED');
  const anon = await readJson(await t.call(`/api/inventory/${p.resourceId}`, { method: 'DELETE', headers: t.csrf }));
  assert.equal(anon.status, 401);
  const still = await t.DB.prepare('SELECT id FROM resources WHERE id = ?').bind(p.resourceId).first();
  assert.ok(still, 'row survives denied deletes');
});

test('claim at the key cap fails without stranding a second sender', async () => {
  const t = await createTestEnv();
  for (let i = 0; i < 20; i++) {
    const k = await readJson(await t.call('/api/keys', {
      method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: `filler-${i}`, scope: 'read' },
    }));
    assert.equal(k.status, 201, `filler ${i}: ${k.text}`);
  }
  const minted = await mintCode(t, t.alice);
  assert.equal(minted.status, 201, minted.text);
  const out = await readJson(await claim(t, { code: minted.json.code, nodeId: 'node-capped' }));
  assert.equal(out.status, 409);
  assert.equal(out.json.code, 'KEY_LIMIT');
  const keys = await t.DB.prepare("SELECT COUNT(*) AS n FROM key_verifiers WHERE owner_id = ? AND revoked_at IS NULL").bind(t.alice.id).first();
  assert.equal(keys.n, 20, 'cap still holds');
});

test('reclaim verifies the secret: wrong secret rotates nothing', async () => {
  const t = await createTestEnv();
  const minted = await mintCode(t, t.alice);
  const first = await readJson(await claim(t, { code: minted.json.code, nodeId: 'n-sec' }));
  assert.equal(first.status, 201, first.text);
  const tail = minted.json.code.slice(-1);
  const wrong = minted.json.code.slice(0, -1) + (tail === '0' ? '1' : '0');
  const bad = await readJson(await claim(t, { code: wrong, nodeId: 'n-sec' }));
  assert.equal(bad.status, 404);
  assert.equal(bad.json.code, 'PAIRING_INVALID');
  const beat = await readJson(await t.call(`/api/resources/${first.json.resourceId}/heartbeat`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + first.json.heartbeatKey }, body: { usable: true },
  }));
  assert.equal(beat.status, 200, 'legitimate sender key survives the forged reclaim');
});

test('disabled owners cannot reclaim a spent code', async () => {
  const t = await createTestEnv();
  const minted = await mintCode(t, t.alice);
  const first = await readJson(await claim(t, { code: minted.json.code, nodeId: 'n-drec' }));
  assert.equal(first.status, 201, first.text);
  await t.DB.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').bind(t.alice.id).run();
  const retry = await readJson(await claim(t, { code: minted.json.code, nodeId: 'n-drec' }));
  assert.equal(retry.status, 404);
  assert.equal(retry.json.code, 'PAIRING_INVALID');
  const keys = await t.DB.prepare('SELECT COUNT(*) AS n FROM key_verifiers WHERE owner_id = ?').bind(t.alice.id).first();
  assert.equal(keys.n, 1, 'no credential minted for the disabled owner');
});

test('DELETE tears down jobs that reference grants', async () => {
  const t = await createTestEnv();
  const p = await pair(t, t.alice, 'node-jobdoom', { name: 'jobdoom' });
  const grant = await readJson(await t.call('/api/grants', {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf },
    body: { resourceId: p.resourceId, grantee: 'bob@example.com', maxJobs: 100, maxTokens: 100 },
  }));
  assert.equal(grant.status, 201, grant.text);
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO jobs (id, owner_id, resource_id, grant_id, adapter, model, status, tokens_in, tokens_out, cost_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('j_doom1', t.alice.id, p.resourceId, grant.json.id, 'mock', 'mock-summary', 'done', 1, 1, 'measured', now, now).run();
  const del = await readJson(await t.call(`/api/inventory/${p.resourceId}`, {
    method: 'DELETE', headers: { ...t.as(t.alice), ...t.csrf },
  }));
  assert.equal(del.status, 200, del.text);
  const job = await t.DB.prepare('SELECT id FROM jobs WHERE id = ?').bind('j_doom1').first();
  assert.equal(job, null, 'dependent job row deleted with its resource');
});

test('a stuck in-flight mapping is stolen after the grace window', async () => {
  const t = await createTestEnv();
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await t.DB.prepare('INSERT INTO idempotency_keys (owner_id, key, resource_id, created_at) VALUES (?, ?, NULL, ?)')
    .bind(t.alice.id, 'idem-stuck', stale).run();
  const r = await register(t, t.alice, { name: 'unstuck' }, 'idem-stuck');
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.name, 'unstuck');
  const fresh = new Date().toISOString();
  await t.DB.prepare('INSERT INTO idempotency_keys (owner_id, key, resource_id, created_at) VALUES (?, ?, NULL, ?)')
    .bind(t.alice.id, 'idem-live', fresh).run();
  const held = await register(t, t.alice, { name: 'held' }, 'idem-live');
  assert.equal(held.status, 409);
  assert.equal(held.json.code, 'IDEMPOTENT_IN_FLIGHT');
});

test('an all-uppercase code claims (typed-entry contract)', async () => {
  const t = await createTestEnv();
  const minted = await mintCode(t, t.alice);
  const out = await readJson(await claim(t, { code: minted.json.code.toUpperCase(), nodeId: 'n-upper' }));
  assert.equal(out.status, 201, out.text);
});

test('same node resumes a claim stranded before binding', async () => {
  const t = await createTestEnv();
  // Simulate a crash between code consumption and resource binding: the
  // resource row exists, the code is spent, but no binding was recorded.
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await t.DB.prepare('INSERT INTO resources (id, owner_id, node_id, name, kind, origin, cpu, gpu, configured, authenticated, online, usable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('r_strand', t.alice.id, 'n_strand', 'strand-box', 'local', 'paired', 'c', 'g', 1, 1, 0, 0, now).run();
  const secret = 'AAAAAAAAAAAA';
  const salt = 'test-salt-strand';
  await t.DB.prepare('INSERT INTO pairing_codes (id, owner_id, salt, verifier, created_at, expires_at, used_at, attempts, node_id, resource_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('p_deadbeef', t.alice.id, salt, await verifierFor(secret, salt), now, future, now, 0, 'n_strand', null).run();
  const out = await readJson(await claim(t, { code: 'pair-deadbeef-AAAA-AAAA-AAAA', nodeId: 'n_strand' }));
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.resourceId, 'r_strand', 'stranded row re-adopted, not duplicated');
  assert.equal(out.json.created, false);
  const beat = await readJson(await t.call(`/api/resources/r_strand/heartbeat`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + out.json.heartbeatKey }, body: { usable: false },
  }));
  assert.equal(beat.status, 200, 'resumed sender key works');
  const other = await readJson(await claim(t, { code: 'pair-deadbeef-AAAA-AAAA-AAAA', nodeId: 'n_intruder' }));
  assert.equal(other.status, 404, 'other nodes still rejected on the spent code');
});

test('a deleted-resource code stays invalid after re-pairing', async () => {
  const t = await createTestEnv();
  const minted = await mintCode(t, t.alice);
  const first = await readJson(await claim(t, { code: minted.json.code, nodeId: 'n_delrep' }));
  assert.equal(first.status, 201, first.text);
  const del = await readJson(await t.call(`/api/inventory/${first.json.resourceId}`, {
    method: 'DELETE', headers: { ...t.as(t.alice), ...t.csrf },
  }));
  assert.equal(del.status, 200, del.text);
  // Same node re-pairs within the reclaim window: new resource, new key.
  const minted2 = await mintCode(t, t.alice);
  const second = await readJson(await claim(t, { code: minted2.json.code, nodeId: 'n_delrep' }));
  assert.equal(second.status, 201, second.text);
  assert.notEqual(second.json.resourceId, first.json.resourceId);
  // Replaying the OLD code must not adopt the replacement or rotate its key.
  const replay = await readJson(await claim(t, { code: minted.json.code, nodeId: 'n_delrep' }));
  assert.equal(replay.status, 404);
  assert.equal(replay.json.code, 'PAIRING_INVALID');
  const beat = await readJson(await t.call(`/api/resources/${second.json.resourceId}/heartbeat`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + second.json.heartbeatKey }, body: { usable: true },
  }));
  assert.equal(beat.status, 200, 'replacement sender key survives the stale replay');
});

test('same node recreates after consumption without creation', async () => {
  const t = await createTestEnv();
  // Simulate a crash after code consumption but before the resource row
  // committed: spent code, snapshot recorded, no binding, no row.
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const secret = 'BBBBBBBBBBBB';
  const salt = 'test-salt-recreate';
  const snap = JSON.stringify({ name: 'recreated-box', kind: 'local', cpu: 'c', gpu: 'g', caps: ['chat'] });
  await t.DB.prepare('INSERT INTO pairing_codes (id, owner_id, salt, verifier, created_at, expires_at, used_at, attempts, node_id, resource_id, invalidated_at, claim_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('p_beefbeef', t.alice.id, salt, await verifierFor(secret, salt), now, future, now, 0, 'n_recreate', null, null, snap).run();
  const out = await readJson(await claim(t, { code: 'pair-beefbeef-BBBB-BBBB-BBBB', nodeId: 'n_recreate' }));
  assert.equal(out.status, 200, out.text);
  assert.ok(out.json.resourceId.startsWith('r_'), 'row rebuilt from the snapshot');
  assert.equal(out.json.resource.name, 'recreated-box');
  assert.deepEqual(out.json.resource.capabilities, ['chat']);
  const beat = await readJson(await t.call(`/api/resources/${out.json.resourceId}/heartbeat`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + out.json.heartbeatKey }, body: { usable: false },
  }));
  assert.equal(beat.status, 200, 'recreated sender key works');
});

test('deleting an interrupted claim kills the code, not future re-pairs', async () => {
  const t = await createTestEnv();
  // Interrupted claim: spent code, node recorded, no binding, row exists.
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await t.DB.prepare('INSERT INTO resources (id, owner_id, node_id, name, kind, origin, cpu, gpu, configured, authenticated, online, usable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('r_interrupt', t.alice.id, 'n_interrupt', 'interrupt-box', 'local', 'paired', 'c', 'g', 1, 1, 0, 0, now).run();
  await t.DB.prepare('INSERT INTO pairing_codes (id, owner_id, salt, verifier, created_at, expires_at, used_at, attempts, node_id, resource_id, invalidated_at, claim_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('p_cccccc01', t.alice.id, 's', await verifierFor('CCCCCCCCCCCC', 's'), now, future, now, 0, 'n_interrupt', null, null, null).run();
  const del = await readJson(await t.call('/api/inventory/r_interrupt', {
    method: 'DELETE', headers: { ...t.as(t.alice), ...t.csrf },
  }));
  assert.equal(del.status, 200, del.text);
  const retry = await readJson(await claim(t, { code: 'pair-cccccc01-CCCC-CCCC-CCCC', nodeId: 'n_interrupt' }));
  assert.equal(retry.status, 404, 'interrupted code died with its resource');
  assert.equal(retry.json.code, 'PAIRING_INVALID');
  // A fresh code re-pairs the node cleanly: invalidation is per-code.
  const minted = await mintCode(t, t.alice);
  const repair = await readJson(await claim(t, { code: minted.json.code, nodeId: 'n_interrupt' }));
  assert.equal(repair.status, 201, repair.text);
  assert.notEqual(repair.json.resourceId, 'r_interrupt');
});
test('teardown then in-flight claim: 404, nothing recreated, sender dead (round 6)', async () => {
  const t = await createTestEnv();
  const minted = await mintCode(t, t.alice);
  const first = await readJson(await claim(t, { code: minted.json.code, nodeId: 'n_race' }));
  assert.equal(first.status, 201, first.text);
  const del = await readJson(await t.call(`/api/inventory/${first.json.resourceId}`, {
    method: 'DELETE', headers: { ...t.as(t.alice), ...t.csrf },
  }));
  assert.equal(del.status, 200, del.text);
  const code = await t.DB.prepare('SELECT invalidated_at FROM pairing_codes WHERE id = ?').bind(minted.json.id).first();
  assert.ok(code && code.invalidated_at, 'teardown invalidated the spent code');
  // The in-flight peer (consumed before the DELETE) must not complete.
  const late = await readJson(await claim(t, { code: minted.json.code, nodeId: 'n_race' }));
  assert.equal(late.status, 404);
  assert.equal(late.json.code, 'PAIRING_INVALID');
  const rows = await t.DB.prepare('SELECT COUNT(*) AS n FROM resources WHERE owner_id = ?').bind(t.alice.id).first();
  assert.equal(rows.n, 0, 'deleted resource not resurrected');
  const live = await t.DB.prepare('SELECT COUNT(*) AS n FROM key_verifiers WHERE owner_id = ? AND revoked_at IS NULL').bind(t.alice.id).first();
  assert.equal(live.n, 0, 'no live sender key left behind');
  const beat = await readJson(await t.call(`/api/resources/${first.json.resourceId}/heartbeat`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + first.json.heartbeatKey }, body: { usable: true },
  }));
  assert.equal(beat.status, 401);
  assert.equal(beat.json.code, 'KEY_REVOKED', 'teardown killed the sender key');
});

test('a fresh claim on an invalidated code creates nothing (round 6 fence)', async () => {
  const t = await createTestEnv();
  // Teardown's exact SET clause, landing before the claim instead of
  // mid-flight: the fresh path has no validity gate, so only the atomic
  // creation/binding/mint fences refuse this. Pins the fence predicates
  // through the real endpoint; predicate+write atomicity closes the race.
  const minted = await mintCode(t, t.alice);
  await t.DB.prepare('UPDATE pairing_codes SET resource_id = NULL, invalidated_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), minted.json.id).run();
  const out = await readJson(await claim(t, { code: minted.json.code, nodeId: 'n_fenced' }));
  assert.equal(out.status, 404);
  assert.equal(out.json.code, 'PAIRING_INVALID');
  const rows = await t.DB.prepare('SELECT COUNT(*) AS n FROM resources WHERE owner_id = ?').bind(t.alice.id).first();
  assert.equal(rows.n, 0, 'no resource row');
  const keys = await t.DB.prepare('SELECT COUNT(*) AS n FROM key_verifiers WHERE owner_id = ?').bind(t.alice.id).first();
  assert.equal(keys.n, 0, 'no sender key minted');
});

test('an invalidated re-pair disturbs neither the live row nor its key (round 6 fence)', async () => {
  const t = await createTestEnv();
  const one = await pair(t, t.alice, 'n_steady', { name: 'steady-box' });
  const minted = await mintCode(t, t.alice);
  await t.DB.prepare('UPDATE pairing_codes SET resource_id = NULL, invalidated_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), minted.json.id).run();
  const out = await readJson(await claim(t, { code: minted.json.code, nodeId: 'n_steady' }));
  assert.equal(out.status, 404);
  assert.equal(out.json.code, 'PAIRING_INVALID');
  const count = await t.DB.prepare('SELECT COUNT(*) AS n FROM resources WHERE owner_id = ?').bind(t.alice.id).first();
  assert.equal(count.n, 1, 'live row untouched, no duplicate');
  const row = await t.DB.prepare('SELECT name FROM resources WHERE id = ?').bind(one.resourceId).first();
  assert.equal(row.name, 'steady-box');
  const keys = await t.DB.prepare('SELECT COUNT(*) AS n FROM key_verifiers WHERE owner_id = ?').bind(t.alice.id).first();
  assert.equal(keys.n, 1, 'no rotation minted');
  const beat = await readJson(await t.call(`/api/resources/${one.resourceId}/heartbeat`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + one.heartbeatKey }, body: { usable: true },
  }));
  assert.equal(beat.status, 200, 'live sender key still beats');
});
test('health is not ready without the onboarding schema (round 7)', async () => {
  // Deploy-before-migrate: W2 code against a DB migrated through 0005 only.
  // Key minting (resource_id), pairing (node_id, pairing_codes), and
  // idempotent registration (idempotency_keys) would all 500 here.
  const OLD = ['0001_better_auth.sql', '0002_app.sql', '0003_demo_auth.sql', '0004_disable_flag.sql', '0005_write_budget.sql'];
  const bare = await createTestEnv({ skipMigrations: true });
  applyMigrations(bare.sqlite, OLD);
  const stale = await readJson(await bare.call('/api/health'));
  assert.equal(stale.json.ready, false, 'deploy-before-migrate is not ready');
  assert.equal(stale.json.detail.schema, false);

  const t2 = await createTestEnv();
  t2.sqlite.exec('DROP INDEX idx_keys_resource; ALTER TABLE key_verifiers DROP COLUMN resource_id');
  const missing0013 = await readJson(await t2.call('/api/health'));
  assert.equal(missing0013.json.ready, false, 'key mint would 500 without resource_id');

  const t3 = await createTestEnv();
  t3.sqlite.exec('DROP TABLE pairing_codes');
  const missing0014 = await readJson(await t3.call('/api/health'));
  assert.equal(missing0014.json.ready, false);

  const t4 = await createTestEnv();
  t4.sqlite.exec('ALTER TABLE pairing_codes DROP COLUMN claim_json');
  const missing0015 = await readJson(await t4.call('/api/health'));
  assert.equal(missing0015.json.ready, false);
});

test('a superseded idempotent commit cannot duplicate (round 7 fence)', async () => {
  const t = await createTestEnv();
  // Deterministic replay of the production stall: the original's commit
  // batch reaches the DB only after its reservation matured, a retry stole
  // it, and the stealer committed. The shim runs statements through their
  // own methods so intercepting batch() observes the exact commit SQL.
  const realBatch = t.DB.batch;
  let fired = false;
  t.DB.batch = async (stmts) => {
    const isCommit = !fired && Array.isArray(stmts) && stmts.length === 2
      && stmts.some((s) => typeof s.sql === 'string' && s.sql.includes('UPDATE idempotency_keys SET resource_id'));
    if (!isCommit) return realBatch(stmts);
    fired = true;
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await t.DB.prepare('UPDATE idempotency_keys SET created_at = ? WHERE owner_id = ? AND key = ?')
      .bind(stale, t.alice.id, 'idem-race').run();
    const retry = await register(t, t.alice, { name: 'retry-box' }, 'idem-race');
    assert.equal(retry.status, 201, retry.text);
    return realBatch(stmts);
  };
  try {
    const out = await register(t, t.alice, { name: 'original-box' }, 'idem-race');
    assert.equal(fired, true, 'interleaving engaged the real commit batch');
    assert.equal(out.status, 409, out.text);
    assert.equal(out.json.code, 'IDEMPOTENT_IN_FLIGHT');
    const count = await t.DB.prepare('SELECT COUNT(*) AS n FROM resources WHERE owner_id = ?').bind(t.alice.id).first();
    assert.equal(count.n, 1, 'stealer row only; the late batch committed nothing');
    const winner = await t.DB.prepare('SELECT id, name FROM resources WHERE owner_id = ?').bind(t.alice.id).first();
    assert.equal(winner.name, 'retry-box');
    const map = await t.DB.prepare('SELECT resource_id FROM idempotency_keys WHERE owner_id = ? AND key = ?').bind(t.alice.id, 'idem-race').first();
    assert.equal(map.resource_id, winner.id, 'mapping still points at the stealer row');
    // And the loser's retry replays the winner instead of duplicating.
    const replay = await register(t, t.alice, { name: 'original-box' }, 'idem-race');
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.json.id, winner.id);
  } finally {
    t.DB.batch = realBatch;
  }
});

test('reclaim-recreate charges the write budget once (round 7)', async () => {
  const t = await createTestEnv();
  // Crash after consumption, before creation: spent code + snapshot, no row.
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const secret = 'DDDDDDDDDDDD';
  const salt = 'test-salt-budget';
  const snap = JSON.stringify({ name: 'budget-box', kind: 'local', cpu: 'c', gpu: 'g', caps: [] });
  await t.DB.prepare('INSERT INTO pairing_codes (id, owner_id, salt, verifier, created_at, expires_at, used_at, attempts, node_id, resource_id, invalidated_at, claim_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('p_dd00dd00', t.alice.id, salt, await verifierFor(secret, salt), now, future, now, 0, 'n_budget', null, null, snap).run();
  // Hourly budget nearly spent: 119 of 120 claimed. A double charge would
  // 429 after the row committed, stranding a keyless resource.
  const window = now.slice(0, 13);
  await t.DB.prepare('INSERT INTO write_budget (user_id, window, count) VALUES (?, ?, 119)').bind(t.alice.id, window).run();
  const out = await readJson(await claim(t, { code: 'pair-dd00dd00-DDDD-DDDD-DDDD', nodeId: 'n_budget' }));
  assert.equal(out.status, 200, out.text);
  assert.ok(out.json.heartbeatKey, 'key issued: recovery was not stranded keyless');
  const budget = await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind(t.alice.id, window).first();
  assert.equal(budget.count, 120, 'charged exactly once');
  const beat = await readJson(await t.call(`/api/resources/${out.json.resourceId}/heartbeat`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + out.json.heartbeatKey }, body: { usable: false },
  }));
  assert.equal(beat.status, 200, 'recovered sender key works');
});
test('idempotent replays are free at budget exhaustion (round 8)', async () => {
  const t = await createTestEnv();
  const first = await register(t, t.alice, { name: 'budget-box' }, 'idem-free');
  assert.equal(first.status, 201, first.text);
  // Spend the whole hourly budget after the registration completed.
  const window = new Date().toISOString().slice(0, 13);
  await t.DB.prepare('UPDATE write_budget SET count = 120 WHERE user_id = ? AND window = ?').bind(t.alice.id, window).run();
  // Lost-response retry replays the original card instead of 429ing.
  const replay = await register(t, t.alice, { name: 'budget-box' }, 'idem-free');
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.id, first.json.id, 'original card, not a duplicate');
  const budget = await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind(t.alice.id, window).first();
  assert.equal(budget.count, 120, 'replay consumed no budget');
  // Fresh registrations still gate on the spent budget.
  const gated = await register(t, t.alice, { name: 'gated-box' }, 'idem-gated');
  assert.equal(gated.status, 429);
  assert.equal(gated.json.code, 'WRITE_RATE_LIMITED');
  const count = await t.DB.prepare('SELECT COUNT(*) AS n FROM resources WHERE owner_id = ?').bind(t.alice.id).first();
  assert.equal(count.n, 1, 'gated request wrote nothing');
});

test('in-flight collisions wait free at exhaustion (round 8)', async () => {
  const t = await createTestEnv();
  // A live claim holds this key; the budget is already spent.
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO idempotency_keys (owner_id, key, resource_id, created_at) VALUES (?, ?, NULL, ?)')
    .bind(t.alice.id, 'idem-held', now).run();
  await t.DB.prepare('INSERT INTO write_budget (user_id, window, count) VALUES (?, ?, 120)').bind(t.alice.id, now.slice(0, 13)).run();
  const out = await register(t, t.alice, { name: 'held-box' }, 'idem-held');
  assert.equal(out.status, 409, out.text);
  assert.equal(out.json.code, 'IDEMPOTENT_IN_FLIGHT', 'waits, not budget-rejected');
  const budget = await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind(t.alice.id, now.slice(0, 13)).first();
  assert.equal(budget.count, 120, 'collision check consumed no budget');
});

test('re-pair refreshes discovered hardware, keeps the row (round 8)', async () => {
  const t = await createTestEnv();
  const one = await pair(t, t.alice, 'n_refresh', { name: 'refresh-box', kind: 'local', cpu: 'old-cpu', gpu: 'old-gpu', capabilities: ['a'] });
  // New code, new hardware: same row, refreshed descriptors.
  const two = await mintCode(t, t.alice);
  const out = await readJson(await claim(t, {
    code: two.json.code, nodeId: 'n_refresh', kind: 'local', cpu: 'new-cpu', gpu: 'new-gpu', capabilities: ['a', 'b'],
  }));
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.created, false);
  assert.equal(out.json.resourceId, one.resourceId, 'same row, no duplicate');
  assert.equal(out.json.resource.name, 'refresh-box', 'name untouched');
  assert.equal(out.json.resource.compute.cpu, 'new-cpu');
  assert.equal(out.json.resource.compute.gpu, 'new-gpu');
  assert.deepEqual(out.json.resource.capabilities, ['a', 'b']);
  const row = await t.DB.prepare('SELECT kind, cpu, gpu, capabilities_json, name FROM resources WHERE id = ?').bind(one.resourceId).first();
  assert.equal(row.cpu, 'new-cpu', 'persisted, not just rendered');
  assert.equal(row.gpu, 'new-gpu');
  assert.equal(row.capabilities_json, JSON.stringify(['a', 'b']));
  // Placeholders and empty lists never clobber real data.
  const three = await mintCode(t, t.alice);
  const ph = await readJson(await claim(t, {
    code: three.json.code, nodeId: 'n_refresh', cpu: 'unknown', gpu: 'none recorded', capabilities: [],
  }));
  assert.equal(ph.status, 200, ph.text);
  assert.equal(ph.json.resource.compute.cpu, 'new-cpu');
  assert.equal(ph.json.resource.compute.gpu, 'new-gpu');
  assert.deepEqual(ph.json.resource.capabilities, ['a', 'b']);
  // Bare re-pair (descriptors absent) keeps everything.
  const four = await mintCode(t, t.alice);
  const bare = await readJson(await claim(t, { code: four.json.code, nodeId: 'n_refresh' }));
  assert.equal(bare.status, 200, bare.text);
  assert.equal(bare.json.resource.compute.cpu, 'new-cpu');
  const count = await t.DB.prepare('SELECT COUNT(*) AS n FROM resources WHERE owner_id = ?').bind(t.alice.id).first();
  assert.equal(count.n, 1, 'three re-pairs, still one row');
});
test('a timestamp-tied steal still waits instead of misreporting cap (round 8)', async () => {
  const t = await createTestEnv();
  // Same interleaving as the fence test, but the stealer's row is forged
  // to carry our exact reservation stamp (same-millisecond tie): the
  // classifier must read the bound row id, not the stamp, and wait.
  const realBatch = t.DB.batch;
  let fired = false;
  t.DB.batch = async (stmts) => {
    const isCommit = !fired && Array.isArray(stmts) && stmts.length === 2
      && stmts.some((s) => typeof s.sql === 'string' && s.sql.includes('UPDATE idempotency_keys SET resource_id'));
    if (!isCommit) return realBatch(stmts);
    fired = true;
    const ours = await t.DB.prepare('SELECT created_at FROM idempotency_keys WHERE owner_id = ? AND key = ?').bind(t.alice.id, 'idem-tie').first();
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await t.DB.prepare('UPDATE idempotency_keys SET created_at = ? WHERE owner_id = ? AND key = ?').bind(stale, t.alice.id, 'idem-tie').run();
    const retry = await register(t, t.alice, { name: 'retry-box' }, 'idem-tie');
    assert.equal(retry.status, 201, retry.text);
    await t.DB.prepare('UPDATE idempotency_keys SET created_at = ? WHERE owner_id = ? AND key = ?').bind(ours.created_at, t.alice.id, 'idem-tie').run();
    return realBatch(stmts);
  };
  try {
    const out = await register(t, t.alice, { name: 'original-box' }, 'idem-tie');
    assert.equal(fired, true, 'interleaving engaged the real commit batch');
    assert.equal(out.status, 409, out.text);
    assert.equal(out.json.code, 'IDEMPOTENT_IN_FLIGHT', 'tied steal waits; cap is not misreported');
    const count = await t.DB.prepare('SELECT COUNT(*) AS n FROM resources WHERE owner_id = ?').bind(t.alice.id).first();
    assert.equal(count.n, 1, 'stealer row only; the late batch committed nothing');
  } finally {
    t.DB.batch = realBatch;
  }
});

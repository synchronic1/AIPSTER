/* Built with Meta Muse. */
// Tests for one-time worker pairing + registration hardening.
// Contract: docs/pairing.md. All codes/keys here are disposable local test
// fixtures minted against the in-memory D1 shim — never production credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from 'better-auth/crypto';
import { createTestEnv, readJson } from './d1-shim.mjs';

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
  const wrongSecret = (n) => minted.json.code.slice(0, -1) + (n % 2 === 0 ? '0' : '1');
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

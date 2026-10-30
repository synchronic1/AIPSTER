/* Built with Meta Muse. */
// Tests for owner-confined heartbeat intake (POST /api/resources/:id/heartbeat).
// Contract: docs/heartbeat-intake.md. All keys here are disposable local test
// fixtures minted against the in-memory D1 shim — never production credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from 'better-auth/crypto';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { budgetWindow } from '../src/lib/quotas.js';

async function register(t, user, name) {
  const res = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: { ...t.as(user), ...t.csrf },
    body: { name, kind: 'local', origin: 'lab', cpu: 'x', gpu: 'y' },
  }));
  assert.equal(res.status, 201, res.text);
  return res.json;
}

async function mint(t, user, body) {
  return readJson(await t.call('/api/keys', {
    method: 'POST', headers: { ...t.as(user), ...t.csrf }, body,
  }));
}

async function mintHeartbeat(t, user, resourceId, name = 'hb-sender') {
  const out = await mint(t, user, { name, scope: 'heartbeat', resourceId });
  assert.equal(out.status, 201, out.text);
  assert.equal(out.json.resourceId, resourceId);
  return out.json;
}

function beat(t, secret, resourceId, body, headers = {}) {
  return t.call(`/api/resources/${resourceId}/heartbeat`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function resourceRow(t, id) {
  return t.DB.prepare('SELECT * FROM resources WHERE id = ?').bind(id).first();
}

const DEMO_PASSWORD = 'heartbeat-test-password-01';

async function seedDemo(t) {
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, username, displayUsername, demo, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('u_demo', 'Demo explorer', 'demo@aipster.invalid', 0, null, 'demo', 'demo', 1, now, now).run();
  const hash = await hashPassword(DEMO_PASSWORD);
  await t.DB.prepare('INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('acc_demo_heartbeat', 'u_demo', 'credential', 'u_demo', hash, now, now).run();
  const res = await t.call('/api/auth/sign-in/username', { method: 'POST', body: { username: 'demo', password: DEMO_PASSWORD } });
  const out = await readJson(res);
  assert.equal(out.status, 200, out.text);
  const cookies = res.headers.getSetCookie().find((c) => c.startsWith('better-auth.session_token='));
  return { Cookie: cookies.split(';')[0] };
}

test('heartbeat keys mint bound to exactly one caller-owned resource', async () => {
  const t = await createTestEnv();
  const mine = await register(t, t.alice, 'alice-box');
  const other = await register(t, t.bob, 'bob-box');
  const key = await mintHeartbeat(t, t.alice, mine.id);
  assert.ok(key.secret.startsWith('aip_live_k_'), 'live secret shape');
  assert.ok(key.oneTime, 'one-time reveal');
  assert.equal(key.scope, 'heartbeat');
  const listed = await readJson(await t.call('/api/keys', { headers: t.as(t.alice) }));
  const row = listed.json.items.find((k) => k.id === key.id);
  assert.equal(row.resourceId, mine.id, 'binding visible in key list');
  assert.ok(!JSON.stringify(listed.json).includes(key.secret), 'no secret material in lists');
  const read = await mint(t, t.alice, { name: 'r', scope: 'read' });
  assert.equal(read.json.resourceId, null, 'read keys carry no binding');
  const missing = await mint(t, t.alice, { name: 'x', scope: 'heartbeat' });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 'BAD_RESOURCE');
  const foreign = await mint(t, t.alice, { name: 'x', scope: 'heartbeat', resourceId: other.id });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.json.code, 'NOT_FOUND');
  const ghost = await mint(t, t.alice, { name: 'x', scope: 'heartbeat', resourceId: 'r_nope' });
  assert.equal(ghost.status, 404);
  const misplaced = await mint(t, t.alice, { name: 'x', scope: 'read', resourceId: mine.id });
  assert.equal(misplaced.status, 400);
  assert.equal(misplaced.json.code, 'BAD_RESOURCE');
  const badScope = await mint(t, t.alice, { name: 'x', scope: 'admin' });
  assert.equal(badScope.status, 400);
  assert.equal(badScope.json.code, 'BAD_SCOPE');
});

test('demo users cannot mint heartbeat keys', async () => {
  const t = await createTestEnv();
  const cookie = await seedDemo(t);
  const r = await readJson(await t.call('/api/inventory', { method: 'POST', headers: { ...cookie, ...t.csrf }, body: { name: 'demo-box' } }));
  assert.equal(r.status, 201, 'demo may register isolated resources');
  const hb = await readJson(await t.call('/api/keys', { method: 'POST', headers: { ...cookie, ...t.csrf }, body: { name: 'demo-hb', scope: 'heartbeat', resourceId: r.json.id } }));
  assert.equal(hb.status, 403);
  assert.equal(hb.json.code, 'DEMO_RESTRICTED');
  const read = await readJson(await t.call('/api/keys', { method: 'POST', headers: { ...cookie, ...t.csrf }, body: { name: 'demo-read', scope: 'read' } }));
  assert.equal(read.status, 201, 'demo read keys still mint');
});

test('heartbeat happy path writes heartbeat_at, online, usable — and nothing else', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'alice-box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  const before = await resourceRow(t, r.id);
  const out = await readJson(await beat(t, key.secret, r.id, { usable: true }));
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.ok, true);
  assert.equal(out.json.id, r.id);
  assert.equal(out.json.online, true);
  assert.equal(out.json.usable, true);
  assert.ok(Number.isFinite(Date.parse(out.json.heartbeatAt)), 'server timestamp');
  const after = await resourceRow(t, r.id);
  assert.equal(after.heartbeat_at, out.json.heartbeatAt);
  assert.equal(after.online, 1);
  assert.equal(after.usable, 1);
  for (const col of Object.keys(after)) {
    if (['heartbeat_at', 'online', 'usable'].includes(col)) continue;
    assert.deepEqual(after[col], before[col], `column ${col} untouched`);
  }
});

test('usable=false means reachable but NOT acceptable: the strip never shows runnable/ready', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'alice-box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  const out = await readJson(await beat(t, key.secret, r.id, { usable: false }));
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.usable, false);
  const status = await readJson(await t.call('/api/status', { headers: t.as(t.alice) }));
  assert.equal(status.status, 200);
  const item = status.json.items.find((i) => i.id === r.id);
  assert.equal(item.liveness, 'online', 'fresh heartbeat_at still drives liveness');
  assert.equal(item.usable, false, 'usable=false survives into the strip');
  assert.ok(item.lastSeenAt, 'heartbeat-seen');
  assert.ok(!/ready|runnable/i.test(JSON.stringify(status.json)), 'strip never renders runnable/ready');
  // Either value updates liveness; flip back to usable after the window.
  await t.DB.prepare('UPDATE resources SET heartbeat_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - 26000).toISOString(), r.id).run();
  const flip = await readJson(await beat(t, key.secret, r.id, { usable: true }));
  assert.equal(flip.status, 200, flip.text);
  const status2 = await readJson(await t.call('/api/status', { headers: t.as(t.alice) }));
  assert.equal(status2.json.items.find((i) => i.id === r.id).usable, true);
});

test('strict body: exactly {"usable": boolean}, 1 KiB cap, never a client timestamp', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'alice-box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  const bad = [
    ['missing usable', {}],
    ['non-boolean number', { usable: 1 }],
    ['non-boolean string', { usable: 'true' }],
    ['non-boolean null', { usable: null }],
    ['unknown field', { usable: true, extra: 1 }],
    ['client timestamp rejected', { usable: true, heartbeat_at: new Date().toISOString() }],
    ['client online flag rejected', { usable: true, online: 1 }],
    ['array body', []],
    ['empty body', ''],
    ['non-JSON', 'not json{{{'],
  ];
  for (const [label, body] of bad) {
    const out = await readJson(await beat(t, key.secret, r.id, body));
    assert.equal(out.status, 400, label);
    assert.ok(['BAD_HEARTBEAT', 'BAD_JSON'].includes(out.json.code), `${label}: ${out.text}`);
  }
  const big = await readJson(await beat(t, key.secret, r.id, { usable: true, pad: 'x'.repeat(2048) }));
  assert.equal(big.status, 413, 'over the 1 KiB cap');
  assert.equal(big.json.code, 'BODY_TOO_LARGE');
  const row = await resourceRow(t, r.id);
  assert.equal(row.heartbeat_at, null, 'rejected bodies write nothing');
  assert.equal(row.online, 0);
});

test('heartbeat auth is API-key only: sessions rejected, no CSRF surface', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'alice-box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  const withCsrf = await readJson(await t.call(`/api/resources/${r.id}/heartbeat`, {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { usable: true },
  }));
  assert.equal(withCsrf.status, 403);
  assert.equal(withCsrf.json.code, 'KEY_REQUIRED');
  const noCsrf = await readJson(await t.call(`/api/resources/${r.id}/heartbeat`, {
    method: 'POST', headers: t.as(t.alice), body: { usable: true },
  }));
  assert.equal(noCsrf.status, 403, 'rejected before any CSRF check');
  assert.equal(noCsrf.json.code, 'KEY_REQUIRED');
  const anon = await readJson(await t.call(`/api/resources/${r.id}/heartbeat`, { method: 'POST', body: { usable: true } }));
  assert.equal(anon.status, 401);
  const read = await mint(t, t.alice, { name: 'r', scope: 'read' });
  const viaRead = await readJson(await beat(t, read.json.secret, r.id, { usable: true }));
  assert.equal(viaRead.status, 403);
  assert.equal(viaRead.json.code, 'KEY_SCOPE');
  const inf = await mint(t, t.alice, { name: 'i', scope: 'inference' });
  const viaInf = await readJson(await beat(t, inf.json.secret, r.id, { usable: true }));
  assert.equal(viaInf.status, 403);
  assert.equal(viaInf.json.code, 'KEY_SCOPE');
  const garbage = await readJson(await beat(t, 'aip_live_k_deadbeefdeadbeef_garbage', r.id, { usable: true }));
  assert.equal(garbage.status, 401);
  assert.equal((await resourceRow(t, r.id)).heartbeat_at, null, 'rejected callers write nothing');
});

test('heartbeat key is rejected by every other route (least privilege)', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'alice-box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  const auth = { Authorization: 'Bearer ' + key.secret };
  const routes = [
    ['GET /api/inventory', 'GET', '/api/inventory', 'KEY_SCOPE'],
    ['POST /api/inventory', 'POST', '/api/inventory', 'KEY_FORBIDDEN'],
    ['GET /api/inventory/:id (even the bound resource)', 'GET', '/api/inventory/' + r.id, 'KEY_SCOPE'],
    ['GET /api/status', 'GET', '/api/status', 'KEY_SCOPE'],
    ['GET /api/shared-with-me', 'GET', '/api/shared-with-me', 'KEY_SCOPE'],
    ['GET /api/grants', 'GET', '/api/grants', 'KEY_FORBIDDEN'],
    ['POST /api/grants', 'POST', '/api/grants', 'KEY_FORBIDDEN'],
    ['DELETE /api/grants/:id', 'DELETE', '/api/grants/g_nope', 'KEY_FORBIDDEN'],
    ['GET /api/keys', 'GET', '/api/keys', 'KEY_FORBIDDEN'],
    ['POST /api/keys', 'POST', '/api/keys', 'KEY_FORBIDDEN'],
    ['DELETE /api/keys/:id', 'DELETE', '/api/keys/k_nope', 'KEY_FORBIDDEN'],
    ['POST /api/jobs (403, never the 501 dispatch path)', 'POST', '/api/jobs', 'KEY_SCOPE'],
    ['GET /api/jobs', 'GET', '/api/jobs', 'KEY_SCOPE'],
    ['GET /api/jobs/:id', 'GET', '/api/jobs/j_nope', 'KEY_SCOPE'],
    ['GET /api/usage', 'GET', '/api/usage', 'KEY_SCOPE'],
    ['GET /api/settings', 'GET', '/api/settings', 'KEY_FORBIDDEN'],
    ['PATCH /api/settings', 'PATCH', '/api/settings', 'KEY_FORBIDDEN'],
    ['GET /api/audit', 'GET', '/api/audit', 'KEY_FORBIDDEN'],
  ];
  for (const [label, method, path, code] of routes) {
    const out = await readJson(await t.call(path, { method, headers: auth, body: method === 'GET' || method === 'DELETE' ? undefined : {} }));
    assert.equal(out.status, 403, label);
    assert.equal(out.json.code, code, label);
  }
  const ok = await readJson(await beat(t, key.secret, r.id, { usable: true }));
  assert.equal(ok.status, 200, 'its own heartbeat endpoint still works');
});

test('binding: a key for A cannot heartbeat B; cross-owner is 404', async () => {
  const t = await createTestEnv();
  const a = await register(t, t.alice, 'a-box');
  const b = await register(t, t.alice, 'b-box');
  const foreign = await register(t, t.bob, 'bob-box');
  const key = await mintHeartbeat(t, t.alice, a.id);
  for (const [label, id] of [['own other resource', b.id], ['other-owner resource', foreign.id], ['missing resource', 'r_nope']]) {
    const out = await readJson(await beat(t, key.secret, id, { usable: true }));
    assert.equal(out.status, 404, label);
    assert.equal(out.json.code, 'NOT_FOUND');
  }
  assert.equal((await resourceRow(t, b.id)).heartbeat_at, null, 'cross-binding writes nothing');
  assert.equal((await resourceRow(t, foreign.id)).heartbeat_at, null);
});

test('revoked and expired keys get 401 with no write', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'alice-box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  const rev = await readJson(await t.call('/api/keys/' + key.id, { method: 'DELETE', headers: { ...t.as(t.alice), ...t.csrf } }));
  assert.equal(rev.status, 200);
  const revoked = await readJson(await beat(t, key.secret, r.id, { usable: true }));
  assert.equal(revoked.status, 401);
  assert.equal(revoked.json.code, 'KEY_REVOKED');
  assert.equal((await resourceRow(t, r.id)).heartbeat_at, null, 'revoked key writes nothing');
  await t.DB.prepare("UPDATE key_verifiers SET revoked_at = NULL, expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(key.id).run();
  const expired = await readJson(await beat(t, key.secret, r.id, { usable: true }));
  assert.equal(expired.status, 401);
  assert.equal(expired.json.code, 'KEY_EXPIRED');
  assert.equal((await resourceRow(t, r.id)).heartbeat_at, null, 'expired key writes nothing');
});

test('25s rate window: too-soon is 429 with Retry-After; window expiry admits again', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'alice-box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  const first = await readJson(await beat(t, key.secret, r.id, { usable: true }));
  assert.equal(first.status, 200, first.text);
  const soon = await readJson(await beat(t, key.secret, r.id, { usable: false }));
  assert.equal(soon.status, 429);
  assert.equal(soon.json.code, 'HEARTBEAT_TOO_SOON');
  assert.ok(soon.headers.get('Retry-After'), 'Retry-After header set');
  assert.equal(Number(soon.headers.get('Retry-After')), soon.json.retryAfterSec);
  assert.ok(soon.json.retryAfterSec >= 1 && soon.json.retryAfterSec <= 25, 'retry hint within the window');
  const row = await resourceRow(t, r.id);
  assert.equal(row.heartbeat_at, first.json.heartbeatAt, 'rejected heartbeat keeps the old timestamp');
  assert.equal(row.usable, 1, 'rejected usable=false does not flip the bit');
  await t.DB.prepare('UPDATE resources SET heartbeat_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - 26000).toISOString(), r.id).run();
  const again = await readJson(await beat(t, key.secret, r.id, { usable: false }));
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.usable, false);
});

test('heartbeats never draw the hourly write budget', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'alice-box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  // Spend the whole hourly budget directly, then prove intake still works.
  // (register+mint already opened this hour's bucket, so UPDATE it spent.)
  await t.DB.prepare('UPDATE write_budget SET count = 120 WHERE user_id = ? AND window = ?')
    .bind(t.alice.id, budgetWindow()).run();
  const ok = await readJson(await beat(t, key.secret, r.id, { usable: true }));
  assert.equal(ok.status, 200, ok.text);
  const budget = await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?')
    .bind(t.alice.id, budgetWindow()).first();
  assert.equal(budget.count, 120, 'intake drew no budget');
  const control = await readJson(await t.call('/api/inventory', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'over-budget' } }));
  assert.equal(control.status, 429, 'budget really is spent for normal writes');
  assert.equal(control.json.code, 'WRITE_RATE_LIMITED');
});

test('RACE: concurrent heartbeat bursts admit exactly one write', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'alice-box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    beat(t, key.secret, r.id, { usable: true }).then((res) => readJson(res))));
  const accepted = results.filter((o) => o.status === 200);
  const throttled = results.filter((o) => o.status === 429);
  assert.equal(accepted.length, 1, 'exactly one burst member wins the atomic claim');
  assert.equal(throttled.length, 9, 'every loser is a 429, never a 500 or a second write');
  assert.ok(throttled.every((o) => o.json.code === 'HEARTBEAT_TOO_SOON' && o.headers.get('Retry-After')));
  const row = await resourceRow(t, r.id);
  assert.equal(row.heartbeat_at, accepted[0].json.heartbeatAt);
});

test('RACE: deletion between mint and post is 404 with no write', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'alice-box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  // Direct-DB teardown reaches the dangling-binding state: D1 leaves foreign
  // key enforcement off, so a removed resource can strand a live binding;
  // the node:sqlite shim enforces FKs, so relax it for this setup step only.
  t.sqlite.exec('PRAGMA foreign_keys = OFF');
  await t.DB.prepare('DELETE FROM resources WHERE id = ?').bind(r.id).run();
  t.sqlite.exec('PRAGMA foreign_keys = ON');
  const out = await readJson(await beat(t, key.secret, r.id, { usable: true }));
  assert.equal(out.status, 404);
  assert.equal(out.json.code, 'NOT_FOUND');
  assert.equal(await resourceRow(t, r.id), null, 'no row resurrected');
});

test('RACE: revocation/expiry between mint and post is 401 with no write', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'alice-box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  await t.DB.prepare('UPDATE key_verifiers SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), key.id).run();
  const revoked = await readJson(await beat(t, key.secret, r.id, { usable: true }));
  assert.equal(revoked.status, 401);
  assert.equal(revoked.json.code, 'KEY_REVOKED');
  assert.equal((await resourceRow(t, r.id)).heartbeat_at, null, 'revoked-race writes nothing');
  const key2 = await mintHeartbeat(t, t.alice, r.id, 'hb-race-2');
  await t.DB.prepare("UPDATE key_verifiers SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(key2.id).run();
  const expired = await readJson(await beat(t, key2.secret, r.id, { usable: true }));
  assert.equal(expired.status, 401);
  assert.equal(expired.json.code, 'KEY_EXPIRED');
  assert.equal((await resourceRow(t, r.id)).heartbeat_at, null, 'expiry-race writes nothing');
});

test('audit: key creation is logged; heartbeats leave no audit rows (coarse last_used_at only)', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'alice-box');
  const auditCount = async () => (await t.DB.prepare('SELECT COUNT(*) AS n FROM audit WHERE actor_id = ?').bind(t.alice.id).first()).n;
  const before = await auditCount();
  const key = await mintHeartbeat(t, t.alice, r.id);
  assert.equal(await auditCount(), before + 1, 'mint writes one audit row');
  const logged = await t.DB.prepare("SELECT * FROM audit WHERE action = 'key.create' AND target = ?").bind(key.id).first();
  assert.ok(logged.detail.includes(r.id), 'mint audit records the binding');
  await t.DB.prepare("UPDATE key_verifiers SET last_used_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(key.id).run();
  const ok = await readJson(await beat(t, key.secret, r.id, { usable: true }));
  assert.equal(ok.status, 200, ok.text);
  const throttled = await readJson(await beat(t, key.secret, r.id, { usable: true }));
  assert.equal(throttled.status, 429);
  assert.equal(await auditCount(), before + 1, 'no audit row per heartbeat');
  const used = await t.DB.prepare('SELECT last_used_at FROM key_verifiers WHERE id = ?').bind(key.id).first();
  assert.ok(Date.parse(used.last_used_at) > Date.parse('2000-01-01T00:00:00.000Z'), 'coarse last_used_at still advances');
});

test('POST /api/jobs stays 501 INFERENCE_DISABLED for session and inference keys', async () => {
  const t = await createTestEnv();
  await register(t, t.alice, 'alice-box');
  const viaSession = await readJson(await t.call('/api/jobs', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: {} }));
  assert.equal(viaSession.status, 501);
  assert.equal(viaSession.json.code, 'INFERENCE_DISABLED');
  const inf = await mint(t, t.alice, { name: 'i', scope: 'inference' });
  const viaKey = await readJson(await t.call('/api/jobs', { method: 'POST', headers: { Authorization: 'Bearer ' + inf.json.secret }, body: {} }));
  assert.equal(viaKey.status, 501);
  assert.equal(viaKey.json.code, 'INFERENCE_DISABLED');
});

test('disabled owner cannot heartbeat (0004)', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'alice-box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  const first = await readJson(await beat(t, key.secret, r.id, { usable: true }));
  assert.equal(first.status, 200, first.text);
  await t.DB.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').bind(t.alice.id).run();
  await t.DB.prepare('UPDATE resources SET heartbeat_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - 26000).toISOString(), r.id).run();
  const out = await readJson(await beat(t, key.secret, r.id, { usable: true }));
  assert.equal(out.status, 401);
  const row = await resourceRow(t, r.id);
  assert.ok(Date.parse(row.heartbeat_at) < Date.now() - 25000, 'disabled owner writes nothing');
});

test('offline/stale stays derived by the 5-minute status rule', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'alice-box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  const out = await readJson(await beat(t, key.secret, r.id, { usable: true }));
  assert.equal(out.status, 200, out.text);
  const fresh = await readJson(await t.call('/api/status', { headers: t.as(t.alice) }));
  assert.equal(fresh.json.items.find((i) => i.id === r.id).liveness, 'online');
  await t.DB.prepare('UPDATE resources SET heartbeat_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - 6 * 60 * 1000).toISOString(), r.id).run();
  const aged = await readJson(await t.call('/api/status', { headers: t.as(t.alice) }));
  assert.equal(aged.json.items.find((i) => i.id === r.id).liveness, 'stale');
});

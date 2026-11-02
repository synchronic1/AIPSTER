/* Built with Meta Muse. */
// Admin audit read tests: authorization stays exactly as-is (only
// security_reviewer), the projection is conservative and never leaks
// actor/target/detail, pagination is bounded and deterministic, and empty is
// distinct from unavailable. All rows/grants are disposable in-memory fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';

const AUDIT = '/api/admin/v1/audit';

async function grant(t, userId, role, over = {}) {
  const now = new Date().toISOString();
  await t.DB.prepare(
    'INSERT INTO admin_grants (id, user_id, role, scope, expires_at, created_at, created_by, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    'g_' + Math.random().toString(36).slice(2, 10),
    userId,
    role,
    over.scope === undefined ? 'platform' : over.scope,
    over.expires_at === undefined ? null : over.expires_at,
    now,
    'operator',
    over.revoked_at === undefined ? null : over.revoked_at,
  ).run();
}

async function seedAudit(t, over = {}) {
  const id = over.id || ('a_' + Math.random().toString(36).slice(2, 10));
  await t.DB.prepare('INSERT INTO audit (id, at, actor_id, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(
      id,
      over.at === undefined ? new Date().toISOString() : over.at,
      over.actor_id === undefined ? 'u_alice' : over.actor_id,
      over.action === undefined ? 'resource.register' : over.action,
      over.target === undefined ? 'r_target' : over.target,
      over.detail === undefined ? '' : over.detail,
    ).run();
  return id;
}

async function mintKey(t, user, body) {
  const out = await readJson(await t.call('/api/keys', { method: 'POST', headers: { ...t.as(user), ...t.csrf }, body }));
  assert.equal(out.status, 201, out.text);
  return out.json;
}

// A signed-in, allowlisted caller holding a real grant row (never a synthetic
// cookie): the denial matrix must exercise the real better-auth + D1 path.
async function userWithRole(t, id, role, over = {}) {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const token = 'tok_' + id;
  await t.DB.prepare('INSERT OR IGNORE INTO allowlist (email, added_at) VALUES (?, ?)').bind(id + '@example.com', now).run();
  await t.DB.prepare('INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?,?,?,1,NULL,?,?)')
    .bind(id, id, id + '@example.com', now, now).run();
  await t.DB.prepare('INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?,?,?,?,?,NULL,?,?)')
    .bind('s_' + id, future, token, now, now, 'test', id).run();
  if (role) await grant(t, id, role, over);
  return { id, token, name: id, email: id + '@example.com' };
}

test('admin audit: denial matrix unchanged (only security_reviewer reads)', async () => {
  const t = await createTestEnv();
  await seedAudit(t, { id: 'a_den1' });

  const anon = await readJson(await t.call(AUDIT));
  assert.equal(anon.status, 401, 'anonymous is unauthenticated');
  assert.equal(anon.json.code, 'AUTH_REQUIRED');

  const grantless = await readJson(await t.call(AUDIT, { headers: t.as(t.alice) }));
  assert.equal(grantless.status, 403);
  assert.equal(grantless.json.code, 'ADMIN_FORBIDDEN');

  // Every non-security role must be refused, and the body must be identical.
  for (const role of ['operations_observer', 'access_administrator', 'support_triager', 'engineering_reviewer', 'role_grant_authority']) {
    const u = await userWithRole(t, 'u_' + role, role);
    const out = await readJson(await t.call(AUDIT, { headers: t.as(u) }));
    assert.equal(out.status, 403, role + ' must not read audit');
    assert.equal(out.json.code, 'ADMIN_FORBIDDEN');
    assert.deepEqual(out.json, grantless.json, role + ' denial body is uniform');
  }

  const key = await mintKey(t, t.alice, { name: 'k', scope: 'read' });
  const viaKey = await readJson(await t.call(AUDIT, { headers: { Authorization: 'Bearer ' + key.secret } }));
  assert.equal(viaKey.status, 403, 'user API keys never authorize administration');

  await grant(t, 'u_alice', 'security_reviewer');
  await t.DB.prepare('UPDATE "user" SET demo = 1 WHERE id = ?').bind('u_alice').run();
  const demo = await readJson(await t.call(AUDIT, { headers: t.as(t.alice) }));
  assert.equal(demo.status, 403, 'demo sessions never administer');

  await t.DB.prepare('UPDATE "user" SET demo = 0 WHERE id = ?').bind('u_alice').run();
  const live = await readJson(await t.call(AUDIT, { headers: t.as(t.alice) }));
  assert.equal(live.status, 200, 'live security_reviewer grant authorizes');

  // Revocation between pages: same session, next call denies.
  await t.DB.prepare("UPDATE admin_grants SET revoked_at = ? WHERE user_id = 'u_alice'").bind(new Date().toISOString()).run();
  const revoked = await readJson(await t.call(AUDIT, { headers: t.as(t.alice) }));
  assert.equal(revoked.status, 403, 'revocation is re-checked per request');
});

test('admin audit: expired and wrong-scope grants fail closed', async () => {
  const t = await createTestEnv();
  await seedAudit(t);
  await grant(t, 'u_alice', 'security_reviewer', { expires_at: '2020-01-01T00:00:00.000Z' });
  const expired = await readJson(await t.call(AUDIT, { headers: t.as(t.alice) }));
  assert.equal(expired.status, 403, 'expired grant denies');

  const t2 = await createTestEnv();
  await seedAudit(t2);
  await grant(t2, 'u_alice', 'security_reviewer', { scope: 'org:acme' });
  const wrongScope = await readJson(await t2.call(AUDIT, { headers: t2.as(t2.alice) }));
  assert.equal(wrongScope.status, 403, 'non-platform scope denies');
});

test('admin audit: measured empty is available, never unavailable or invented rows', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'security_reviewer');
  const out = await readJson(await t.call(AUDIT, { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.equal(out.json.state, 'available');
  assert.equal(out.json.schema_version, 'admin.audit.v1');
  assert.deepEqual(out.json.items, []);
  assert.equal(out.json.total, 0);
  assert.equal(out.json.limit, 20);
  assert.equal(out.json.offset, 0);
});

test('admin audit: projection omits actor, target and free-text detail', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'security_reviewer');
  await seedAudit(t, {
    id: 'a_secret',
    at: '2026-11-01T11:59:00.000Z',
    actor_id: 'u_secret_actor',
    action: 'fabric.invitation.create',
    target: 'inv_secret_target',
    detail: 'issuer@example.com -> node-secret 10.0.0.7',
  });
  const out = await readJson(await t.call(AUDIT, { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.equal(out.json.items.length, 1);
  const item = out.json.items[0];
  assert.deepEqual(Object.keys(item).sort(), ['action', 'action_known', 'at', 'at_known', 'category', 'id']);
  assert.equal(item.id, 'a_secret');
  assert.equal(item.action, 'fabric.invitation.create');
  assert.equal(item.category, 'fabric');
  assert.equal(item.action_known, true);
  assert.equal(item.at, '2026-11-01T11:59:00.000Z');
  assert.equal(item.at_known, true);
  // No raw identity/free-text anywhere in the serialized body.
  for (const secret of ['u_secret_actor', 'inv_secret_target', 'issuer@example.com', 'node-secret', '10.0.0.7']) {
    assert.ok(!out.text.includes(secret), 'response must not contain ' + secret);
  }
  assert.deepEqual(out.json.projection.omitted, ['actor_id', 'target', 'detail']);
});

test('admin audit: malformed stored rows are marked unknown, not trusted or dropped silently', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'security_reviewer');
  await seedAudit(t, { id: 'a_badaction', action: 'Not/A/Real Action<script>', at: '2026-11-01T10:00:00.000Z' });
  await seedAudit(t, { id: 'a_badns', action: 'unknownns.thing', at: '2026-11-01T10:01:00.000Z' });
  await seedAudit(t, { id: 'a_badtime', action: 'resource.delete', at: 'not-a-date' });
  const out = await readJson(await t.call(AUDIT, { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  const byId = Object.fromEntries(out.json.items.map((i) => [i.id, i]));
  assert.equal(byId.a_badaction.action, null);
  assert.equal(byId.a_badaction.action_known, false);
  assert.equal(byId.a_badaction.category, 'unknown');
  assert.equal(byId.a_badns.action, null, 'unrecognized namespace is not trusted');
  assert.equal(byId.a_badns.category, 'unknown');
  assert.equal(byId.a_badtime.at, null);
  assert.equal(byId.a_badtime.at_known, false);
  assert.equal(byId.a_badtime.action, 'resource.delete');
  assert.ok(!out.text.includes('<script>'), 'malformed action never serialized raw');
});

test('admin audit: namespace-shaped but unlisted actions are never echoed back', async () => {
  // A grammar check (or a namespace allowlist) would admit every one of
  // these. The projection is an exact writer vocabulary instead, so nothing
  // that is not a real audit action can carry free text into the response.
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'security_reviewer');
  const hostile = [
    'resource.synthetic_secret_value',
    'fabric.list_nodes',            // a real delegate permission, not an audit action
    'admin.audit.read',             // a real permission, not an audit action
    'fabric.invitation.created',    // plausible near-miss
    'key.create.SECRET',            // real prefix, invented suffix
    'FABRIC.INVITATION.CREATE',     // case-shifted real action
  ];
  for (let i = 0; i < hostile.length; i++) {
    await seedAudit(t, { id: 'a_h' + i, action: hostile[i], at: '2026-11-01T0' + i + ':00:00.000Z' });
  }
  const out = await readJson(await t.call(AUDIT, { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.equal(out.json.items.length, hostile.length, 'unlisted rows are shown as unknown, not dropped');
  for (const item of out.json.items) {
    assert.equal(item.action, null, 'unlisted action is never echoed (' + item.id + ')');
    assert.equal(item.action_known, false);
    assert.equal(item.category, 'unknown');
  }
  for (const raw of hostile) {
    assert.ok(!out.text.includes(raw), 'response must not contain ' + raw);
  }
  assert.ok(!out.text.includes('synthetic_secret_value'), 'no arbitrary suffix survives projection');
});

test('admin audit: every writer-emitted action is admitted exactly', async () => {
  // Guards the other direction: a real action must not be over-filtered into
  // "unknown". This list is the writer-derived vocabulary published in
  // INTERFACE.md; it is asserted here so a drift is a test failure, not a
  // silently blank feed.
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'security_reviewer');
  const actions = [
    'resource.register', 'resource.delete', 'key.create', 'key.revoke',
    'pairing.code.create', 'pairing.claim', 'grant.create', 'grant.revoke', 'settings.update',
    'catalog.upload.begin', 'catalog.upload.reject', 'catalog.upload.validate',
    'catalog.asset.revalidate', 'catalog.plan.create', 'catalog.deploy.execute', 'catalog.deploy.cancel',
    'dgm.preview.create', 'dgm.preview.pause', 'dgm.preview.resume', 'dgm.preview.cancel',
    'fabric.node.register', 'fabric.invitation.create', 'fabric.invitation.accept',
    'fabric.invitation.decline', 'fabric.invitation.revoke', 'fabric.connection.suspend',
    'fabric.connection.disconnect', 'fabric.connection.resume', 'fabric.preview.create',
    'fabric.approval.request', 'fabric.approval.approved', 'fabric.approval.rejected',
    'fabric.grant.commit', 'fabric.grant.revise', 'fabric.grant.pause', 'fabric.grant.resume',
    'fabric.grant.revoke', 'fabric.deny.create', 'fabric.deny.delete',
  ];
  for (let i = 0; i < actions.length; i++) {
    const mm = String(Math.floor(i / 60)).padStart(2, '0');
    const ss = String(i % 60).padStart(2, '0');
    await seedAudit(t, { id: 'a_v' + String(i).padStart(2, '0'), action: actions[i], at: '2026-11-01T00:' + mm + ':' + ss + '.000Z' });
  }
  const out = await readJson(await t.call(AUDIT + '?limit=50', { headers: t.as(t.alice) }));
  assert.equal(out.json.items.length, actions.length);
  for (const item of out.json.items) {
    assert.equal(item.action_known, true, item.id + ' should be a known action');
    assert.equal(item.category, item.action.slice(0, item.action.indexOf('.')));
  }
});

test('admin audit: pagination is bounded and deterministic under ties', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'security_reviewer');
  const same = '2026-11-01T09:00:00.000Z';
  await seedAudit(t, { id: 'a_2', at: same });
  await seedAudit(t, { id: 'a_1', at: same });
  await seedAudit(t, { id: 'a_3', at: same });
  const p1 = await readJson(await t.call(AUDIT + '?limit=2&offset=0', { headers: t.as(t.alice) }));
  assert.deepEqual(p1.json.items.map((i) => i.id), ['a_1', 'a_2'], 'ties resolve by id ASC');
  const p2 = await readJson(await t.call(AUDIT + '?limit=2&offset=2', { headers: t.as(t.alice) }));
  assert.deepEqual(p2.json.items.map((i) => i.id), ['a_3']);
  assert.equal(p1.json.total, 3);

  const capped = await readJson(await t.call(AUDIT + '?limit=999&offset=0', { headers: t.as(t.alice) }));
  assert.equal(capped.json.limit, 50, 'limit is clamped to MAX_PAGE_SIZE');
  const negOffset = await readJson(await t.call(AUDIT + '?limit=5&offset=-9', { headers: t.as(t.alice) }));
  assert.equal(negOffset.json.offset, 0, 'negative offset clamps to zero');
  const junk = await readJson(await t.call(AUDIT + '?limit=abc&offset=xyz', { headers: t.as(t.alice) }));
  assert.equal(junk.json.limit, 20);
  assert.equal(junk.json.offset, 0);
});

test('admin audit: DB failure is unavailable, distinct from an empty feed', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'security_reviewer');
  t.sqlite.exec('DROP TABLE audit');
  const out = await readJson(await t.call(AUDIT, { headers: t.as(t.alice) }));
  assert.equal(out.status, 200, 'authorized but honest about storage failure');
  assert.equal(out.json.state, 'unavailable');
  assert.equal(out.json.reason_code, 'audit_unavailable');
  assert.equal(out.json.total, null, 'never a fabricated zero');
  assert.deepEqual(out.json.items, []);
  assert.equal(out.json.observed_at, null);
});

test('admin audit: unauthorized callers learn nothing about row existence', async () => {
  const empty = await createTestEnv();
  const seeded = await createTestEnv();
  await seedAudit(seeded, { id: 'a_exists' });
  const a = await readJson(await empty.call(AUDIT, { headers: empty.as(empty.alice) }));
  const b = await readJson(await seeded.call(AUDIT, { headers: seeded.as(seeded.alice) }));
  assert.equal(a.status, 403);
  assert.equal(b.status, 403);
  assert.deepEqual(a.json, b.json, 'no existence oracle in the denial path');
});

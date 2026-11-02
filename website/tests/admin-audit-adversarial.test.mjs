/* Built with Meta Muse. */
// QA adversarial suite — authorized read-only Audit feed (`admin.audit.v1`).
//
// Owner: independent QA lane deepseek/admin-audit-adversarial-20261101.
// Contract: goose-evidence/admin-audit-20261101/author/INTERFACE.md.
// Contract amendment in force: GOOSE-ADMIN-AUDIT-CONTRACT-PRIVACY-1 (QA finding
// QA-CONTRACT-FINDING-1) — a recognized namespace plus the action grammar is NOT
// a fixed known-action projection. `resource.qa_secret_marker_9c1f` satisfies
// both and would publish arbitrary text. Required: exact action vocabulary
// derived from the current writers, or unknown/dynamic action -> null action.
//
// Every case maps to a stated contract clause; nothing here invents authority.
// Synthetic in-memory D1 fixtures only. No production data, no real grants, no
// secrets, no network. Test-only file: never imported by product code.
//
// Run against the author's READY commit:
//   node --test tests/admin-audit-adversarial.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createTestEnv, readJson } from './d1-shim.mjs';

const AUDIT = '/api/admin/v1/audit';
const CANON = '2026-11-01T12:00:00.000Z';
const ROLES = [
  'operations_observer', 'access_administrator', 'security_reviewer',
  'support_triager', 'engineering_reviewer', 'role_grant_authority',
];
const ITEM_KEYS = ['action', 'action_known', 'at', 'at_known', 'category', 'id'];

// Writer-derived audit action vocabulary (evidence: worker.js lines 772, 1135,
// 1158, 1196, 1599, 1983, 2173, 2307, 2406, 2548, 2603, 2775, 2787, 2843,
// 2942-2944, 2978; dgm/router.mjs:181; fabric/store.mjs:193/290/657/782/920).
// Every value below is passed as the `action` argument at an audit write site.
const OBSERVED_ACTIONS = [
  'catalog.asset.revalidate',
  'catalog.deploy.cancel',
  'catalog.deploy.execute',
  'catalog.plan.create',
  'catalog.upload.begin',
  'catalog.upload.reject',
  'catalog.upload.validate',
  'dgm.preview.create',
  'fabric.approval.approved',
  'fabric.approval.rejected',
  'fabric.grant.commit',
  'fabric.invitation.accept',
  'fabric.invitation.create',
  'fabric.preview.create',
  'grant.create',
  'grant.revoke',
  'key.create',
  'key.revoke',
  'pairing.claim',
  'pairing.code.create',
  'resource.delete',
  'resource.register',
  'settings.update',
];

// Same shape as a real action, but no writer emits it. Must never be echoed.
const MARKER = 'qa_secret_marker_9c1f';
const UNOBSERVED_ACTIONS = [
  'resource.' + MARKER,     // observed namespace, invented action — the hole
  'fabric.' + MARKER,
  'settings.' + MARKER,     // observed namespace, invented action
  'session.' + MARKER,      // allowlisted namespace with no writer at all
  'resource.event',         // plausible, still not writer-derived
];

// ---------------- fixtures ----------------

async function grant(t, userId, over = {}) {
  const row = {
    id: 'g_' + Math.random().toString(36).slice(2, 10),
    role: 'security_reviewer', scope: 'platform', expires_at: null, revoked_at: null, ...over,
  };
  await t.DB.prepare(
    'INSERT INTO admin_grants (id, user_id, role, scope, expires_at, created_at, created_by, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(row.id, userId, row.role, row.scope, row.expires_at, new Date().toISOString(), 'qa', row.revoked_at).run();
  return row;
}

async function updateGrant(t, id, over) {
  await t.DB.prepare(
    'UPDATE admin_grants SET role = ?, scope = ?, expires_at = ?, revoked_at = ? WHERE id = ?'
  ).bind(over.role, over.scope, over.expires_at, over.revoked_at, id).run();
}

async function seedAudit(t, rows) {
  for (const r of rows) {
    await t.DB.prepare(
      'INSERT INTO audit (id, at, actor_id, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(r.id, r.at, r.actor_id ?? 'u_seed', r.action, r.target ?? 't_seed', r.detail ?? '').run();
  }
}

async function mintKey(t, user, body) {
  const out = await readJson(await t.call('/api/keys', {
    method: 'POST', headers: { ...t.as(user), ...t.csrf }, body,
  }));
  assert.equal(out.status, 201, out.text);
  return out.json;
}

async function getAudit(t, query = '', headers = {}) {
  return readJson(await t.call(AUDIT + query, { headers }));
}

function failingDb(real, pattern) {
  // Test-only overlay: fail one statement family, leave the rest intact.
  return {
    prepare(sql) {
      if (pattern.test(sql)) throw new Error('synthetic d1 failure');
      return real.prepare(sql);
    },
    batch(...a) { return real.batch(...a); },
    exec(...a) { return real.exec(...a); },
  };
}

// ---------------- A. authority and denial uniformity ----------------

test('A1: anonymous is 401 AUTH_REQUIRED and carries no audit data', async () => {
  const t = await createTestEnv();
  await seedAudit(t, [{ id: 'a_1', at: CANON, action: 'resource.register' }]);
  const out = await getAudit(t);
  assert.equal(out.status, 401);
  assert.equal(out.json.code, 'AUTH_REQUIRED');
  assert.equal('items' in out.json, false, 'anonymous callers learn nothing about rows');
});

test('A2: authenticated session without a grant is 403 ADMIN_FORBIDDEN', async () => {
  const t = await createTestEnv();
  await seedAudit(t, [{ id: 'a_1', at: CANON, action: 'resource.register' }]);
  const out = await getAudit(t, '', t.as(t.alice));
  assert.equal(out.status, 403);
  assert.equal(out.json.code, 'ADMIN_FORBIDDEN');
  assert.equal('items' in out.json, false);
});

test('A3: only security_reviewer reads; the other five existing roles are denied', async () => {
  const t = await createTestEnv();
  await seedAudit(t, [{ id: 'a_role', at: CANON, action: 'resource.register' }]);
  const g = await grant(t, 'u_bob', { role: 'operations_observer' });
  const deniedBodies = [];
  for (const role of ROLES) {
    await updateGrant(t, g.id, { role, scope: 'platform', expires_at: null, revoked_at: null });
    const out = await getAudit(t, '', t.as(t.bob));
    if (role === 'security_reviewer') {
      assert.equal(out.status, 200, 'security_reviewer is the sole audit reader');
      assert.equal(out.json.schema_version, 'admin.audit.v1');
      assert.equal(out.json.state, 'available');
    } else {
      assert.equal(out.status, 403, role + ' must not read audit');
      assert.equal(out.json.code, 'ADMIN_FORBIDDEN', role);
      deniedBodies.push(JSON.stringify(out.json));
    }
  }
  assert.equal(new Set(deniedBodies).size, 1, 'every denial shares one body shape');
});

test('A4: a user API key is authenticated-but-denied (403), never 401', async () => {
  const t = await createTestEnv();
  await seedAudit(t, [{ id: 'a_k', at: CANON, action: 'resource.register' }]);
  const key = await mintKey(t, t.alice, { name: 'qa', scope: 'read' });
  const out = await getAudit(t, '', { Authorization: 'Bearer ' + key.secret });
  assert.equal(out.status, 403);
  assert.equal(out.json.code, 'ADMIN_FORBIDDEN');
});

test('A5: the demo tenant never administers, even with a mis-seeded grant', async () => {
  const t = await createTestEnv();
  await t.DB.prepare('UPDATE "user" SET demo = 1 WHERE id = ?').bind('u_bob').run();
  await grant(t, 'u_bob', { role: 'security_reviewer' });
  const out = await getAudit(t, '', t.as(t.bob));
  assert.equal(out.status, 403);
  assert.equal(out.json.code, 'ADMIN_FORBIDDEN');
});

test('A6-A10: expired, malformed, revoked, wrong-scope and unknown-role grants all deny', async () => {
  const t = await createTestEnv();
  await seedAudit(t, [{ id: 'a_g', at: CANON, action: 'resource.register' }]);
  const g = await grant(t, 'u_bob');
  const variants = [
    ['expired', { role: 'security_reviewer', scope: 'platform', expires_at: '2020-01-01T00:00:00.000Z', revoked_at: null }],
    ['malformed expiry', { role: 'security_reviewer', scope: 'platform', expires_at: 'not-a-date', revoked_at: null }],
    ['non-canonical expiry', { role: 'security_reviewer', scope: 'platform', expires_at: '2026-13-01T00:00:00.000Z', revoked_at: null }],
    ['revoked', { role: 'security_reviewer', scope: 'platform', expires_at: null, revoked_at: new Date().toISOString() }],
    ['wrong scope fabric', { role: 'security_reviewer', scope: 'fabric', expires_at: null, revoked_at: null }],
    ['wrong scope tenant', { role: 'security_reviewer', scope: 'tenant', expires_at: null, revoked_at: null }],
    ['empty scope', { role: 'security_reviewer', scope: '', expires_at: null, revoked_at: null }],
    ['unknown role', { role: 'superuser', scope: 'platform', expires_at: null, revoked_at: null }],
  ];
  const bodies = [];
  for (const [label, over] of variants) {
    await updateGrant(t, g.id, over);
    const out = await getAudit(t, '', t.as(t.bob));
    assert.equal(out.status, 403, label);
    assert.equal(out.json.code, 'ADMIN_FORBIDDEN', label);
    bodies.push(JSON.stringify(out.json));
  }
  assert.equal(new Set(bodies).size, 1, 'all eight variants share one denial body');
  await updateGrant(t, g.id, { role: 'security_reviewer', scope: 'platform', expires_at: null, revoked_at: null });
  assert.equal((await getAudit(t, '', t.as(t.bob))).status, 200, 'control grant is live');
});

test('A12: denial is identical with and without stored rows (no existence oracle)', async () => {
  // The caller holds no admin grant in either environment; the only variable
  // is whether audit rows exist. An authorized caller legitimately sees
  // different data, so authority must stay denied for the comparison to mean
  // anything. (First version granted bob in both envs and compared the whole
  // envelope, including observed_at — a defect in this test, not the server.)
  const empty = await createTestEnv();
  const emptyOut = await getAudit(empty, '', empty.as(empty.bob));

  const seeded = await createTestEnv();
  await seedAudit(seeded, [
    { id: 'a_x1', at: CANON, action: 'resource.register' },
    { id: 'a_x2', at: CANON, action: 'grant.create' },
  ]);
  const seededOut = await getAudit(seeded, '', seeded.as(seeded.bob));

  assert.equal(emptyOut.status, 403, 'no grant means denied whether or not rows exist');
  assert.equal(seededOut.status, 403);
  assert.deepEqual(emptyOut.json, seededOut.json, 'row existence must not change the denial');
});

// ---------------- B. per-request re-check ----------------

test('B1: revoking the grant between pages denies the next page', async () => {
  const t = await createTestEnv();
  await seedAudit(t, [
    { id: 'a_1', at: CANON, action: 'resource.register' },
    { id: 'a_2', at: '2026-11-01T11:00:00.000Z', action: 'grant.create' },
  ]);
  const g = await grant(t, 'u_bob');
  const first = await getAudit(t, '?limit=1&offset=0', t.as(t.bob));
  assert.equal(first.status, 200);
  assert.equal(first.json.items.length, 1);

  await updateGrant(t, g.id, { role: 'security_reviewer', scope: 'platform', expires_at: null, revoked_at: new Date().toISOString() });

  const second = await getAudit(t, '?limit=1&offset=1', t.as(t.bob));
  assert.equal(second.status, 403, 'revocation applies to the very next page');
  assert.equal(second.json.code, 'ADMIN_FORBIDDEN');
  assert.equal('items' in second.json, false);
});

test('B2: expiring the grant between pages denies the next page', async () => {
  const t = await createTestEnv();
  await seedAudit(t, [{ id: 'a_1', at: CANON, action: 'resource.register' }]);
  const g = await grant(t, 'u_bob');
  assert.equal((await getAudit(t, '', t.as(t.bob))).status, 200);
  await updateGrant(t, g.id, { role: 'security_reviewer', scope: 'platform', expires_at: '2020-01-01T00:00:00.000Z', revoked_at: null });
  const after = await getAudit(t, '', t.as(t.bob));
  assert.equal(after.status, 403);
  assert.equal(after.json.code, 'ADMIN_FORBIDDEN');
});

// ---------------- C. pagination and ordering ----------------

test('C1/C2/C3/C6: limit and offset are bounded, echoed and never 5xx', async () => {
  const t = await createTestEnv();
  await seedAudit(t, Array.from({ length: 60 }, (_, i) => ({
    id: 'a_p' + String(i).padStart(2, '0'),
    at: new Date(Date.parse(CANON) - i * 1000).toISOString(),
    action: 'resource.register',
  })));
  await grant(t, 'u_bob');
  const cases = [
    ['', 20, 0],
    ['?limit=1', 1, 0],
    ['?limit=50', 50, 0],
    ['?limit=51', 50, 0],
    ['?limit=1000000', 50, 0],
    ['?limit=-3', 1, 0],
    ['?limit=abc', 20, 0],
    ['?offset=-5', 20, 0],
    ['?offset=abc', 20, 0],
  ];
  for (const [q, limit, offset] of cases) {
    const out = await getAudit(t, q, t.as(t.bob));
    assert.equal(out.status, 200, q);
    assert.equal(out.json.limit, limit, 'limit for ' + q);
    assert.equal(out.json.offset, offset, 'offset for ' + q);
    assert.ok(out.json.items.length <= limit, 'items never exceed limit for ' + q);
    assert.ok(Number.isSafeInteger(out.json.total) && out.json.total >= 0, 'total is a measured integer for ' + q);
  }
  const zero = await getAudit(t, '?limit=0', t.as(t.bob));
  assert.equal(zero.status, 200);
  assert.ok(zero.json.limit >= 1 && zero.json.limit <= 50, 'limit=0 still resolves inside 1..50');
});

test('C4: identical timestamps keep a stable total order across pages', async () => {
  const t = await createTestEnv();
  const ids = ['a_t3', 'a_t1', 'a_t6', 'a_t2', 'a_t5', 'a_t4'];
  await seedAudit(t, ids.map((id) => ({ id, at: CANON, action: 'resource.register' })));
  await grant(t, 'u_bob');

  const seen = [];
  for (const offset of [0, 2, 4]) {
    const out = await getAudit(t, `?limit=2&offset=${offset}`, t.as(t.bob));
    assert.equal(out.status, 200);
    assert.equal(out.json.total, 6);
    seen.push(...out.json.items.map((i) => i.id));
  }
  assert.deepEqual(seen, ['a_t1', 'a_t2', 'a_t3', 'a_t4', 'a_t5', 'a_t6'],
    'at DESC, id ASC: ties resolve by id with no duplicate or gap');
});

test('C5: a beyond-end window is a measured empty page, not unavailable', async () => {
  const t = await createTestEnv();
  await seedAudit(t, [{ id: 'a_1', at: CANON, action: 'resource.register' }]);
  await grant(t, 'u_bob');
  const out = await getAudit(t, '?offset=500', t.as(t.bob));
  assert.equal(out.status, 200);
  assert.equal(out.json.state, 'available');
  assert.equal(out.json.total, 1);
  assert.equal(out.json.offset, 500);
  assert.deepEqual(out.json.items, []);
});

// ---------------- D. projection, malformed rows, availability ----------------

test('D1: an empty table is available with a measured zero', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_bob');
  const out = await getAudit(t, '', t.as(t.bob));
  assert.equal(out.status, 200);
  assert.equal(out.json.state, 'available');
  assert.equal(out.json.total, 0);
  assert.deepEqual(out.json.items, []);
});

test('D2/D3/D5: corrupt timestamps, malformed actions and invalid ids fail safe', async () => {
  const t = await createTestEnv();
  await seedAudit(t, [
    { id: 'a_ok', at: CANON, action: 'resource.register' },
    { id: 'a_bad_at', at: 'garbage', action: 'resource.register' },
    { id: 'a_empty_at', at: '', action: 'grant.create' },
    { id: 'a_bad_action', at: CANON, action: 'Resource.Register' },
    { id: 'a_no_dot', at: CANON, action: 'notanaction' },
    { id: 'a_markup', at: CANON, action: '<script>alert(1)</script>' },
    { id: '', at: CANON, action: 'resource.register' },
    { id: 'x'.repeat(128), at: CANON, action: 'resource.register' },
  ]);
  await grant(t, 'u_bob');
  const out = await getAudit(t, '?limit=50', t.as(t.bob));
  assert.equal(out.status, 200);
  assert.equal(out.json.total, 8, 'every stored row is counted, including skipped ones');
  assert.ok(out.json.items.length < 8, 'invalid-id rows are skipped from items');
  const byId = new Map(out.json.items.map((i) => [i.id, i]));
  assert.equal(byId.has(''), false, 'empty id is never rendered');
  assert.equal(byId.has('x'.repeat(128)), false, 'over-long id is never rendered');

  const badAt = byId.get('a_bad_at');
  assert.equal(badAt.at, null);
  assert.equal(badAt.at_known, false);
  const emptyAt = byId.get('a_empty_at');
  assert.equal(emptyAt.at, null);
  assert.equal(emptyAt.at_known, false);

  for (const id of ['a_bad_action', 'a_no_dot', 'a_markup']) {
    const it = byId.get(id);
    assert.ok(it, id + ' row is retained with a safe unknown action');
    assert.equal(it.action, null, id);
    assert.equal(it.action_known, false, id);
  }
  assert.equal(byId.get('a_ok').action, 'resource.register');
  assert.equal(byId.get('a_ok').category, 'resource');
  assert.equal(byId.get('a_ok').at, CANON, 'canonical timestamp is echoed exactly');
});

test('D6: the response exposes exactly the contracted keys and projection', async () => {
  const t = await createTestEnv();
  await seedAudit(t, [{ id: 'a_1', at: CANON, action: 'resource.register', target: '/x', detail: 'd', actor_id: 'u_a' }]);
  await grant(t, 'u_bob');
  const out = await getAudit(t, '', t.as(t.bob));
  assert.equal(out.status, 200);
  assert.equal(out.json.schema_version, 'admin.audit.v1');
  assert.deepEqual(out.json.projection.fields.slice().sort(), ITEM_KEYS.slice().sort());
  assert.deepEqual(out.json.projection.omitted.slice().sort(), ['actor_id', 'detail', 'target']);
  for (const item of out.json.items) {
    assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS.slice().sort(), 'no extra item keys');
  }
});

// ---------------- K. action vocabulary (contract amendment) ----------------

test('K1: an unobserved action is never echoed, even inside an observed namespace', async () => {
  const t = await createTestEnv();
  await seedAudit(t, UNOBSERVED_ACTIONS.map((action, i) => ({
    id: 'a_un' + String(i).padStart(2, '0'),
    at: new Date(Date.parse(CANON) - i * 1000).toISOString(),
    action,
  })));
  await grant(t, 'u_bob');
  const out = await getAudit(t, '?limit=50', t.as(t.bob));
  assert.equal(out.status, 200);
  assert.equal(out.json.total, UNOBSERVED_ACTIONS.length, 'rows are counted');

  const wire = JSON.stringify(out.json);
  assert.equal(wire.includes(MARKER), false,
    'a namespace-valid, grammar-valid action string must not be published as text');
  for (const action of UNOBSERVED_ACTIONS) {
    assert.equal(wire.includes(action), false, 'unobserved action echoed: ' + action);
  }
  for (const item of out.json.items) {
    assert.equal(item.action, null, 'unobserved action resolves to null: ' + item.id);
    assert.equal(item.action_known, false, item.id);
  }
});

test('K2: writer-derived actions stay known and are echoed exactly', async () => {
  const t = await createTestEnv();
  await seedAudit(t, OBSERVED_ACTIONS.map((action, i) => ({
    id: 'a_ob' + String(i).padStart(2, '0'),
    at: new Date(Date.parse(CANON) - i * 1000).toISOString(),
    action,
  })));
  await grant(t, 'u_bob');
  const out = await getAudit(t, '?limit=50', t.as(t.bob));
  assert.equal(out.status, 200);
  assert.equal(out.json.items.length, OBSERVED_ACTIONS.length, 'every writer action is projected');

  const byId = new Map(out.json.items.map((i) => [i.id, i]));
  OBSERVED_ACTIONS.forEach((action, i) => {
    const item = byId.get('a_ob' + String(i).padStart(2, '0'));
    assert.ok(item, 'missing row for ' + action);
    assert.equal(item.action, action, 'action echoed exactly: ' + action);
    assert.equal(item.action_known, true, 'writer-derived action is known: ' + action);
    assert.equal(item.category, action.split('.')[0], 'category is the safe namespace: ' + action);
  });
});

test('K3: a known action and an invented one in the same namespace are treated differently', async () => {
  const t = await createTestEnv();
  await seedAudit(t, [
    { id: 'a_pair_known', at: CANON, action: 'resource.register' },
    { id: 'a_pair_fake', at: '2026-11-01T11:59:00.000Z', action: 'resource.' + MARKER },
  ]);
  await grant(t, 'u_bob');
  const out = await getAudit(t, '?limit=10', t.as(t.bob));
  assert.equal(out.status, 200);
  const byId = new Map(out.json.items.map((i) => [i.id, i]));
  assert.equal(byId.get('a_pair_known').action_known, true, 'the real action is known');
  assert.equal(byId.get('a_pair_fake').action_known, false,
    'namespace membership alone must not make an action known');
  assert.equal(byId.get('a_pair_fake').action, null);
});

test('K4: category is always a bounded identifier, never row text', async () => {
  const t = await createTestEnv();
  await seedAudit(t, [
    ...OBSERVED_ACTIONS.map((action, i) => ({
      id: 'a_c' + String(i).padStart(2, '0'),
      at: new Date(Date.parse(CANON) - i * 1000).toISOString(),
      action,
    })),
    ...UNOBSERVED_ACTIONS.map((action, i) => ({
      id: 'a_cu' + String(i).padStart(2, '0'),
      at: new Date(Date.parse(CANON) - 100000 - i * 1000).toISOString(),
      action,
    })),
  ]);
  await grant(t, 'u_bob');
  const out = await getAudit(t, '?limit=50', t.as(t.bob));
  assert.equal(out.status, 200);
  assert.ok(out.json.items.length > 0);
  for (const item of out.json.items) {
    assert.match(item.category, /^[a-z][a-z0-9_]{0,31}$/, 'category is a bounded identifier');
    if (item.action_known) assert.equal(item.category, item.action.split('.')[0], item.id);
    else assert.equal(item.category, 'unknown', 'unknown action has an unknown category: ' + item.id);
  }
});

// ---------------- E. privacy ----------------

test('E1/E2/E3: identity- and secret-shaped target/detail/actor fields never reach the response', async () => {
  const t = await createTestEnv();
  const markers = [
    'alice@example.com', 'id_rsa', 'sk-live-QA-SECRET-TOKEN', 'hunter2-password',
    'issuer -> recipient', 'node-abcdef-123456', '{"private":"detail-json"}',
    '192.0.2.77', 'Bearer qa-token-value',
  ];
  await seedAudit(t, [
    {
      id: 'a_priv1', at: CANON, action: 'pairing.code.create',
      actor_id: 'alice@example.com',
      target: '/home/alice/.ssh/id_rsa',
      detail: 'sk-live-QA-SECRET-TOKEN hunter2-password issuer -> recipient node-abcdef-123456 {"private":"detail-json"} 192.0.2.77 Bearer qa-token-value',
    },
    { id: 'a_priv2', at: CANON, action: 'grant.create', actor_id: 'u_secret', target: 'alice@example.com', detail: 'id_rsa' },
    { id: 'a_priv3', at: CANON, action: 'resource.' + MARKER, target: MARKER, detail: MARKER },
  ]);
  await grant(t, 'u_bob');
  const out = await getAudit(t, '?limit=50', t.as(t.bob));
  assert.equal(out.status, 200);
  const wire = JSON.stringify(out.json);
  for (const marker of markers.concat([MARKER])) {
    assert.equal(wire.includes(marker), false, 'response leaked synthetic secret: ' + marker);
  }
  for (const item of out.json.items) {
    assert.equal('detail' in item, false);
    assert.equal('target' in item, false);
    assert.equal('actor_id' in item, false);
  }
});

// ---------------- F. failure honesty ----------------

test('F1/F3: an audit query failure is unavailable, never a healthy empty page', async () => {
  const t = await createTestEnv();
  await seedAudit(t, [{ id: 'a_1', at: CANON, action: 'resource.register' }]);
  await grant(t, 'u_bob');
  t.env.DB = failingDb(t.DB, /FROM\s+audit\b/i);
  const out = await getAudit(t, '', t.as(t.bob));
  assert.equal(out.status, 200, 'authority succeeded; the data source failed');
  assert.equal(out.json.state, 'unavailable');
  assert.equal(out.json.reason_code, 'audit_unavailable');
  assert.equal(out.json.observed_at, null);
  assert.equal(out.json.total, null, 'unavailable is never measured zero');
  assert.deepEqual(out.json.items, []);
  assert.equal(typeof out.json.limit, 'number');
  assert.equal(typeof out.json.offset, 'number');
});

test('F2: a failure establishing authority fails closed with 403, not a 200 envelope', async () => {
  const t = await createTestEnv();
  await seedAudit(t, [{ id: 'a_1', at: CANON, action: 'resource.register' }]);
  await grant(t, 'u_bob');
  t.env.DB = failingDb(t.DB, /admin_grants/i);
  const out = await getAudit(t, '', t.as(t.bob));
  assert.equal(out.status, 403);
  assert.equal(out.json.code, 'ADMIN_FORBIDDEN');
  assert.equal('items' in out.json, false);
});

test('G1: a non-GET method never returns audit rows', async () => {
  const t = await createTestEnv();
  await seedAudit(t, [{ id: 'a_1', at: CANON, action: 'resource.register' }]);
  await grant(t, 'u_bob');
  const out = await readJson(await t.call(AUDIT, { method: 'POST', headers: t.as(t.bob), body: {} }));
  assert.ok(out.status >= 400, 'POST must not be served as a read');
  assert.equal(out.json && 'items' in out.json, false);
});

// ---------------- U. UI contract ----------------

const adminSource = await readFile(new URL('../public/admin/admin.js', import.meta.url), 'utf8');

function makeEl(tag, id) {
  return {
    tag, id: id || null, dataset: {}, kids: {},
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false,
    listeners: {}, attrs: {}, hostSection: null,
    addEventListener(k, v) { this.listeners[k] = v; },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    querySelector(sel) { return this.kids[sel] || null; },
    closest(sel) { return sel === 'section' ? this.hostSection : null; },
    click() { if (this.listeners.click) this.listeners.click(); },
    focus() { this.focused = true; },
  };
}

function uiHarness(handler) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl('div', id));
    return elements.get(id);
  };
  const sections = {};
  for (const id of ['overview', 'resources', 'audit']) {
    const section = makeEl('section', id);
    const state = makeEl('p', null);
    section.kids['.state'] = state;
    sections[id] = { section, state };
    elements.set(id, section);
  }
  const buttons = ['overview', 'resources', 'audit'].map((id) => {
    const b = makeEl('button', null);
    const endpoint = '/api/admin/v1/' + id;
    b.attrs['data-endpoint'] = endpoint;
    b.dataset.endpoint = endpoint;
    b.hostSection = sections[id].section;
    return b;
  });
  const calls = [];
  const counts = new Map();
  const fetcher = async (path) => {
    const url = new URL(String(path), 'https://admin.local');
    calls.push(String(path));
    const n = (counts.get(url.pathname) || 0) + 1;
    counts.set(url.pathname, n);
    const out = await handler(url, n);
    if (out instanceof Error) throw out;
    return Response.json(out.body, { status: out.status });
  };
  const context = vm.createContext({
    document: {
      getElementById: el,
      querySelectorAll(sel) { return sel === 'button[data-endpoint]' ? buttons : []; },
      createElement(tag) { return makeEl(tag, null); },
    },
    fetch: fetcher,
    encodeURIComponent: globalThis.encodeURIComponent,
    setTimeout, clearTimeout,
    console,
  });
  vm.runInContext(adminSource, context, { filename: 'admin.js' });
  return { el, sections, buttons, calls };
}

const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function settleAfterAuditClick(h, what) {
  h.buttons[2].click();
  for (let i = 0; i < 100 && !h.calls.some((c) => c.startsWith(AUDIT)); i++) await flush(5);
  assert.ok(h.calls.some((c) => c.startsWith(AUDIT)), 'audit request issued: ' + what);
  await flush();
}

const STATUS_DENIED = () => ({ status: 401, body: { error: 'x', code: 'AUTH_REQUIRED' } });
const PROJ = { fields: ['id', 'action', 'category', 'at', 'action_known', 'at_known'], omitted: ['actor_id', 'target', 'detail'] };
const page = (items, total, offset = 0, limit = 20) => ({
  status: 200,
  body: { schema_version: 'admin.audit.v1', state: 'available', observed_at: CANON, items, total, limit, offset, projection: PROJ },
});

test('U1: audit rows are escaped; markup never becomes executable', async () => {
  const h = uiHarness((url) => {
    if (url.pathname === '/api/admin/v1/status') return STATUS_DENIED();
    if (url.pathname === AUDIT) return page([
      { id: 'a_<img src=x onerror=alert(1)>', action: 'resource.register', action_known: true, category: 'resource', at: CANON, at_known: true },
      { id: 'a_2', action: null, action_known: false, category: 'unknown', at: null, at_known: false },
    ], 2);
    return { status: 404, body: { code: 'NOT_FOUND' } };
  });
  await settleAfterAuditClick(h, 'available render');
  const html = h.el('audit-result').innerHTML;
  assert.equal(html.includes('<img src=x'), false, 'row markup is escaped');
  assert.ok(html.includes('&lt;img'), 'escaped id is still readable');
  assert.ok(html.includes('resource.register'), 'known action renders');
});

test('U2: empty audit is stated explicitly, not as a failure', async () => {
  const h = uiHarness((url) => {
    if (url.pathname === '/api/admin/v1/status') return STATUS_DENIED();
    if (url.pathname === AUDIT) return page([], 0);
    return { status: 404, body: { code: 'NOT_FOUND' } };
  });
  await settleAfterAuditClick(h, 'empty render');
  assert.ok(h.el('audit-result').textContent.includes('No audit events recorded'),
    'empty copy is explicit: ' + h.el('audit-result').textContent);
});

test('U3/U4: unavailable and denied are distinct, explicit and leave no stale rows', async () => {
  const unavailable = uiHarness((url) => {
    if (url.pathname === '/api/admin/v1/status') return STATUS_DENIED();
    if (url.pathname === AUDIT) {
      return { status: 200, body: { schema_version: 'admin.audit.v1', state: 'unavailable', reason_code: 'audit_unavailable', observed_at: null, items: [], total: null, limit: 20, offset: 0, projection: PROJ } };
    }
    return { status: 404, body: { code: 'NOT_FOUND' } };
  });
  await settleAfterAuditClick(unavailable, 'unavailable render');
  assert.ok(unavailable.sections.audit.state.textContent.includes('audit_unavailable'),
    'unavailable names its reason: ' + unavailable.sections.audit.state.textContent);
  assert.equal(unavailable.el('audit-result').innerHTML, '', 'unavailable never paints rows');

  const denied = uiHarness((url) => {
    if (url.pathname === '/api/admin/v1/status') return STATUS_DENIED();
    if (url.pathname === AUDIT) return { status: 403, body: { error: 'no', code: 'ADMIN_FORBIDDEN' } };
    return { status: 404, body: { code: 'NOT_FOUND' } };
  });
  await settleAfterAuditClick(denied, 'denied render');
  assert.ok(denied.sections.audit.state.textContent.includes('ADMIN_FORBIDDEN'),
    'denied names its code: ' + denied.sections.audit.state.textContent);
  assert.equal(denied.el('audit-result').innerHTML, '', 'denial never paints rows');
});

test('U5: a stale older success never paints over a newer page', async () => {
  let resolveFirst;
  const first = new Promise((r) => { resolveFirst = r; });
  const newer = page([{ id: 'a_new', action: 'grant.create', action_known: true, category: 'grant', at: CANON, at_known: true }], 2);
  const older = page([{ id: 'a_old', action: 'resource.register', action_known: true, category: 'resource', at: CANON, at_known: true }], 2);
  const h = uiHarness((url, n) => {
    if (url.pathname === '/api/admin/v1/status') return STATUS_DENIED();
    if (url.pathname === AUDIT) return n === 1 ? first : newer;
    return { status: 404, body: { code: 'NOT_FOUND' } };
  });
  h.buttons[2].click();
  for (let i = 0; i < 100 && !h.calls.some((c) => c.startsWith(AUDIT)); i++) await flush(5);
  await flush();
  h.buttons[2].click();
  for (let i = 0; i < 100; i++) {
    if (h.el('audit-result').innerHTML.includes('a_new')) break;
    await flush(5);
  }
  assert.ok(h.el('audit-result').innerHTML.includes('a_new'), 'newer page paints');
  resolveFirst(older);
  await flush(60);
  assert.equal(h.el('audit-result').innerHTML.includes('a_old'), false, 'stale success must not paint');
  assert.ok(h.el('audit-result').innerHTML.includes('a_new'), 'newer page remains');
});

test('U6: a sparse window reports shown count from offset+limit, not items.length alone', async () => {
  const h = uiHarness((url) => {
    if (url.pathname === '/api/admin/v1/status') return STATUS_DENIED();
    if (url.pathname === AUDIT) {
      return page([{ id: 'a_1', action: 'resource.register', action_known: true, category: 'resource', at: CANON, at_known: true }], 3);
    }
    return { status: 404, body: { code: 'NOT_FOUND' } };
  });
  await settleAfterAuditClick(h, 'sparse render');
  const label = h.el('audit-page-label').textContent;
  assert.ok(/shown/.test(label), 'sparse page names the shown count: ' + label);
  assert.ok(label.includes('(1 shown)'), 'reports 1 shown of 3: ' + label);
  assert.ok(label.includes('3'), 'names the measured total: ' + label);
});

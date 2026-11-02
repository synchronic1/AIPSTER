/* Built with Meta Muse. */
// Admin milestone 1 tests (failing-first): SAFE operational/harness
// visibility, coverage/readiness, and user directory/status, plus the
// read-only Audit projection. All rows and grants are disposable
// in-memory fixtures. No test performs a production mutation, enables
// inference, or exercises a revocation through the API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';

async function grant(t, userId, role) {
  const now = new Date().toISOString();
  await t.DB.prepare(
    'INSERT INTO admin_grants (id, user_id, role, scope, expires_at, created_at, created_by, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind('g_' + Math.random().toString(36).slice(2, 10), userId, role, 'platform', null, now, 'operator', null).run();
}

const COVERAGE_METRICS = [
  'incoming_requests', 'admitted_work', 'queue_depth', 'queue_wait_ms',
  'throughput_rps', 'throughput_tokens_per_s', 'latency_end_to_end_ms',
  'time_to_first_byte_ms', 'time_to_first_token_ms', 'token_usage_input',
  'token_usage_output', 'error_rate', 'retry_rate', 'hardware_utilization',
  'usable_capacity', 'cost',
];

test('admin coverage: full metric list with honest release states, never zeros', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'operations_observer');
  const out = await readJson(await t.call('/api/admin/v1/coverage', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.equal(out.json.schema_version, 'admin.coverage.v1');
  assert.equal(out.json.state, 'available');
  assert.ok(out.json.observed_at, 'coverage anchors to an observation time');
  assert.equal(out.json.total, COVERAGE_METRICS.length);
  const got = out.json.items.map((it) => it.metric).sort();
  assert.deepEqual(got, [...COVERAGE_METRICS].sort());
  for (const it of out.json.items) {
    assert.equal(it.value, null, it.metric + ' value stays null without a collector');
    assert.equal(it.observed_at, null, it.metric + ' has no successful observation');
    assert.ok(['not_instrumented', 'disabled'].includes(it.release_state), it.metric + ' names a truthful release state');
    assert.ok(typeof it.reason_code === 'string' && it.reason_code.length > 0, it.metric + ' explains the gap');
    assert.equal(it.collector, null, 'no collector exists to name');
  }
  const byMetric = Object.fromEntries(out.json.items.map((it) => [it.metric, it]));
  assert.equal(byMetric.admitted_work.release_state, 'disabled', 'execution-gated metrics report disabled inference');
  // Dispatch schema ships in-test (migrations 0024/0025) but stays dark
  // without INFERENCE_ENABLED, so the truthful reason names the dark flag.
  assert.equal(byMetric.admitted_work.reason_code, 'inference_dispatch_dark');
  assert.equal(byMetric.incoming_requests.release_state, 'not_instrumented');
});

test('admin operations health: real checks, distinct disabled/pending states', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'operations_observer');
  const out = await readJson(await t.call('/api/admin/v1/operations/health', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.equal(out.json.schema_version, 'admin.operations.health.v1');
  assert.equal(out.json.state, 'available');
  assert.ok(out.json.observed_at);
  assert.equal(out.json.control_plane.d1, 'reachable');
  assert.equal(out.json.control_plane.admin_grants, 'present');
  assert.equal(out.json.collectors.state, 'not_instrumented');
  assert.equal(out.json.collectors.reason_code, 'collector_missing');
  assert.equal(out.json.compatibility.inference, 'disabled');
  assert.equal(out.json.compatibility.inference_reason_code, 'inference_dispatch_dark');
  assert.equal(out.json.compatibility.fabric_model, 'pending');
});

test('admin directory: minimal identity projection, bounded pages, no secrets', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'access_administrator');
  const out = await readJson(await t.call('/api/admin/v1/access/users', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.equal(out.json.schema_version, 'admin.access.users.v1');
  assert.equal(out.json.state, 'available');
  assert.ok(out.json.total >= 2, 'seeded users are listed');
  const keys = Object.keys(out.json.items[0]).sort();
  assert.deepEqual(keys, ['admin_roles', 'email', 'id', 'keys_active', 'name', 'provider', 'sessions_active', 'status', 'tenant']);
  const blob = JSON.stringify(out.json.items);
  for (const banned of ['token', 'verifier', 'salt', 'password', 'ipAddress', 'userAgent', 'user_agent', 'ip_address']) {
    assert.ok(!blob.includes('"' + banned + '"'), banned + ' must stay out of the directory projection');
  }
  for (const it of out.json.items) {
    assert.ok(['github', 'credential', 'unknown'].includes(it.provider), 'provider is a bounded label: ' + it.provider);
    assert.ok(['active', 'suspended'].includes(it.status), 'status is a bounded label');
    assert.ok(['platform', 'demo'].includes(it.tenant), 'tenant is a bounded label');
    assert.ok(Array.isArray(it.admin_roles), 'live admin roles are disclosed per row');
  }
  const p1 = await readJson(await t.call('/api/admin/v1/access/users?limit=1&offset=0', { headers: t.as(t.alice) }));
  assert.equal(p1.json.items.length, 1);
  assert.equal(p1.json.total, out.json.total);
  assert.equal(p1.json.limit, 1);
  const capped = await readJson(await t.call('/api/admin/v1/access/users?limit=9999', { headers: t.as(t.alice) }));
  assert.equal(capped.json.limit, 50, 'directory pages clamp to the shared cap');
});

test('admin directory: suspension status, provider kinds, and live roles', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'access_administrator');
  await grant(t, 'u_bob', 'operations_observer');
  await t.DB.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').bind('u_bob').run();
  const now = new Date().toISOString();
  await t.DB.prepare(
    'INSERT INTO account (id, accountId, providerId, userId, accessToken, refreshToken, idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind('a_gh', 'gh-1', 'github', 'u_alice', 'SECRET-SHOULD-NEVER-SHOW', null, null, null, null, '', null, now, now).run();
  await t.DB.prepare(
    'INSERT INTO account (id, accountId, providerId, userId, accessToken, refreshToken, idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind('a_pw', 'u_bob', 'credential', 'u_bob', null, null, null, null, null, '', 'HASH-SHOULD-NEVER-SHOW', now, now).run();
  const out = await readJson(await t.call('/api/admin/v1/access/users', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  const byId = Object.fromEntries(out.json.items.map((it) => [it.id, it]));
  assert.equal(byId.u_bob.status, 'suspended', 'disabled flag surfaces as suspended');
  assert.equal(byId.u_alice.status, 'active');
  assert.equal(byId.u_alice.provider, 'github');
  assert.equal(byId.u_bob.provider, 'credential');
  assert.deepEqual(byId.u_bob.admin_roles, ['operations_observer']);
  const blob = JSON.stringify(out.json);
  assert.ok(!blob.includes('SECRET-SHOULD-NEVER-SHOW') && !blob.includes('HASH-SHOULD-NEVER-SHOW'), 'provider credentials never leak');
});

test('admin sessions: safe refs only, honest unknown presence', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'access_administrator');
  const out = await readJson(await t.call('/api/admin/v1/access/sessions', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.equal(out.json.schema_version, 'admin.access.sessions.v1');
  assert.equal(out.json.state, 'available');
  assert.ok(out.json.total >= 2, 'seeded sessions are listed');
  const keys = Object.keys(out.json.items[0]).sort();
  assert.deepEqual(keys, ['active', 'authentication_method', 'expires_at', 'id', 'issued_at', 'presence', 'presence_reason', 'user_id']);
  const blob = JSON.stringify(out.json.items);
  for (const banned of ['token', 'ipAddress', 'userAgent']) {
    assert.ok(!blob.includes('"' + banned + '"'), banned + ' must stay out of the session projection');
  }
  for (const it of out.json.items) {
    assert.equal(it.presence, 'unknown', 'no presence signal exists to claim online');
    assert.equal(it.presence_reason, 'no_presence_signal');
    assert.equal(typeof it.active, 'boolean');
  }
  // An expired session stays listed but inactive: expiry is honest, not deletion.
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  await t.DB.prepare(
    'INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind('s_expired1', past, 'tok-expired-1', past, past, '9.9.9.9', 'secret-agent', 'u_alice').run();
  const again = await readJson(await t.call('/api/admin/v1/access/sessions', { headers: t.as(t.alice) }));
  const expired = again.json.items.find((it) => it.id === 's_expired1');
  assert.ok(expired, 'expired sessions remain visible');
  assert.equal(expired.active, false);
});

test('admin milestone 1: denial matrix covers the new reads, no stale grants', async () => {
  const t = await createTestEnv();
  const paths = ['/api/admin/v1/coverage', '/api/admin/v1/operations/health', '/api/admin/v1/access/users', '/api/admin/v1/access/sessions', '/api/admin/v1/audit'];
  for (const p of paths) {
    const anon = await readJson(await t.call(p));
    assert.equal(anon.status, 401, p);
  }
  for (const p of paths) {
    const grantless = await readJson(await t.call(p, { headers: t.as(t.alice) }));
    assert.equal(grantless.status, 403, p);
    assert.equal(grantless.json.code, 'ADMIN_FORBIDDEN');
  }
  // Wrong roles stay separated: observer reads no directory, access admin reads no audit.
  await grant(t, 'u_alice', 'operations_observer');
  for (const p of ['/api/admin/v1/access/users', '/api/admin/v1/access/sessions', '/api/admin/v1/audit']) {
    const out = await readJson(await t.call(p, { headers: t.as(t.alice) }));
    assert.equal(out.status, 403, 'observer denied ' + p);
  }
  await grant(t, 'u_bob', 'access_administrator');
  for (const p of ['/api/admin/v1/coverage', '/api/admin/v1/audit']) {
    const out = await readJson(await t.call(p, { headers: t.as(t.bob) }));
    assert.equal(out.status, 403, 'access administrator denied ' + p);
  }
  // Revocation takes effect on the very next request: no stale cache.
  await t.DB.prepare('UPDATE admin_grants SET revoked_at = ? WHERE user_id = ?').bind(new Date().toISOString(), 'u_alice').run();
  const stale = await readJson(await t.call('/api/admin/v1/coverage', { headers: t.as(t.alice) }));
  assert.equal(stale.status, 403, 'revoked grant denies immediately');
});

test('admin directory: per-row read failure is unknown, never zero or empty', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'access_administrator');
  // Fail only the per-row lookups (provider, grants, keys, sessions). The
  // page query and the requireAdmin authority check must still succeed.
  const realPrepare = t.DB.prepare.bind(t.DB);
  t.DB.prepare = (sql) => {
    if (/FROM account/.test(sql)
      || /expires_at, revoked_at/.test(sql)
      || /key_verifiers/.test(sql)
      || /FROM session/.test(sql)) {
      throw new Error('per-row store down');
    }
    return realPrepare(sql);
  };
  const out = await readJson(await t.call('/api/admin/v1/access/users', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.equal(out.json.state, 'available', 'the page itself was measured');
  const byId = Object.fromEntries(out.json.items.map((it) => [it.id, it]));
  assert.equal(byId.u_alice.provider, 'unknown');
  assert.equal(byId.u_alice.admin_roles, null, 'failed grant read is not an empty role list');
  assert.equal(byId.u_alice.keys_active, null, 'failed key count is not zero');
  assert.equal(byId.u_alice.sessions_active, null, 'failed session count is not zero');
});

test('admin coverage: unreadable store is unavailable, not a missing schema', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'operations_observer');
  const realPrepare = t.DB.prepare.bind(t.DB);
  t.DB.prepare = (sql) => {
    if (/sqlite_master/.test(sql)) throw new Error('store down');
    return realPrepare(sql);
  };
  const out = await readJson(await t.call('/api/admin/v1/coverage', { headers: t.as(t.alice) }));
  assert.equal(out.json.state, 'unavailable', 'an unreadable store is not an available table');
  assert.equal(out.json.total, null, 'nothing was measured');
  assert.ok(out.json.reason_code, 'the gap names a reason');
});

test('admin health: failed dispatch schema read is unavailable, not missing', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'operations_observer');
  const realPrepare = t.DB.prepare.bind(t.DB);
  t.DB.prepare = (sql) => {
    const statement = realPrepare(sql);
    if (/sqlite_master/.test(sql)) {
      const realBind = statement.bind.bind(statement);
      statement.bind = (...args) => {
        const bound = realBind(...args);
        if (args[0] === 'dispatch_jobs') {
          bound.first = async () => { throw new Error('schema read failed'); };
        }
        return bound;
      };
    }
    return statement;
  };
  const out = await readJson(await t.call('/api/admin/v1/operations/health', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.equal(out.json.state, 'unavailable');
  assert.equal(out.json.reason_code, 'health_check_failed');
  assert.equal(out.json.compatibility, null, 'failed observation cannot assert missing schema');
  assert.equal(out.json.observed_at, null);
  t.DB.prepare = realPrepare;
  await t.DB.prepare('DROP TABLE dispatch_jobs').run();
  const missing = await readJson(await t.call('/api/admin/v1/operations/health', { headers: t.as(t.alice) }));
  assert.equal(missing.json.state, 'available', 'successful observation of absence stays distinct');
  assert.equal(missing.json.compatibility.inference_reason_code, 'dispatch_schema_missing');
});

test('admin directory: absent count rows are unknown, not measured zero', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'access_administrator');
  const realPrepare = t.DB.prepare.bind(t.DB);
  t.DB.prepare = (sql) => {
    if (/SELECT COUNT\(\*\) AS n FROM (key_verifiers|session)\b/.test(sql)) {
      return { bind: () => ({ first: async () => null }) };
    }
    return realPrepare(sql);
  };
  const out = await readJson(await t.call('/api/admin/v1/access/users', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.equal(out.json.state, 'available');
  assert.ok(out.json.items.length > 0);
  for (const row of out.json.items) {
    assert.equal(row.keys_active, null, 'missing key-count row is not a measured zero');
    assert.equal(row.sessions_active, null, 'missing session-count row is not a measured zero');
  }
});

test('admin directory: demo tenants never display exercisable admin roles', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'access_administrator');
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt, demo) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
    .bind('u_demo', 'Demo', 'demo@example.com', 1, null, now, now).run();
  await t.DB.prepare(
    'INSERT INTO admin_grants (id, user_id, role, scope, expires_at, created_at, created_by, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind('g_demo_live', 'u_demo', 'access_administrator', 'platform', null, now, 'operator', null).run();
  const out = await readJson(await t.call('/api/admin/v1/access/users', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  const byId = Object.fromEntries(out.json.items.map((it) => [it.id, it]));
  assert.equal(byId.u_demo.tenant, 'demo');
  assert.equal(byId.u_demo.admin_roles, null, 'demo tenants hold no exercisable admin role');
});

test('admin sessions: authentication method is declared missing, not absent', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'access_administrator');
  const out = await readJson(await t.call('/api/admin/v1/access/sessions', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.ok(out.json.items.length > 0, 'seeded sessions are listed');
  for (const it of out.json.items) {
    assert.ok('authentication_method' in it, 'auth method is a declared field (PRD ACC13)');
    assert.equal(it.authentication_method, null, 'uninstrumented auth method is null, never invented');
  }
});

test('admin coverage: deployment support is declared missing, not absent', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'operations_observer');
  const out = await readJson(await t.call('/api/admin/v1/coverage', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  for (const it of out.json.items) {
    assert.ok('supported_runtime' in it, 'runtime support is a declared field (PRD VIS07)');
    assert.equal(it.supported_runtime, null, 'unmeasured runtime support is null, never invented');
  }
});

test('admin operations health: worker versions and runtime readiness are declared', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'operations_observer');
  const out = await readJson(await t.call('/api/admin/v1/operations/health', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  const c = out.json.compatibility;
  assert.ok('worker_versions' in c, 'worker version compatibility is declared (PRD OPS01)');
  assert.equal(c.worker_versions, null, 'unmeasured worker versions are null, never healthy');
  assert.ok('runtime_readiness' in c, 'runtime readiness is declared (PRD OPS01)');
  assert.equal(c.runtime_readiness, null, 'unmeasured readiness is null, never healthy');
});

test('admin audit: read-only projection hides actor, target, and detail', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'security_reviewer');
  await t.DB.prepare('INSERT INTO audit (id, at, actor_id, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .bind('a_m1', new Date().toISOString(), 'u_bob', 'resource.register', 'r_secret_target', 'detail-with-secret').run();
  const out = await readJson(await t.call('/api/admin/v1/audit', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200);
  assert.equal(out.json.schema_version, 'admin.audit.v1');
  assert.equal(out.json.state, 'available');
  assert.equal(out.json.total, 1);
  const row = out.json.items[0];
  assert.equal(row.id, 'a_m1');
  assert.equal(row.action, 'resource.register');
  assert.ok(!('actor_id' in row) && !('target' in row) && !('detail' in row), 'identity and free-text columns never leave the database');
  assert.ok(!JSON.stringify(out.json).includes('r_secret_target'), 'target values never leak');
});

/* Built with Meta Muse. */
// Qualified deployment + durable jobs (Phase 3): AC14 (idempotent plans +
// receipt-driven states), AC15 (restart/resume), AC16 (reconnect gaps),
// AC17 (cancel/timeout/partial), AC18 (exhaustion + quotas), AC19 (gated),
// AC20 (revocation), AC21 (live worker API honestly absent). Fixture
// transport only; synthetic nodes; no network, no inference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from 'better-auth/crypto';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { fixtureSnapshot, fixtureSmallSnapshot } from '../src/lib/catalog/fixtures.mjs';
import { __resetFixtureTransport, __fixtureDispatchCount } from '../src/lib/catalog/transport.mjs';

const fx = () => createTestEnv({ CATALOG_FIXTURES: '1' });
const GGUF = 'fixture-org/tiny-instruct-gguf';
const RUNTIME = 'fixture-llama';
const SCRIPT = [{ status: 'staging' }, { status: 'verifying' }, { status: 'loading' }, { status: 'ready' }];
const sess = (t, user) => ({ ...t.as(user), ...t.csrf });

async function register(t, user, name) {
  const res = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: sess(t, user), body: { name, kind: 'local' },
  }));
  assert.equal(res.status, 201, res.text);
  return res.json;
}

async function report(t, nodeId, snapshot, ageMs = 1000) {
  const reportedAt = new Date(Date.now() - ageMs).toISOString();
  await t.DB.prepare('INSERT INTO node_capabilities (node_id, schema_version, reported_at, os, arch, runtimes_json, mem_json, disk_json, workload_json) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)')
    .bind(nodeId, reportedAt, snapshot.os, snapshot.arch, JSON.stringify(snapshot.runtimes), JSON.stringify(snapshot.mem), JSON.stringify(snapshot.disk), JSON.stringify(snapshot.workload))
    .run();
}

async function plan(t, user, body) {
  return readJson(await t.call('/api/catalog/plans', {
    method: 'POST', headers: sess(t, user),
    body: { assetRef: GGUF, runtime: RUNTIME, context: 2048, concurrency: 1, ...body },
  }));
}

async function execute(t, user, key, planToken) {
  return readJson(await t.call('/api/catalog/deployments', {
    method: 'POST', headers: sess(t, user), body: { idempotencyKey: key, planToken },
  }));
}

async function status(t, user, id) {
  return readJson(await t.call(`/api/catalog/deployments/${id}`, { headers: t.as(user) }));
}

async function grant(t, resourceId, granteeEmail) {
  const res = await readJson(await t.call('/api/grants', {
    method: 'POST', headers: sess(t, t.alice),
    body: { resourceId, grantee: granteeEmail, maxJobs: 5, maxTokens: 1000 },
  }));
  assert.equal(res.status, 201, res.text);
  return res.json;
}

async function seedDemo(t) {
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, username, displayUsername, demo, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('u_demo', 'Demo explorer', 'demo@aipster.invalid', 0, null, 'demo', 'demo', 1, now, now).run();
  const hash = await hashPassword('demo-test-password-01');
  await t.DB.prepare('INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('acc_demo_credential', 'u_demo', 'credential', 'u_demo', hash, now, now).run();
  const res = await t.call('/api/auth/sign-in/username', { method: 'POST', body: { username: 'demo', password: 'demo-test-password-01' } });
  const cookies = res.headers.getSetCookie();
  const session = cookies.find((c) => c && c.startsWith('better-auth.session_token='));
  assert.ok(session, 'demo sign-in sets a session cookie');
  return { Cookie: session.split(';')[0] };
}

test('AC14: same key + same plan replays the job; same key + other plan is a 409', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: SCRIPT });
  assert.equal(p.status, 201, p.text);
  const first = await execute(t, t.alice, 'op-key-100', p.json.planToken);
  assert.equal(first.status, 202, first.text);
  assert.equal(first.json.duplicate, false);
  assert.equal(first.json.state, 'admitted');
  const again = await execute(t, t.alice, 'op-key-100', p.json.planToken);
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.duplicate, true);
  assert.equal(again.json.id, first.json.id);
  const other = await plan(t, t.alice, { nodeId: node.id, context: 1024, fixtureScript: SCRIPT });
  assert.equal(other.status, 201, other.text);
  assert.notEqual(other.json.plan.planFingerprint, p.json.plan.planFingerprint);
  const clash = await execute(t, t.alice, 'op-key-100', other.json.planToken);
  assert.equal(clash.status, 409);
  assert.equal(clash.json.code, 'IDEMPOTENCY_MISMATCH');
  const list = await readJson(await t.call('/api/catalog/deployments', { headers: t.as(t.alice) }));
  assert.equal(list.json.items.filter((d) => d.id === first.json.id).length, 1);
});

test('AC14: tampered tokens rejected; plans bind to their principal', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: SCRIPT });
  assert.equal(p.status, 201, p.text);
  const bad = await execute(t, t.alice, 'op-tamper1', `${p.json.planToken.slice(0, -2)}xx`);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'BAD_PLAN');
  await grant(t, node.id, 'bob@example.com');
  const stolen = await execute(t, t.bob, 'op-steal-12', p.json.planToken);
  assert.equal(stolen.status, 400);
  assert.equal(stolen.json.code, 'BAD_PLAN');
});

test('AC14: blocked and unknown compat never produce a plan', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'small-box');
  await report(t, node.id, fixtureSmallSnapshot());
  // safetensors base on a gguf-only runtime row: blocked on format.
  const blocked = await plan(t, t.alice, { nodeId: node.id, assetRef: 'fixture-org/tiny-base' });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.json.code, 'COMPAT_NOT_MET');
  assert.ok(blocked.json.decision);
  const silent = await register(t, t.alice, 'silent-box');
  const unknown = await plan(t, t.alice, { nodeId: silent.id });
  assert.equal(unknown.status, 422, 'no telemetry: unknown compat cannot plan');
  assert.equal(unknown.json.code, 'COMPAT_NOT_MET');
});

test('AC14: admitted -> ready with an ordered, timestamped event trail', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: SCRIPT });
  const ex = await execute(t, t.alice, 'op-life-12', p.json.planToken);
  assert.equal(ex.status, 202, ex.text);
  const id = ex.json.id;
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    const s = await status(t, t.alice, id);
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json.reconciled, true);
    seen.push(s.json.state);
  }
  assert.deepEqual(seen, ['staging', 'verifying', 'loading', 'ready']);
  const full = await status(t, t.alice, id);
  assert.equal(full.json.reconciled, false, 'terminal reads reconcile nothing');
  assert.equal(full.json.reservation.state, 'held', 'ready keeps its reservation: weights occupy memory');
  const trail = full.json.events.map((e) => e.to_state);
  assert.deepEqual(trail, ['queued', 'admitted', 'staging', 'verifying', 'loading', 'ready']);
  const ts = full.json.events.map((e) => e.at);
  assert.deepEqual([...ts].sort(), ts, 'event timestamps are non-decreasing');
});

test('AC14: stale snapshot between plan and execute fails closed (cache never authorizes)', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: SCRIPT });
  assert.equal(p.status, 201, p.text);
  await t.DB.prepare('UPDATE node_capabilities SET reported_at = ? WHERE node_id = ?')
    .bind(new Date(Date.now() - 10 * 60 * 1000).toISOString(), node.id).run();
  const r = await execute(t, t.alice, 'op-stale-1', p.json.planToken);
  assert.equal(r.status, 422);
  assert.equal(r.json.code, 'COMPAT_NOT_MET');
});

test('AC15: worker restart resumes the same op; replayed receipts are no-ops', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: SCRIPT });
  const ex = await execute(t, t.alice, 'op-resume1', p.json.planToken);
  const id = ex.json.id;
  let s = await status(t, t.alice, id);
  assert.equal(s.json.state, 'staging');
  __resetFixtureTransport(); // simulated worker restart: durable rows stay, worker memory drops
  s = await status(t, t.alice, id);
  assert.equal(s.json.state, 'staging', 'replayed staging receipt is a no-op');
  assert.equal(s.json.reconciled, false, 'no durable change on replay');
  s = await status(t, t.alice, id);
  assert.equal(s.json.state, 'verifying');
  s = await status(t, t.alice, id);
  assert.equal(s.json.state, 'loading');
  s = await status(t, t.alice, id);
  assert.equal(s.json.state, 'ready');
  assert.equal(__fixtureDispatchCount(), 1, 'one op id resumed, never duplicated');
  const trail = s.json.events.map((e) => e.to_state);
  assert.deepEqual(trail, ['queued', 'admitted', 'staging', 'verifying', 'loading', 'ready']);
});

test('AC16: a job the worker never observes fails honestly; quiet workers fail too', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const lost = await plan(t, t.alice, { nodeId: node.id, fixtureScript: [] });
  const ex = await execute(t, t.alice, 'op-lost-12', lost.json.planToken);
  const s = await status(t, t.alice, ex.json.id);
  assert.equal(s.json.state, 'failed');
  assert.equal(s.json.error.code, 'RECONCILE_LOST');
  assert.match(s.json.error.detail, /reconciliation lost/);
  assert.equal(s.json.reservation.state, 'released');
  // Short script: the job advances once, then the quiet worker fails it.
  const short = await plan(t, t.alice, { nodeId: node.id, fixtureScript: [{ status: 'staging' }] });
  const ex2 = await execute(t, t.alice, 'op-quiet-1', short.json.planToken);
  const s2 = await status(t, t.alice, ex2.json.id);
  assert.equal(s2.json.state, 'staging');
  const s3 = await status(t, t.alice, ex2.json.id);
  assert.equal(s3.json.state, 'failed');
  assert.equal(s3.json.error.code, 'RECONCILE_LOST');
});

test('AC17: cancel, timeout, and partial failure all release with cleanup notes', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: SCRIPT });
  const ex = await execute(t, t.alice, 'op-cancel1', p.json.planToken);
  const c = await readJson(await t.call(`/api/catalog/deployments/${ex.json.id}/cancel`, { method: 'POST', headers: sess(t, t.alice) }));
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.state, 'cancelled');
  assert.equal(c.json.duplicate, false);
  assert.equal(c.json.reservation.state, 'released');
  const dup = await readJson(await t.call(`/api/catalog/deployments/${ex.json.id}/cancel`, { method: 'POST', headers: sess(t, t.alice) }));
  assert.equal(dup.json.duplicate, true, 'cancel replays on terminal jobs');

  const timeout = await plan(t, t.alice, {
    nodeId: node.id,
    fixtureScript: [{ status: 'failed', code: 'TIMEOUT', detail: 'stage timed out; partial weights removed' }],
  });
  const ex2 = await execute(t, t.alice, 'op-timeout', timeout.json.planToken);
  const s2 = await status(t, t.alice, ex2.json.id);
  assert.equal(s2.json.state, 'failed');
  assert.equal(s2.json.error.code, 'TIMEOUT');
  assert.match(s2.json.error.detail, /partial weights removed/);
  assert.equal(s2.json.reservation.state, 'released');

  const partial = await plan(t, t.alice, {
    nodeId: node.id,
    fixtureScript: [{ status: 'failed', code: 'LOAD_FAILED', detail: 'loader crashed; staging dir removed' }],
  });
  const ex3 = await execute(t, t.alice, 'op-partial', partial.json.planToken);
  const s3 = await status(t, t.alice, ex3.json.id);
  assert.equal(s3.json.state, 'failed');
  assert.match(s3.json.error.detail, /staging dir removed/);
});

test('AC18: byte exhaustion rejects the second near-full plan honestly', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  // ~7.45GB each against ~14GB: the first reserves, the second cannot fit.
  const a = await plan(t, t.alice, { nodeId: node.id, context: 4096, fixtureScript: SCRIPT });
  const b = await plan(t, t.alice, { nodeId: node.id, context: 4096, fixtureScript: SCRIPT });
  assert.equal(a.status, 201, a.text);
  assert.equal(b.status, 201, b.text);
  const first = await execute(t, t.alice, 'op-rsv-100', a.json.planToken);
  assert.equal(first.status, 202, first.text);
  const second = await execute(t, t.alice, 'op-rsv-200', b.json.planToken);
  assert.equal(second.status, 409);
  assert.equal(second.json.code, 'RESERVATION_EXHAUSTED');
  assert.ok(second.json.availableBytes < second.json.neededBytes);
});

test('AC18: per-node active cap rejects a third concurrent job', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const mk = async (key) => {
    const p = await plan(t, t.alice, { nodeId: node.id, context: 512, fixtureScript: SCRIPT });
    assert.equal(p.status, 201, p.text);
    return execute(t, t.alice, key, p.json.planToken);
  };
  assert.equal((await mk('op-cap-100')).status, 202);
  assert.equal((await mk('op-cap-200')).status, 202);
  const third = await mk('op-cap-300');
  assert.equal(third.status, 409);
  assert.equal(third.json.code, 'DEPLOYMENT_QUOTA');
});

test('AC19: gated weights are refused at plan time; nothing is auto-accepted', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const r = await plan(t, t.alice, { nodeId: node.id, assetRef: 'fixture-org/gated-clinical' });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'GATED_ACCESS_REQUIRED');
});

test('AC20: revoking the grant mid-flight fails the job on next poll', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const g = await grant(t, node.id, 'bob@example.com');
  const p = await plan(t, t.bob, { nodeId: node.id, fixtureScript: SCRIPT });
  assert.equal(p.status, 201, p.text);
  const ex = await execute(t, t.bob, 'op-revoke1', p.json.planToken);
  assert.equal(ex.status, 202, ex.text);
  const revoked = await readJson(await t.call(`/api/grants/${g.id}`, { method: 'DELETE', headers: sess(t, t.alice) }));
  assert.equal(revoked.status, 200, revoked.text);
  const s = await status(t, t.bob, ex.json.id);
  assert.equal(s.json.state, 'failed');
  assert.equal(s.json.error.code, 'REVOKED');
  assert.equal(s.json.reservation.state, 'released');
});

test('AC20: jobs are owner-visible only; listing never leaks', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: SCRIPT });
  const ex = await execute(t, t.alice, 'op-priv-12', p.json.planToken);
  const id = ex.json.id;
  assert.equal((await status(t, t.bob, id)).status, 404);
  const cancel = await readJson(await t.call(`/api/catalog/deployments/${id}/cancel`, { method: 'POST', headers: sess(t, t.bob) }));
  assert.equal(cancel.status, 404);
  const list = await readJson(await t.call('/api/catalog/deployments', { headers: t.as(t.bob) }));
  assert.ok(!list.json.items.some((d) => d.id === id));
});

test('AC21: demo accounts cannot plan, execute, or cancel', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const cookie = await seedDemo(t);
  const headers = { ...cookie, ...t.csrf };
  const p = await readJson(await t.call('/api/catalog/plans', {
    method: 'POST', headers, body: { assetRef: GGUF, nodeId: node.id, runtime: RUNTIME, context: 2048, concurrency: 1 },
  }));
  assert.equal(p.status, 403);
  assert.equal(p.json.code, 'DEMO_RESTRICTED');
  const ex = await readJson(await t.call('/api/catalog/deployments', {
    method: 'POST', headers, body: { idempotencyKey: 'op-demo-denied', planToken: 'x' },
  }));
  assert.equal(ex.status, 403);
  assert.equal(ex.json.code, 'DEMO_RESTRICTED');
});

test('AC21: live mode plans but cannot dispatch; nothing persists and scripts are refused', async () => {
  const t = await createTestEnv(); // no CATALOG_FIXTURES: no worker transport
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  // A validated private asset keeps this test offline: no Hub fetch.
  const now = new Date().toISOString();
  const sha = 'ab'.repeat(32);
  await t.DB.prepare('INSERT INTO catalog_assets (id, owner_id, source, repo, revision, kind, task, arch, format, quant, license_json, access, manifest_json, validation, freshness_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('livegguf', 'u_alice', 'private', 'local/live-gguf', sha, 'model', 'text-generation', 'llama', 'gguf', 'Q4_K_M', '{}', 'private', '{}', 'validated', now, now).run();
  await t.DB.prepare('INSERT INTO catalog_asset_files (asset_id, relpath, bytes, sha256) VALUES (?, ?, ?, ?)')
    .bind('livegguf', 'model.gguf', 1073741824, sha).run();
  const p = await plan(t, t.alice, { nodeId: node.id, assetRef: 'priv:livegguf' });
  assert.equal(p.status, 201, p.text);
  const ex = await execute(t, t.alice, 'op-live-12', p.json.planToken);
  assert.equal(ex.status, 503);
  assert.equal(ex.json.code, 'WORKER_API_UNAVAILABLE');
  const list = await readJson(await t.call('/api/catalog/deployments', { headers: t.as(t.alice) }));
  assert.equal(list.json.items.length, 0, 'refused dispatch persists nothing');
  const scripted = await plan(t, t.alice, { nodeId: node.id, assetRef: 'priv:livegguf', fixtureScript: SCRIPT });
  assert.equal(scripted.status, 400, 'scripted receipts are fixtures-only');
});

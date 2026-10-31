/* Built with Meta Muse. */
// Qualified deployment + durable jobs (Phase 3): AC14 (idempotent plans +
// receipt-driven states), AC15 (restart/resume), AC16 (reconnect gaps),
// AC17 (cancel/timeout/partial), AC18 (exhaustion + quotas), AC19 (gated),
// AC20 (revocation), AC21 (live worker API honestly absent). Fixture
// transport only; synthetic nodes; no network, no inference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from 'better-auth/crypto';
import { createTestEnv, readJson, TEST_SECRET } from './d1-shim.mjs';
import { fixtureSnapshot, fixtureSmallSnapshot } from '../src/lib/catalog/fixtures.mjs';
import { budgetWindow } from '../src/lib/quotas.js';
import { __resetFixtureTransport, __fixtureDispatchCount, __fixtureUncancel, __fixtureAckCancel, __fixtureWasCancelled, workerTransport } from '../src/lib/catalog/transport.mjs';

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
  // Review F9: cancel pends for worker ack (the old sync-terminal
  // expectation encoded the defect this test now pins as fixed).
  assert.equal(c.json.state, 'cancelling');
  assert.equal(c.json.duplicate, false);
  assert.equal(c.json.reservation.state, 'held');
  const dup = await readJson(await t.call(`/api/catalog/deployments/${ex.json.id}/cancel`, { method: 'POST', headers: sess(t, t.alice) }));
  assert.equal(dup.json.duplicate, true, 'cancel replays while unacknowledged');
  const done = await status(t, t.alice, ex.json.id);
  assert.equal(done.json.state, 'cancelled');
  assert.equal(done.json.reservation.state, 'released');

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

// ---- Review round (code F1-F4/F6/F7/F9, sec F3/F8/F14/F12-age) ----
// Deterministic repros for the independent-review findings. Race tests
// use a one-shot DB gate (same fault-injection idea as the fabric
// revision fixtures): hold request A inside its write, run B to
// completion, release A, assert the serialized outcome.

// gateDbOnce wraps a test-env DB so the FIRST run()/batch() whose SQL
// matches `pattern` waits at a gate; everything else passes through.
function gateDbOnce(db, pattern) {
  let entered;
  const enteredP = new Promise((r) => { entered = r; });
  let release;
  const gate = new Promise((r) => { release = r; });
  let fired = false;
  const hold = () => { if (!fired) { fired = true; entered(); return gate; } return null; };
  const wrapStmt = (raw, sql) => ({
    raw, sql,
    bind: (...p) => wrapStmt(raw.bind(...p), sql),
    first: (...p) => raw.first(...p),
    all: (...p) => raw.all(...p),
    run: async (...p) => {
      if (pattern.test(sql)) { const g = hold(); if (g) await g; }
      return raw.run(...p);
    },
  });
  return {
    db: {
      prepare: (sql) => wrapStmt(db.prepare(sql), sql),
      exec: (sql) => db.exec(sql),
      batch: async (stmts) => {
        const raw = stmts.map((s) => (s && s.raw) || s);
        if (stmts.some((s) => pattern.test((s && s.sql) || ''))) { const g = hold(); if (g) await g; }
        return db.batch(raw);
      },
    },
    entered: enteredP,
    release: () => release(),
  };
}

test('F1: stale status write loses to concurrent cancel (no resurrection, no silent release)', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: SCRIPT });
  const ex = await execute(t, t.alice, 'op-f1-race1', p.json.planToken);
  const id = ex.json.id;
  const gate = gateDbOnce(t.env.DB, /UPDATE catalog_deployments SET state/);
  t.env.DB = gate.db;
  const pending = t.call(`/api/catalog/deployments/${id}`, { headers: t.as(t.alice) });
  await gate.entered; // status is held inside its transition write
  const cancel = await readJson(await t.call(`/api/catalog/deployments/${id}/cancel`, { method: 'POST', headers: sess(t, t.alice) }));
  assert.ok(['cancelled', 'cancelling'].includes(cancel.json.state), `cancel lands first: ${cancel.text}`);
  gate.release();
  const st = await readJson(await pending);
  assert.equal(st.status, 200, st.text);
  assert.ok(['cancelled', 'cancelling'].includes(st.json.state), `stale staging write must lose, got ${st.json.state}`);
  const trail = st.json.events.map((e) => e.to_state);
  assert.ok(!trail.includes('staging'), `no staging event lands over the cancel: ${trail.join(',')}`);
  assert.equal(st.json.reservation.state, 'held', 'capacity stays held, never silently released');
});

test('F2: concurrent same-key executes replay instead of 500', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: SCRIPT });
  assert.equal(p.status, 201, p.text);
  const gate = gateDbOnce(t.env.DB, /INSERT INTO catalog_deployments/);
  t.env.DB = gate.db;
  const body = { idempotencyKey: 'op-f2-race12', planToken: p.json.planToken };
  const a = t.call('/api/catalog/deployments', { method: 'POST', headers: sess(t, t.alice), body });
  await gate.entered; // A held inside its admit batch
  const b = await readJson(await t.call('/api/catalog/deployments', { method: 'POST', headers: sess(t, t.alice), body }));
  assert.equal(b.status, 202, b.text);
  gate.release();
  const ar = await readJson(await a);
  assert.equal(ar.status, 200, ar.text);
  assert.equal(ar.json.duplicate, true);
  assert.equal(ar.json.id, b.json.id, 'loser replays the winner, same job identity');
});

test('F3: revocation tells the worker to stop (best-effort) and labels uncertainty', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const g = await grant(t, node.id, 'bob@example.com');
  const p = await plan(t, t.bob, { nodeId: node.id, fixtureScript: SCRIPT });
  const ex = await execute(t, t.bob, 'op-f3-revoke1', p.json.planToken);
  const opId = ex.json.plan.opId;
  await readJson(await t.call(`/api/grants/${g.id}`, { method: 'DELETE', headers: sess(t, t.alice) }));
  const s = await status(t, t.bob, ex.json.id);
  assert.equal(s.json.error.code, 'REVOKED');
  assert.match(s.json.error.detail, /UNCONFIRMED/, 'revocation never claims the worker stopped');
  assert.match(s.json.error.detail, /speculative/, 'speculative release is labeled');
  assert.ok(!s.json.error.detail.includes('worker told to stop'), 'no false cancel claim');
  const { __fixtureWasCancelled } = await import('../src/lib/catalog/transport.mjs');
  assert.equal(typeof __fixtureWasCancelled, 'function', 'fake exposes cancel introspection');
  assert.equal(__fixtureWasCancelled(opId), true, 'revocation sends best-effort cancel');
});

test('F3: reconcile-lost and worker-terminal paths stop asserting unverified cleanup', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const lost = await plan(t, t.alice, { nodeId: node.id, fixtureScript: [] });
  const ex = await execute(t, t.alice, 'op-f3-lost-12', lost.json.planToken);
  const s = await status(t, t.alice, ex.json.id);
  assert.match(s.json.error.detail, /UNKNOWN/, 'quiet worker means unknown partial state');
  assert.match(s.json.error.detail, /speculative/);
  assert.ok(!s.json.error.detail.includes('cleaned up'), 'no cleanup claim without evidence');
  const timeout = await plan(t, t.alice, {
    nodeId: node.id,
    fixtureScript: [{ status: 'failed', code: 'TIMEOUT', detail: 'stage timed out' }],
  });
  const ex2 = await execute(t, t.alice, 'op-f3-time12', timeout.json.planToken);
  const s2 = await status(t, t.alice, ex2.json.id);
  assert.match(s2.json.error.detail, /NOT verified/, 'server never claims removal it did not perform');
  assert.ok(!s2.json.error.detail.includes('partial artifacts removed'));
});

test('F4: summary active count matches the quota definition (ready excluded)', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: SCRIPT });
  const ex = await execute(t, t.alice, 'op-f4-ready12', p.json.planToken);
  for (let i = 0; i < 4; i += 1) await status(t, t.alice, ex.json.id);
  const p2 = await plan(t, t.alice, { nodeId: node.id, context: 512, fixtureScript: SCRIPT });
  await execute(t, t.alice, 'op-f4-admit12', p2.json.planToken);
  const s = await readJson(await t.call('/api/catalog/summary', { headers: t.as(t.alice) }));
  assert.equal(s.json.activeDeployments, 1, 'one admitted counts; the ready job does not');
});

test('F6: primary adapter without explicit base binding is refused', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const c = await readJson(await t.call('/api/catalog/compat', {
    method: 'POST', headers: sess(t, t.alice),
    body: { repo: 'fixture-org/tiny-lora', nodeId: node.id, runtime: RUNTIME, context: 2048, concurrency: 1 },
  }));
  assert.equal(c.status, 400, c.text);
  assert.equal(c.json.code, 'ADAPTER_BASE_REQUIRED');
  const p = await plan(t, t.alice, { nodeId: node.id, assetRef: 'fixture-org/tiny-lora' });
  assert.equal(p.status, 400, p.text);
  assert.equal(p.json.code, 'ADAPTER_BASE_REQUIRED');
});

async function mintRawPlanToken(t, nodeId, asset) {
  // Hand-minted plan token (test-only): proves execute-time checks that no
  // plan route would mint for. Mirrors the v1 token contract.
  const now = Date.now();
  const payload = {
    v: 1, principal: 'u_alice', asset, adapter: null, base: null, nodeId,
    runtime: RUNTIME, context: 2048, concurrency: 1, estimateTotalBytes: 1,
    snapshotAt: new Date().toISOString(), compatFingerprint: {}, fixtureScript: null,
    iat: now, exp: now + 600000, planFingerprint: 'fp-f7-handmint',
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`catalog-plan-v1:${TEST_SECRET}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))).toString('base64url');
  return `${body}.${sig}`;
}

test('F7: execute re-checks gated rights (plan/execute TOCTOU closed)', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const token = await mintRawPlanToken(t, node.id, {
    ref: 'fixture-org/gated-clinical', id: 'hub:fixture-org/gated-clinical',
    revision: 'c'.repeat(40), totalBytes: 9663676416,
  });
  const ex = await execute(t, t.alice, 'op-f7-gated12', token);
  assert.equal(ex.status, 403, ex.text);
  assert.equal(ex.json.code, 'GATED_ACCESS_REQUIRED');
});

test('F9: cancel requests ack; worker ack completes the cancel', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: SCRIPT });
  const ex = await execute(t, t.alice, 'op-f9-cancel1', p.json.planToken);
  const id = ex.json.id;
  const c = await readJson(await t.call(`/api/catalog/deployments/${id}/cancel`, { method: 'POST', headers: sess(t, t.alice) }));
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.state, 'cancelling', 'cancel pends until the worker acknowledges');
  assert.equal(c.json.duplicate, false);
  assert.equal(c.json.reservation.state, 'held', 'capacity held while cancel is unacknowledged');
  const s = await status(t, t.alice, id);
  assert.equal(s.json.state, 'cancelled');
  assert.equal(s.json.reservation.state, 'released');
  const trail = s.json.events.map((e) => e.to_state);
  assert.deepEqual(trail, ['queued', 'admitted', 'cancelling', 'cancelled']);
});

test('F9: load finishing first wins honestly over cancel (ready kept, held)', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: [{ status: 'ready' }] });
  const ex = await execute(t, t.alice, 'op-f9-race-12', p.json.planToken);
  const id = ex.json.id;
  await readJson(await t.call(`/api/catalog/deployments/${id}/cancel`, { method: 'POST', headers: sess(t, t.alice) }));
  __fixtureUncancel(ex.json.plan.opId); // cancel request lost: worker finishes
  const s = await status(t, t.alice, id);
  assert.equal(s.json.state, 'ready', 'cancel best-effort: a finished load is ready, not cancelled');
  assert.equal(s.json.reservation.state, 'held');
  assert.ok(s.json.events.some((e) => /finished before cancel landed/.test(e.detail)), 'race is recorded honestly');
});

test('F9: unacknowledged cancel stays pending with capacity held', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: [] });
  const ex = await execute(t, t.alice, 'op-f9-quiet12', p.json.planToken);
  const id = ex.json.id;
  await readJson(await t.call(`/api/catalog/deployments/${id}/cancel`, { method: 'POST', headers: sess(t, t.alice) }));
  __fixtureUncancel(ex.json.plan.opId); // cancel request lost: worker silent
  const s = await status(t, t.alice, id);
  assert.equal(s.json.state, 'cancelling', 'silence never completes a cancel');
  assert.equal(s.json.reservation.state, 'held');
  assert.ok(s.json.events.some((e) => /unacknowledged/.test(e.detail)));
});

test('F9: late receipts on terminal jobs are audited, never applied', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, {
    nodeId: node.id,
    fixtureScript: [{ status: 'failed', code: 'TIMEOUT', detail: 'stage timed out' }, { status: 'staging' }],
  });
  const ex = await execute(t, t.alice, 'op-f9-late-12', p.json.planToken);
  const id = ex.json.id;
  const s1 = await status(t, t.alice, id);
  assert.equal(s1.json.state, 'failed');
  const s2 = await status(t, t.alice, id);
  assert.equal(s2.json.state, 'failed', 'late receipt never resurrects');
  assert.ok(s2.json.events.some((e) => /late receipt/.test(e.detail)), 'late receipt is audited');
  const s3 = await status(t, t.alice, id);
  assert.equal(s3.json.events.length, s2.json.events.length, 'consecutive identical late notes are not spammed');
});

test('S-F3/S-F8: malformed and oversized fixture scripts are refused at plan intake', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const typed = await plan(t, t.alice, { nodeId: node.id, fixtureScript: [{ status: 'staging', detail: 12345 }] });
  assert.equal(typed.status, 400, typed.text);
  const coded = await plan(t, t.alice, { nodeId: node.id, fixtureScript: [{ status: 'failed', code: 999 }] });
  assert.equal(coded.status, 400, coded.text);
  const big = await plan(t, t.alice, { nodeId: node.id, fixtureScript: [{ status: 'staging', detail: 'x'.repeat(7000) }] });
  assert.equal(big.status, 400, big.text);
  assert.match(big.json.error, /too large/i, 'fail fast instead of minting a token the server refuses');
});

test('S-F14: stale cross-boundary grants authorize nothing', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  await grant(t, node.id, 'bob@example.com');
  // Stale cross-boundary row: the owner later became demo. The grantee is
  // a real user, so only the grant-side check can stop this (404).
  await t.DB.prepare('UPDATE "user" SET demo = 1 WHERE id = ?').bind('u_alice').run();
  const p = await plan(t, t.bob, { nodeId: node.id, fixtureScript: SCRIPT });
  assert.equal(p.status, 404, p.text);
});

test('F12-age: reservation hold start is visible on the job', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: SCRIPT });
  const ex = await execute(t, t.alice, 'op-f12-age12', p.json.planToken);
  const s = await status(t, t.alice, ex.json.id);
  assert.ok(s.json.reservation.heldSince, 'hold start timestamp present');
  assert.ok(Number.isFinite(Date.parse(s.json.reservation.heldSince)));
});

test('N4: admission checks the re-evaluated estimate, not just the plan figure', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  const snap = fixtureSnapshot();
  await report(t, node.id, snap);
  // Job 1 holds capacity, so execute-time availability sits strictly below
  // the compat-time effective figure both evaluations see.
  const p1 = await plan(t, t.alice, { nodeId: node.id, fixtureScript: SCRIPT });
  const ex1 = await execute(t, t.alice, 'op-n4-hold1', p1.json.planToken);
  assert.equal(ex1.status, 202, ex1.text);
  const held = ex1.json.reservation.bytes;
  const effective = snap.mem.gpu[0].vramAvailBytes;
  const avail = effective - held;
  assert.ok(avail > 0 && avail < effective, `hold narrows availability: ${avail} of ${effective}`);
  // Private asset with small weights; the plan-time estimate fits.
  const now = new Date().toISOString();
  const sha = 'cd'.repeat(32);
  const W1 = 200 * 1024 * 1024;
  await t.DB.prepare('INSERT INTO catalog_assets (id, owner_id, source, repo, revision, kind, task, arch, format, quant, license_json, access, manifest_json, validation, freshness_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('n4asset', 'u_alice', 'private', 'local/n4', sha, 'model', 'text-generation', 'llama', 'gguf', 'Q4_K_M', '{}', 'private', '{}', 'validated', now, now).run();
  await t.DB.prepare('INSERT INTO catalog_asset_files (asset_id, relpath, bytes, sha256) VALUES (?, ?, ?, ?)')
    .bind('n4asset', 'model.gguf', W1, sha).run();
  const p2 = await plan(t, t.alice, { nodeId: node.id, assetRef: 'priv:n4asset', fixtureScript: SCRIPT });
  assert.equal(p2.status, 201, p2.text);
  const E1 = p2.json.plan.estimateTotalBytes;
  assert.ok(E1 <= avail, `plan-time estimate ${E1} fits post-hold availability ${avail}`);
  // Weights grow between plan and execute. Target the window where compat
  // still passes (budget <= effective) but the hold no longer fits.
  const GiB = 1024 * 1024 * 1024;
  const kv = 2 * 32 * 4096 * 2 * 2048 * 1; // kvCacheBytes at context 2048, concurrency 1
  const target = avail + Math.floor((effective - avail) / 2);
  const W2 = Math.ceil(((target / 1.15) - kv - 2 * GiB) / 1.1);
  const E2 = Math.ceil((W2 + Math.ceil(W2 * 0.1) + kv + 2 * GiB) * 1.15);
  assert.ok(E2 > avail && E2 <= effective, `grown estimate ${E2} lands in (${avail}, ${effective}]`);
  assert.ok(W2 < snap.disk.availBytes, 'staging still fits disk');
  await t.DB.prepare('UPDATE catalog_asset_files SET bytes = ? WHERE asset_id = ?').bind(W2, 'n4asset').run();
  const ex2 = await execute(t, t.alice, 'op-n4-grow2', p2.json.planToken);
  assert.equal(ex2.status, 409, ex2.text);
  assert.equal(ex2.json.code, 'RESERVATION_EXHAUSTED');
  assert.equal(ex2.json.neededBytes, E2);
});

test('N3: transition events carry deterministic marker ids', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: SCRIPT });
  const ex = await execute(t, t.alice, 'op-n3-marker1', p.json.planToken);
  const s = await status(t, t.alice, ex.json.id);
  assert.equal(s.json.state, 'staging');
  const ev = s.json.events.find((e) => e.to_state === 'staging');
  assert.equal(ev.id, `ev_${ex.json.id}_admitted_staging`);
});

test('N3: a loser racing toward failed commits no event and no release', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: [{ status: 'bogus-receipt' }] });
  const ex = await execute(t, t.alice, 'op-n3-loserelease1', p.json.planToken);
  const id = ex.json.id;
  const gate = gateDbOnce(t.env.DB, /UPDATE catalog_deployments SET state/);
  t.env.DB = gate.db;
  const pending = t.call(`/api/catalog/deployments/${id}`, { headers: t.as(t.alice) });
  await gate.entered; // status is held inside its admitted→failed batch
  const cancel = await readJson(await t.call(`/api/catalog/deployments/${id}/cancel`, { method: 'POST', headers: sess(t, t.alice) }));
  assert.equal(cancel.json.state, 'cancelling', cancel.text);
  gate.release();
  const st = await readJson(await pending);
  assert.equal(st.status, 200, st.text);
  assert.equal(st.json.state, 'cancelling');
  assert.ok(!st.json.events.some((e) => e.to_state === 'failed'), 'loser commits no failed event');
  assert.equal(st.json.reservation.state, 'held', 'loser releases nothing');
});

test('N1: cancelling past the quiet threshold fails with its reservation held', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: [] });
  const ex = await execute(t, t.alice, 'op-n1-quiethold1', p.json.planToken);
  const id = ex.json.id;
  const cancel = await readJson(await t.call(`/api/catalog/deployments/${id}/cancel`, { method: 'POST', headers: sess(t, t.alice) }));
  assert.equal(cancel.json.state, 'cancelling');
  __fixtureUncancel(ex.json.plan.opId); // cancel request lost: worker silent
  const early = await status(t, t.alice, id);
  assert.equal(early.json.state, 'cancelling', 'a fresh quiet cancel still waits');
  await t.DB.prepare('UPDATE catalog_deployments SET updated_at = ? WHERE id = ?').bind(new Date(Date.now() - 61000).toISOString(), id).run();
  const late = await status(t, t.alice, id);
  assert.equal(late.json.state, 'failed', late.text);
  assert.equal(late.json.error.code, 'CANCEL_UNCONFIRMED');
  assert.match(late.json.error.detail, /UNKNOWN/, 'execution state is honestly unknown');
  assert.match(late.json.error.detail, /HELD/, 'capacity stays held, never speculatively freed');
  assert.equal(late.json.reservation.state, 'held');
});

test('N1: a late cancel ack releases the held reservation (unconfirmed-cancel)', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: [] });
  const ex = await execute(t, t.alice, 'op-n1-lateack1', p.json.planToken);
  const id = ex.json.id;
  await readJson(await t.call(`/api/catalog/deployments/${id}/cancel`, { method: 'POST', headers: sess(t, t.alice) }));
  __fixtureUncancel(ex.json.plan.opId);
  await t.DB.prepare('UPDATE catalog_deployments SET updated_at = ? WHERE id = ?').bind(new Date(Date.now() - 61000).toISOString(), id).run();
  const failed = await status(t, t.alice, id);
  assert.equal(failed.json.state, 'failed', failed.text);
  assert.equal(failed.json.error.code, 'CANCEL_UNCONFIRMED');
  __fixtureAckCancel(ex.json.plan.opId); // the quiet worker finally answers
  const reconciled = await status(t, t.alice, id);
  assert.equal(reconciled.json.state, 'failed');
  assert.equal(reconciled.json.reservation.state, 'released', 'authoritative ack frees the hold');
  assert.ok(reconciled.json.events.some((e) => /acknowledged late/.test(e.detail)), 'release is audited');
});

test('N1: revoking access releases an unconfirmed-cancel hold', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const g = await grant(t, node.id, 'bob@example.com');
  const p = await plan(t, t.bob, { nodeId: node.id, fixtureScript: [] });
  const ex = await execute(t, t.bob, 'op-n1-revoke1', p.json.planToken);
  const id = ex.json.id;
  await readJson(await t.call(`/api/catalog/deployments/${id}/cancel`, { method: 'POST', headers: sess(t, t.bob) }));
  __fixtureUncancel(ex.json.plan.opId);
  await t.DB.prepare('UPDATE catalog_deployments SET updated_at = ? WHERE id = ?').bind(new Date(Date.now() - 61000).toISOString(), id).run();
  const failed = await status(t, t.bob, id);
  assert.equal(failed.json.state, 'failed', failed.text);
  assert.equal(failed.json.error.code, 'CANCEL_UNCONFIRMED');
  assert.equal(failed.json.reservation.state, 'held');
  await readJson(await t.call(`/api/grants/${g.id}`, { method: 'DELETE', headers: sess(t, t.alice) }));
  const reconciled = await status(t, t.bob, id);
  assert.equal(reconciled.json.reservation.state, 'released', 'lost access frees the hold');
  assert.ok(reconciled.json.events.some((e) => /access revoked after unconfirmed cancel/.test(e.detail)));
});

test('N2: fixture peek does not consume', async () => {
  __resetFixtureTransport();
  const tr = workerTransport({ CATALOG_FIXTURES: '1' });
  await tr.dispatch({ opId: 'wop_peek1', jobId: 'dep_x', nodeId: 'r_y', script: [{ status: 'staging' }] });
  assert.equal((await tr.peek('wop_peek1')).status, 'staging');
  assert.equal((await tr.peek('wop_peek1')).status, 'staging');
  assert.equal((await tr.poll('wop_peek1')).status, 'staging');
  assert.equal((await tr.poll('wop_peek1')).status, 'unknown');
});

test('N2: concurrent readers serialize receipt consumption (loser consumes nothing)', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: [{ status: 'staging' }, { status: 'verifying' }] });
  const ex = await execute(t, t.alice, 'op-n2-race1', p.json.planToken);
  const id = ex.json.id;
  const gate = gateDbOnce(t.env.DB, /UPDATE catalog_deployments SET state/);
  t.env.DB = gate.db;
  const pending = t.call(`/api/catalog/deployments/${id}`, { headers: t.as(t.alice) });
  await gate.entered; // A held inside its admitted→staging batch
  const bst = await status(t, t.alice, id); // B wins the same receipt
  assert.equal(bst.json.state, 'staging', bst.text);
  gate.release();
  const ast = await readJson(await pending);
  assert.equal(ast.json.state, 'staging');
  assert.ok(!ast.json.events.some((e) => e.to_state === 'failed'), 'loser fails nothing spuriously');
  const third = await status(t, t.alice, id); // the second receipt survived the race
  assert.equal(third.json.state, 'verifying', third.text);
});

test('N6: a cancel that loses its race sends no worker-cancel flag', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: [{ status: 'failed', code: 'LOAD_FAILED', detail: 'loader crashed' }] });
  const ex = await execute(t, t.alice, 'op-n6-nolinger1', p.json.planToken);
  const id = ex.json.id;
  const opId = ex.json.plan.opId;
  const gate = gateDbOnce(t.env.DB, /UPDATE catalog_deployments SET state/);
  t.env.DB = gate.db;
  const pending = t.call(`/api/catalog/deployments/${id}/cancel`, { method: 'POST', headers: sess(t, t.alice) });
  await gate.entered; // cancel held inside its admitted→cancelling batch
  const st = await status(t, t.alice, id); // terminalizes first (failed on its own script)
  assert.ok(['failed', 'cancelled'].includes(st.json.state), st.text);
  gate.release();
  const lost = await readJson(await pending);
  assert.ok(['failed', 'cancelled'].includes(lost.json.state), lost.text);
  assert.equal(lost.json.duplicate, true);
  assert.equal(__fixtureWasCancelled(opId), false, 'lost cancel sends no worker-cancel flag');
  const again = await status(t, t.alice, id);
  assert.ok(!again.json.events.some((e) => e.detail.includes('late receipt') && e.detail.includes('cancelled')), 'no phantom late-cancel audit');
});

test('N7: repeat cancel while cancelling replays without a self-transition', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: SCRIPT });
  const ex = await execute(t, t.alice, 'op-n7-cancel2', p.json.planToken);
  const id = ex.json.id;
  const first = await readJson(await t.call(`/api/catalog/deployments/${id}/cancel`, { method: 'POST', headers: sess(t, t.alice) }));
  assert.equal(first.json.state, 'cancelling');
  const n0 = first.json.events.length;
  const second = await readJson(await t.call(`/api/catalog/deployments/${id}/cancel`, { method: 'POST', headers: sess(t, t.alice) }));
  assert.equal(second.json.state, 'cancelling');
  assert.equal(second.json.duplicate, true);
  assert.equal(second.json.events.length, n0, 'no cancelling→cancelling event lands');
});

test('Codex-sec-P2: spent write budgets reject plan creation before any write', async () => {
  const t = await fx();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  await t.DB.prepare('INSERT OR REPLACE INTO write_budget (user_id, window, count) VALUES (?, ?, ?)')
    .bind('u_alice', budgetWindow(), 120).run();
  const p = await plan(t, t.alice, { nodeId: node.id });
  assert.equal(p.status, 429, p.text);
  assert.equal(p.json.code, 'WRITE_RATE_LIMITED');
  const audits = await t.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE actor_id = ? AND action = 'catalog.plan.create'").bind('u_alice').first('n');
  assert.equal(audits, 0, 'no per-plan audit row escapes the budget');
});

test('Codex-sec-P2: spent write budgets reject deployment admission before any write', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'big-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: SCRIPT });
  assert.equal(p.status, 201, p.text);
  await t.DB.prepare('INSERT OR REPLACE INTO write_budget (user_id, window, count) VALUES (?, ?, ?)')
    .bind('u_alice', budgetWindow(), 120).run();
  const d = await execute(t, t.alice, 'op-key-budget-1', p.json.planToken);
  assert.equal(d.status, 429, d.text);
  assert.equal(d.json.code, 'WRITE_RATE_LIMITED');
  const rows = await t.DB.prepare('SELECT COUNT(*) AS n FROM catalog_deployments WHERE owner_id = ?').bind('u_alice').first('n');
  assert.equal(rows, 0, 'no deployment, reservation, or event rows escape the budget');
});

test('Codex-P2: deleting a resource removes its capability snapshot and reservations', async () => {
  const t = await fx();
  __resetFixtureTransport();
  const node = await register(t, t.alice, 'doomed-box');
  await report(t, node.id, fixtureSnapshot());
  const p = await plan(t, t.alice, { nodeId: node.id, fixtureScript: SCRIPT });
  assert.equal(p.status, 201, p.text);
  const d = await execute(t, t.alice, 'op-key-doom-1', p.json.planToken);
  assert.equal(d.status, 202, d.text);
  const del = await readJson(await t.call(`/api/inventory/${node.id}`, { method: 'DELETE', headers: sess(t, t.alice) }));
  assert.equal(del.status, 200, del.text);
  const snap = await t.DB.prepare('SELECT COUNT(*) AS n FROM node_capabilities WHERE node_id = ?').bind(node.id).first('n');
  assert.equal(snap, 0, 'capability snapshot goes with its resource (no FK orphan)');
  const res = await t.DB.prepare('SELECT COUNT(*) AS n FROM catalog_reservations WHERE node_id = ?').bind(node.id).first('n');
  assert.equal(res, 0, 'reservations go with their node');
});

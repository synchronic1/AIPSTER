/* Built with Meta Muse. */
// DGM fixture-preview API tests: flag gating, denial matrix, fixture
// outcomes, transitions, disabled actions, budgets, live caps, telemetry
// end-to-end, redaction, and readiness. All fixtures are in-memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createTestEnv, readJson, applyMigrations, MIGRATION_FILES } from './d1-shim.mjs';
import { budgetWindow } from '../src/lib/quotas.js';

const FLAG = { DGM_PREVIEW_ENABLED: '1' };
const BASE = '/api/admin/v1/dgm/preview';
let grantSeq = 0;

async function grant(t, userId, role) {
  const now = new Date().toISOString();
  await t.DB.prepare(
    'INSERT INTO admin_grants (id, user_id, role, scope, expires_at, created_at, created_by, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(`g_dgm${++grantSeq}`, userId, role, 'platform', null, now, 'operator', null).run();
}

async function seedDemo(t) {
  const now = new Date().toISOString();
  const token = randomBytes(32).toString('hex');
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, username, displayUsername, demo, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('u_demo', 'Synthetic Demo', 'demo@aipster.invalid', 0, null, 'demo', 'demo', 1, now, now).run();
  const future = new Date(Date.now() + 12 * 3600e3).toISOString();
  await t.DB.prepare('INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('s_demo01', future, token, now, now, null, 'test', 'u_demo').run();
  return { id: 'u_demo', token };
}

async function mintKey(t, user, body) {
  const out = await readJson(await t.call('/api/keys', { method: 'POST', headers: { ...t.as(user), ...t.csrf }, body }));
  assert.equal(out.status, 201, out.text);
  return out.json;
}

const ALL_ROUTES = [
  ['GET', `${BASE}/status`],
  ['GET', `${BASE}/runs`],
  ['POST', `${BASE}/runs`],
  ['GET', `${BASE}/runs/run_v1_unknown`],
  ['POST', `${BASE}/runs/run_v1_unknown/pause`],
  ['POST', `${BASE}/runs/run_v1_unknown/resume`],
  ['POST', `${BASE}/runs/run_v1_unknown/cancel`],
  ['POST', `${BASE}/runs/run_v1_unknown/promote`],
  ['POST', `${BASE}/runs/run_v1_unknown/execute`],
  ['POST', `${BASE}/runs/run_v1_unknown/reserve`],
  ['POST', `${BASE}/runs/run_v1_unknown/final-audit`],
  ['POST', `${BASE}/runs/run_v1_unknown/advise-live`],
  ['GET', `${BASE}/nope`]
];

async function callRoute(t, method, path, headers = {}) {
  return readJson(await t.call(path + '', {
    method,
    headers,
    ...(method === 'POST' ? { body: method === 'POST' && path.endsWith('/runs') ? { fixture: 'good' } : {} } : {})
  }));
}

test('dgm api: flag off keeps the slice dark without leaking existence', async () => {
  const t = await createTestEnv();
  await grant(t, 'u_alice', 'operations_observer');
  const authed = await readJson(await t.call(`${BASE}/status`, { headers: t.as(t.alice) }));
  assert.equal(authed.status, 404);
  assert.equal(authed.json.code, 'NOT_FOUND');
  const anon = await readJson(await t.call(`${BASE}/status`));
  assert.equal(anon.status, 401);
  const grantless = await readJson(await t.call(`${BASE}/status`, { headers: t.as(t.bob) }));
  assert.equal(grantless.status, 403);
  assert.equal(grantless.json.code, 'ADMIN_FORBIDDEN');
});

test('dgm api: anonymous callers get 401 on every preview route', async () => {
  const t = await createTestEnv(FLAG);
  for (const [method, path] of ALL_ROUTES) {
    const out = await callRoute(t, method, path);
    assert.equal(out.status, 401, `${method} ${path}`);
    assert.equal(out.json.code, 'AUTH_REQUIRED');
  }
});

test('dgm api: sessions without the preview permission get uniform 403, authz before CSRF', async () => {
  const t = await createTestEnv(FLAG);
  for (const [method, path] of ALL_ROUTES) {
    const out = await callRoute(t, method, path, t.as(t.alice));
    assert.equal(out.status, 403, `${method} ${path}`);
    assert.equal(out.json.code, 'ADMIN_FORBIDDEN');
  }
  // Wrong-role grant (directory admin) is still denied everywhere.
  await grant(t, 'u_alice', 'access_administrator');
  for (const [method, path] of ALL_ROUTES) {
    const out = await callRoute(t, method, path, { ...t.as(t.alice), ...t.csrf });
    assert.equal(out.status, 403, `${method} ${path}`);
    assert.equal(out.json.code, 'ADMIN_FORBIDDEN');
  }
});

test('dgm api: API keys and demo sessions never authorize preview', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  const read = await mintKey(t, t.alice, { name: 'r', scope: 'read' });
  const inf = await mintKey(t, t.alice, { name: 'i', scope: 'inference' });
  for (const secret of [read.secret, inf.secret]) {
    for (const [method, path] of [['GET', `${BASE}/status`], ['POST', `${BASE}/runs`]]) {
      const out = await callRoute(t, method, path, { Authorization: 'Bearer ' + secret });
      assert.equal(out.status, 403, `${method} ${path}`);
      assert.equal(out.json.code, 'ADMIN_FORBIDDEN');
    }
  }
  const demo = await seedDemo(t);
  await grant(t, 'u_demo', 'operations_observer');
  const denied = await readJson(await t.call(`${BASE}/status`, { headers: t.as(demo) }));
  assert.equal(denied.status, 403);
  assert.equal(denied.json.code, 'ADMIN_FORBIDDEN');
});

test('dgm api: query-string tokens grant nothing', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  for (const path of [`${BASE}/status?token=u_alice`, `${BASE}/runs?token=operator`]) {
    const out = await readJson(await t.call(path));
    assert.equal(out.status, 401, path);
  }
});

test('dgm api: observer and engineering roles hold the preview permission', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  await grant(t, 'u_bob', 'engineering_reviewer');
  for (const user of [t.alice, t.bob]) {
    const out = await readJson(await t.call(`${BASE}/status`, { headers: t.as(user) }));
    assert.equal(out.status, 200, user.id);
    assert.equal(out.json.evaluation, 'fixture');
  }
});

test('dgm api: status reports the fixture binding and run count', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  const before = await readJson(await t.call(`${BASE}/status`, { headers: t.as(t.alice) }));
  assert.equal(before.status, 200);
  assert.equal(before.json.schema, 'aipster.dgm.preview/v1');
  assert.equal(before.json.evaluation, 'fixture');
  assert.equal(before.json.binding.state, 'active');
  assert.equal(before.json.binding.target, 'coord-jobs-v0');
  assert.deepEqual(before.json.fixtures, ['good', 'bad-advice', 'over-budget', 'corrupt-receipt']);
  assert.deepEqual(before.json.states,
    ['validation-rejected', 'paused', 'cancelled', 'failed', 'completed-preview']);
  assert.equal(before.json.runs, 0);
  await readJson(await t.call(`${BASE}/runs`, {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { fixture: 'good' }
  }));
  const after = await readJson(await t.call(`${BASE}/status`, { headers: t.as(t.alice) }));
  assert.equal(after.json.runs, 1);
});

test('dgm api: create yields deterministic fixture outcomes', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  const create = (body) => t.call(`${BASE}/runs`, {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body
  }).then(readJson);
  const good = await create({ fixture: 'good' });
  assert.equal(good.status, 201);
  assert.equal(good.json.evaluation, 'fixture');
  assert.equal(good.json.status, 'completed-preview');
  assert.equal(good.json.envelopeLabel, 'VALIDATED');
  assert.ok(good.json.gates.every((g) => g.passed));
  assert.equal(good.json.provenance.archive.length, 2);
  assert.match(good.json.runId, /^run_v1_[0-9a-f]{8}$/);
  assert.match(good.json.taskId, /^task_v1_[0-9a-f]{8}$/);
  const bad = await create({ fixture: 'bad-advice' });
  assert.equal(bad.json.status, 'validation-rejected');
  assert.equal(bad.json.adviceReason, 'adviser_version_mismatch');
  const over = await create({ fixture: 'over-budget' });
  assert.equal(over.json.status, 'validation-rejected');
  assert.equal(over.json.budgetReason, 'advice_partition_exhausted');
  const corrupt = await create({ fixture: 'corrupt-receipt' });
  assert.equal(corrupt.json.status, 'failed');
  assert.equal(corrupt.json.settlement, 'stale_receipt');
  const held = await create({ fixture: 'good', held: true });
  assert.equal(held.status, 201);
  assert.equal(held.json.status, 'paused');
  assert.equal(held.json.held, true);
  // Held has no effect on rejected runs.
  const heldBad = await create({ fixture: 'bad-advice', held: true });
  assert.equal(heldBad.json.status, 'validation-rejected');
});

test('dgm api: replaying the same body gives identical gates and provenance', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  const create = () => t.call(`${BASE}/runs`, {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { fixture: 'good' }
  }).then(readJson);
  const a = (await create()).json;
  const b = (await create()).json;
  assert.notEqual(a.runId, b.runId);
  assert.notEqual(a.taskId, b.taskId);
  assert.deepEqual(a.gates, b.gates);
  assert.deepEqual(a.provenance, b.provenance);
});

test('dgm api: create bodies are fail-closed with typed refusals', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  const create = (body) => t.call(`${BASE}/runs`, {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body
  }).then(readJson);
  assert.equal((await create({ fixture: 'good', seed: 'x' })).json.code, 'DGM_OVERRIDE');
  assert.equal((await create({ fixture: 'good', budgets: {} })).json.code, 'DGM_OVERRIDE');
  assert.equal((await create({ fixture: 'good', typo: 1 })).json.code, 'DGM_BAD_BODY');
  assert.equal((await create({ fixture: 'nope' })).json.code, 'DGM_BAD_FIXTURE');
  assert.equal((await create({ fixture: 'good', held: 'yes' })).json.code, 'DGM_BAD_BODY');
  assert.equal((await create({ fixture: 'good', label: 'x'.repeat(129) })).json.code, 'DGM_BAD_BODY');
  assert.equal((await create({ fixture: 'good', target: 'other-v0' })).json.code, 'DGM_UNKNOWN_TARGET');
  const ok = await create({ fixture: 'good', target: 'coord-jobs-v0' });
  assert.equal(ok.status, 201);
  const runs = await t.DB.prepare('SELECT COUNT(*) AS n FROM dgm_preview_runs').first('n');
  assert.equal(runs, 1, 'refused creates write nothing');
});

test('dgm api: list paginates run summaries; get returns runs plus live telemetry', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  const headers = { ...t.as(t.alice), ...t.csrf };
  const ids = [];
  for (const fixture of ['good', 'bad-advice', 'corrupt-receipt']) {
    const out = await readJson(await t.call(`${BASE}/runs`, { method: 'POST', headers, body: { fixture } }));
    assert.equal(out.status, 201);
    ids.push(out.json.runId);
  }
  const page = await readJson(await t.call(`${BASE}/runs?limit=2&offset=0`, { headers: t.as(t.alice) }));
  assert.equal(page.status, 200);
  assert.equal(page.json.total, 3);
  assert.equal(page.json.items.length, 2);
  assert.deepEqual(Object.keys(page.json.items[0]).sort(),
    ['createdAt', 'envelopeLabel', 'fixture', 'runId', 'status']);
  const page2 = await readJson(await t.call(`${BASE}/runs?limit=2&offset=2`, { headers: t.as(t.alice) }));
  assert.equal(page2.json.items.length, 1);
  const detail = await readJson(await t.call(`${BASE}/runs/${ids[0]}`, { headers: t.as(t.alice) }));
  assert.equal(detail.status, 200);
  assert.equal(detail.json.runId, ids[0]);
  assert.equal(detail.json.evaluation, 'fixture');
  assert.ok(Array.isArray(detail.json.events) && detail.json.events.length >= 5);
  assert.ok(detail.json.events.every((e) => !e.event.startsWith('telemetry.')));
  assert.equal(detail.json.telemetry.env, 'fixture');
  assert.equal(detail.json.telemetry.readStatus, 'ok');
  assert.deepEqual(detail.json.telemetry.outcomeCounts, { succeeded: 1 });
  const missing = await readJson(await t.call(`${BASE}/runs/run_v1_doesnotexist`, { headers: t.as(t.alice) }));
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'NOT_FOUND');
});

test('dgm api: pause, resume, and cancel walk the held edges; anything else is 409', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  const headers = { ...t.as(t.alice), ...t.csrf };
  const create = (body) => t.call(`${BASE}/runs`, { method: 'POST', headers, body }).then(readJson);
  const act = (id, action) => t.call(`${BASE}/runs/${id}/${action}`, { method: 'POST', headers }).then(readJson);
  const held = (await create({ fixture: 'good', held: true })).json;
  assert.equal((await act(held.runId, 'resume')).json.status, 'completed-preview');
  const reheld = await act(held.runId, 'pause');
  assert.equal(reheld.json.status, 'paused');
  assert.equal((await act(held.runId, 'cancel')).json.status, 'cancelled');
  // Terminal runs refuse every transition.
  for (const action of ['pause', 'resume', 'cancel']) {
    const out = await act(held.runId, action);
    assert.equal(out.status, 409, action);
    assert.equal(out.json.code, 'DGM_PREVIEW_STATE');
  }
  const done = (await create({ fixture: 'good' })).json;
  assert.equal((await act(done.runId, 'resume')).status, 409);
  assert.equal((await act(done.runId, 'cancel')).status, 409);
  const missing = await act('run_v1_doesnotexist', 'pause');
  assert.equal(missing.status, 404);
  // Provenance never mutates across transitions.
  const before = (await create({ fixture: 'good', held: true })).json;
  const after = await act(before.runId, 'resume');
  assert.deepEqual(after.json.provenance, before.provenance);
});

test('dgm api: disabled actions always refuse before lookup, identically for unknown ids', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  const headers = { ...t.as(t.alice), ...t.csrf };
  const created = await readJson(await t.call(`${BASE}/runs`, { method: 'POST', headers, body: { fixture: 'good' } }));
  assert.equal(created.status, 201);
  const eventsBefore = await t.DB.prepare('SELECT COUNT(*) AS n FROM dgm_preview_events').first('n');
  const auditBefore = await t.DB.prepare('SELECT COUNT(*) AS n FROM audit').first('n');
  for (const action of ['promote', 'execute', 'reserve', 'final-audit', 'advise-live']) {
    const known = await readJson(await t.call(`${BASE}/runs/${created.json.runId}/${action}`, { method: 'POST', headers }));
    const unknown = await readJson(await t.call(`${BASE}/runs/run_v1_doesnotexist/${action}`, { method: 'POST', headers }));
    assert.equal(known.status, 501, action);
    assert.equal(known.json.code, 'ADMIN_NOT_IMPLEMENTED');
    assert.deepEqual(unknown.json, known.json, `${action} refuses before lookup`);
    assert.equal(unknown.status, 501);
  }
  assert.equal(await t.DB.prepare('SELECT COUNT(*) AS n FROM dgm_preview_events').first('n'), eventsBefore);
  assert.equal(await t.DB.prepare('SELECT COUNT(*) AS n FROM audit').first('n'), auditBefore);
});

test('dgm api: mutations require CSRF even when they would refuse', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  const noCsrf = await readJson(await t.call(`${BASE}/runs`, {
    method: 'POST', headers: t.as(t.alice), body: { fixture: 'good' }
  }));
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.code, 'CSRF_REQUIRED');
  const created = await readJson(await t.call(`${BASE}/runs`, {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { fixture: 'good', held: true }
  }));
  assert.equal(created.status, 201);
  for (const action of ['pause', 'resume', 'cancel', 'promote']) {
    const out = await readJson(await t.call(`${BASE}/runs/${created.json.runId}/${action}`, {
      method: 'POST', headers: t.as(t.alice), body: {}
    }));
    assert.equal(out.status, 403, action);
    assert.equal(out.json.code, 'CSRF_REQUIRED');
  }
});

test('dgm api: spent write budgets reject creates before any write', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  await t.DB.prepare('INSERT OR REPLACE INTO write_budget (user_id, window, count) VALUES (?, ?, ?)')
    .bind('u_alice', budgetWindow(), 120).run();
  const out = await readJson(await t.call(`${BASE}/runs`, {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { fixture: 'good' }
  }));
  assert.equal(out.status, 429);
  assert.equal(out.json.code, 'WRITE_RATE_LIMITED');
  assert.equal(await t.DB.prepare('SELECT COUNT(*) AS n FROM dgm_preview_runs').first('n'), 0);
});

test('dgm api: live runs are capped per operator without partial writes', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  const headers = { ...t.as(t.alice), ...t.csrf };
  const create = (body) => t.call(`${BASE}/runs`, { method: 'POST', headers, body }).then(readJson);
  for (let i = 0; i < 20; i++) {
    const out = await create({ fixture: 'good', held: true });
    assert.equal(out.status, 201, `held create ${i}`);
  }
  const eventsBefore = await t.DB.prepare('SELECT COUNT(*) AS n FROM dgm_preview_events').first('n');
  const auditBefore = await t.DB.prepare('SELECT COUNT(*) AS n FROM audit').first('n');
  const capped = await create({ fixture: 'good', held: true });
  assert.equal(capped.status, 409);
  assert.equal(capped.json.code, 'DGM_LIVE_CAP');
  assert.equal(await t.DB.prepare('SELECT COUNT(*) AS n FROM dgm_preview_events').first('n'), eventsBefore);
  assert.equal(await t.DB.prepare('SELECT COUNT(*) AS n FROM audit').first('n'), auditBefore);
  // Terminal creates bypass the live cap.
  const terminal = await create({ fixture: 'good' });
  assert.equal(terminal.status, 201);
  // Re-holding into a full live set refuses too.
  const pause = await readJson(await t.call(`${BASE}/runs/${terminal.json.runId}/pause`, { method: 'POST', headers }));
  assert.equal(pause.status, 409);
  assert.equal(pause.json.code, 'DGM_LIVE_CAP');
  // Freeing one slot admits a held create again.
  const first = await t.DB.prepare("SELECT id FROM dgm_preview_runs WHERE status = 'paused' LIMIT 1").first('id');
  const resume = await readJson(await t.call(`${BASE}/runs/${first}/resume`, { method: 'POST', headers }));
  assert.equal(resume.status, 200);
  assert.equal((await create({ fixture: 'good', held: true })).status, 201);
});

test('dgm api: preview requests emit fixture telemetry and audit rows on the real path', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  const headers = { ...t.as(t.alice), ...t.csrf };
  const created = await readJson(await t.call(`${BASE}/runs`, {
    method: 'POST', headers, body: { fixture: 'good', held: true }
  }));
  assert.equal(created.status, 201);
  // Held runs read stale until their outcome row lands on resume.
  assert.equal(created.json.telemetry.readStatus, 'stale');
  assert.deepEqual(created.json.telemetry.stale, [created.json.runId]);
  const resumed = await readJson(await t.call(`${BASE}/runs/${created.json.runId}/resume`, { method: 'POST', headers }));
  assert.equal(resumed.json.telemetry.readStatus, 'ok');
  assert.deepEqual(resumed.json.telemetry.outcomeCounts, { succeeded: 1 });
  assert.deepEqual(resumed.json.telemetry.latencySummary, { count: 1, p50_ms: 12, p95_ms: 12, status: 'ok' });
  // Stored telemetry rows carry env=fixture and nothing else.
  const rows = await t.DB.prepare('SELECT event, body_json FROM dgm_preview_events WHERE run_id = ? ORDER BY seq ASC')
    .bind(created.json.runId).all();
  const telemetry = rows.results.filter((r) => r.event.startsWith('telemetry.'));
  assert.ok(telemetry.length >= 4);
  for (const row of telemetry) {
    assert.equal(JSON.parse(row.body_json).env, 'fixture', row.event);
  }
  assert.ok(rows.results.some((r) => r.event === 'preview.created'));
  assert.ok(rows.results.some((r) => r.event === 'preview.resumed'));
  // The operating-path audit trail is readable through the real session API.
  const audit = await readJson(await t.call('/api/audit', { headers: t.as(t.alice) }));
  assert.equal(audit.status, 200);
  const actions = audit.json.items.map((a) => `${a.action}:${a.target}`);
  assert.ok(actions.includes(`dgm.preview.create:${created.json.runId}`), JSON.stringify(actions));
  assert.ok(actions.includes(`dgm.preview.resume:${created.json.runId}`), JSON.stringify(actions));
});

test('dgm api: labels are redacted before storage across runs, events, and audit', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  const secret = 'Bearer abcDEF123._~+/=-secret';
  const email = 'ada@example.com';
  const out = await readJson(await t.call(`${BASE}/runs`, {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf },
    body: { fixture: 'good', label: `reach ${secret} or ${email} today` }
  }));
  assert.equal(out.status, 201);
  assert.ok(!out.text.includes('abcDEF123'));
  assert.ok(!out.text.includes(email));
  assert.ok(out.json.label.includes('[redacted]'));
  const scan = async (sql) => JSON.stringify((await t.DB.prepare(sql).all()).results);
  for (const sql of ['SELECT label FROM dgm_preview_runs', 'SELECT body_json FROM dgm_preview_events', 'SELECT detail FROM audit']) {
    const text = await scan(sql);
    assert.ok(!text.includes('abcDEF123'), sql);
    assert.ok(!text.includes(email), sql);
  }
  // Telemetry counts survive redaction.
  assert.equal(out.json.telemetry.tokensSummary.prompt_tokens_est, 40);
});

test('dgm api: corrupt event rows degrade the telemetry view, never the run read', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  const headers = { ...t.as(t.alice), ...t.csrf };
  const created = await readJson(await t.call(`${BASE}/runs`, { method: 'POST', headers, body: { fixture: 'good' } }));
  assert.equal(created.status, 201);
  await t.DB.prepare('INSERT INTO dgm_preview_events (run_id, seq, at, event, body_json) VALUES (?, ?, ?, ?, ?)')
    .bind(created.json.runId, 999, new Date().toISOString(), 'telemetry.latency', '{corrupt').run();
  const detail = await readJson(await t.call(`${BASE}/runs/${created.json.runId}`, { headers: t.as(t.alice) }));
  assert.equal(detail.status, 200);
  assert.equal(detail.json.status, 'completed-preview');
  assert.equal(detail.json.telemetry.readStatus, 'degraded');
  assert.equal(detail.json.telemetry.unparsedRows, 1);
  assert.equal(detail.json.telemetry.latencySummary.count, 1);
});

test('dgm api: unknown preview paths and methods answer 404 to authorized callers', async () => {
  const t = await createTestEnv(FLAG);
  await grant(t, 'u_alice', 'operations_observer');
  const unknown = await readJson(await t.call(`${BASE}/nope`, { headers: t.as(t.alice) }));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, 'NOT_FOUND');
  const method = await readJson(await t.call(`${BASE}/runs/run_v1_x/pause`, { headers: t.as(t.alice) }));
  assert.equal(method.status, 404);
});

test('dgm api: readiness requires migration 0017 only when the slice is enabled', async () => {
  const without = MIGRATION_FILES.filter((n) => n !== '0017_dgm_preview.sql');
  const enabled = await createTestEnv({ skipMigrations: true, DGM_PREVIEW_ENABLED: '1' });
  applyMigrations(enabled.sqlite, without);
  const missing = await readJson(await enabled.call('/api/health'));
  assert.equal(missing.status, 200);
  assert.equal(missing.json.detail.schema, false);
  assert.equal(missing.json.ready, false);
  applyMigrations(enabled.sqlite, ['0017_dgm_preview.sql']);
  const ready = await readJson(await enabled.call('/api/health'));
  assert.equal(ready.json.detail.schema, true);
  assert.equal(ready.json.ready, true);
  const disabled = await createTestEnv({ skipMigrations: true });
  applyMigrations(disabled.sqlite, without);
  const dark = await readJson(await disabled.call('/api/health'));
  assert.equal(dark.json.ready, true, 'disabled slice needs no preview tables');
  enabled.sqlite.close();
  disabled.sqlite.close();
});

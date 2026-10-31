/* Built with Meta Muse. */
// Catalog migrations + N3 SQL against real local D1 (miniflare workerd).
// The node:sqlite shim proves control-plane logic; only this tier proves
// the migration files apply on the target runtime and the guarded-batch
// SQL (conditional marker, conditional release, PK-conflict rollback)
// behaves as transitionDeployment requires. No account, no remote DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { MIGRATION_FILES } from './d1-shim.mjs';
import { TRANSITION_SQL } from '../src/worker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let mf = null;
let db = null;

before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("local-only")}}',
    compatibilityDate: '2026-10-01',
    d1Databases: { DB: 'catalog-runtime-test' },
  }));
  db = await mf.getD1Database('DB');
  for (const name of MIGRATION_FILES) {
    // Miniflare exec takes one single-line statement and no comments;
    // the migration files carry neither semicolons nor newlines inside
    // string literals (verified) and no inline comments, so strip +
    // split + collapse is exact.
    const sql = readFileSync(path.join(ROOT, 'migrations', name), 'utf8')
      .split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    for (const stmt of sql.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
      await db.exec(`${stmt};`);
    }
  }
  // Local D1 enforces declared FOREIGN KEYs (the node shim does not), so
  // seeds carry their real parents, exactly like worker-written rows.
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, username, displayUsername, demo, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind('u1', 'N', 'n@x.invalid', 0, null, 'n', 'n', 0, now, now),
    db.prepare('INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind('r1', 'u1', 'n', 'local', 'local', 'cpu', 'gpu', now),
  ]);
});

after(async () => { await mf.dispose(); });

test('catalog migrations 0001-0019 apply on real local D1 with the N3 columns', async () => {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results.map((r) => r.name);
  for (const t of ['node_capabilities', 'catalog_assets', 'catalog_asset_files', 'catalog_uploads', 'catalog_compat_cache', 'catalog_deployments', 'catalog_deployment_events', 'catalog_reservations']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  const cols = async (t) => (await db.prepare('SELECT * FROM pragma_table_info(?)').bind(t).all()).results.map((c) => c.name);
  for (const c of ['state', 'error_json', 'updated_at', 'idem_key', 'plan_fingerprint']) {
    assert.ok((await cols('catalog_deployments')).includes(c), `catalog_deployments.${c}`);
  }
  for (const c of ['state', 'bytes', 'released_at']) assert.ok((await cols('catalog_reservations')).includes(c), `catalog_reservations.${c}`);
  assert.ok((await cols('catalog_deployment_events')).includes('detail'), 'catalog_deployment_events.detail');
});

// The N3 batch below runs transitionDeployment's own exported SQL
// (TRANSITION_SQL), so worker.js drift fails here instead of silently
// unproving the batch.
async function seedJob(jobId, state) {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('INSERT INTO catalog_deployments (id, owner_id, plan_json, plan_fingerprint, idem_key, state, node_id, runtime, error_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(jobId, 'u1', '{}', 'fp', `k-${jobId}`, state, 'r1', 'rt', '{}', now, now),
    db.prepare("INSERT INTO catalog_reservations (id, deployment_id, owner_id, node_id, bytes, state, created_at, released_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(`res-${jobId}`, jobId, 'u1', 'r1', 100, 'held', now, null),
  ]);
}

test('N3 batch on real D1: winner commits marker+release, stale loser commits nothing', async () => {
  await seedJob('dep_n3a', 'admitted');
  const wnow = new Date().toISOString();
  const wout = await db.batch([
    db.prepare(TRANSITION_SQL.update).bind('failed', '{"code":"X"}', wnow, 'dep_n3a', 'admitted'),
    db.prepare(TRANSITION_SQL.marker).bind('ev_dep_n3a_admitted_failed', 'dep_n3a', wnow, 'admitted', 'failed', 'd', 'dep_n3a', 'failed', wnow),
    db.prepare(TRANSITION_SQL.release).bind(wnow, 'dep_n3a', 'ev_dep_n3a_admitted_failed', 'dep_n3a', 'failed', wnow),
  ]);
  assert.equal(wout[0].meta.changes, 1, 'D1 reports the CAS rowcount');
  const marker = await db.prepare('SELECT to_state FROM catalog_deployment_events WHERE id = ?').bind('ev_dep_n3a_admitted_failed').first();
  assert.equal(marker && marker.to_state, 'failed', 'deterministic marker lands');
  const res = await db.prepare('SELECT state FROM catalog_reservations WHERE deployment_id = ?').bind('dep_n3a').first();
  assert.equal(res.state, 'released', 'winner releases');
  const lnow = new Date().toISOString();
  const lout = await db.batch([
    db.prepare(TRANSITION_SQL.update).bind('staging', '{}', lnow, 'dep_n3a', 'admitted'),
    db.prepare(TRANSITION_SQL.marker).bind('ev_dep_n3a_admitted_staging', 'dep_n3a', lnow, 'admitted', 'staging', 'd', 'dep_n3a', 'staging', lnow),
  ]);
  assert.equal(lout[0].meta.changes, 0, 'stale UPDATE matches nothing');
  const ghost = await db.prepare('SELECT id FROM catalog_deployment_events WHERE id = ?').bind('ev_dep_n3a_admitted_staging').first();
  assert.equal(ghost, null, 'loser marker never lands');
});

test('admit batch on real D1: deployment+reservation+event commit parent-first under FKs', async () => {
  // Exact mirror of the execute route's admit batch (worker.js): parents
  // first, so immediate FK enforcement never sees a dangling child.
  const now = new Date().toISOString();
  const out = await db.batch([
    db.prepare('INSERT INTO catalog_deployments (id, owner_id, plan_json, plan_fingerprint, idem_key, state, node_id, runtime, error_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('dep_admit1', 'u1', '{}', 'fp', 'k-admit1', 'queued', 'r1', 'rt', '{}', now, now),
    db.prepare('INSERT INTO catalog_reservations (id, deployment_id, owner_id, node_id, bytes, state, created_at, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('res_admit1', 'dep_admit1', 'u1', 'r1', 100, 'held', now, null),
    db.prepare('INSERT INTO catalog_deployment_events (id, deployment_id, at, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('ev_admit1', 'dep_admit1', now, '', 'queued', 'admitted; reservation held'),
  ]);
  assert.equal(out.length, 3);
  const n = await db.prepare('SELECT COUNT(*) n FROM catalog_reservations WHERE deployment_id = ?').bind('dep_admit1').first();
  assert.equal(n.n, 1, 'reservation committed alongside its deployment');
});

test('N3 batch on real D1: constraint failure rolls the whole batch back (atomicity)', async () => {
  // Seeds a marker collision no serialized race produces in this shape
  // (a loser zero-rows the marker guard first; only a same-ms same-target
  // coincidence PK-conflicts); the point proved is batch atomicity under
  // constraint failure, the backstop behind the guards.
  await seedJob('dep_n3c', 'admitted');
  await db.prepare('INSERT INTO catalog_deployment_events (id, deployment_id, at, from_state, to_state, detail) VALUES (?,?,?,?,?,?)')
    .bind('ev_dep_n3c_admitted_staging', 'dep_n3c', new Date().toISOString(), 'admitted', 'staging', 'pre-existing').run();
  const now = new Date().toISOString();
  await assert.rejects(db.batch([
    db.prepare(TRANSITION_SQL.update).bind('staging', '{}', now, 'dep_n3c', 'admitted'),
    db.prepare(TRANSITION_SQL.marker).bind('ev_dep_n3c_admitted_staging', 'dep_n3c', now, 'admitted', 'staging', 'd', 'dep_n3c', 'staging', now),
  ]), 'duplicate marker fails the batch');
  const row = await db.prepare('SELECT state FROM catalog_deployments WHERE id = ?').bind('dep_n3c').first();
  assert.equal(row.state, 'admitted', 'state write rolled back');
  const res = await db.prepare('SELECT state FROM catalog_reservations WHERE deployment_id = ?').bind('dep_n3c').first();
  assert.equal(res.state, 'held', 'no release without its marker');
  const n = await db.prepare('SELECT COUNT(*) n FROM catalog_deployment_events WHERE id = ?').bind('ev_dep_n3c_admitted_staging').first();
  assert.equal(n.n, 1, 'exactly the pre-existing marker row');
});

test('N3 release guard on real D1: a stale loser cannot free a held reservation', async () => {
  // The N1 hold shape: terminal job, landed marker, still-held
  // reservation. A stale loser racing toward the same target must not
  // release it even though its marker id pre-exists — the release also
  // requires this write's post-state.
  await seedJob('dep_n3h', 'failed');
  await db.prepare('UPDATE catalog_deployments SET updated_at = ? WHERE id = ?').bind('2026-01-01T00:00:00.000Z', 'dep_n3h').run();
  await db.prepare('INSERT INTO catalog_deployment_events (id, deployment_id, at, from_state, to_state, detail) VALUES (?,?,?,?,?,?)')
    .bind('ev_dep_n3h_cancelling_failed', 'dep_n3h', '2026-01-01T00:00:00.000Z', 'cancelling', 'failed', 'n1 hold').run();
  const lnow = new Date().toISOString();
  const lout = await db.batch([
    db.prepare(TRANSITION_SQL.update).bind('failed', '{}', lnow, 'dep_n3h', 'cancelling'),
    db.prepare(TRANSITION_SQL.marker).bind('ev_dep_n3h_cancelling_failed', 'dep_n3h', lnow, 'cancelling', 'failed', 'd', 'dep_n3h', 'failed', lnow),
    db.prepare(TRANSITION_SQL.release).bind(lnow, 'dep_n3h', 'ev_dep_n3h_cancelling_failed', 'dep_n3h', 'failed', lnow),
  ]);
  assert.equal(lout[0].meta.changes, 0, 'stale UPDATE matches nothing');
  const res = await db.prepare('SELECT state FROM catalog_reservations WHERE deployment_id = ?').bind('dep_n3h').first();
  assert.equal(res.state, 'held', 'pre-existing marker does not authorize release');
});

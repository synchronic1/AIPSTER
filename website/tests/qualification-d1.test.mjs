/* Built with Meta Muse. Meta-qual lane: real local D1 tier (miniflare workerd). */
/* The node:sqlite shim proves control-plane logic; only this tier proves
   migration 0030 applies on the target runtime, FOREIGN KEYs hold, and the
   atomic admission/lease SQL serializes real concurrent claims. Fixtures
   only: no provider calls, no keys. Isolated database, disposed after. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { MIGRATION_FILES } from './d1-shim.mjs';
import { claimQualOp, findCache, findUncertain, markQualOp, saveCache, sweepQualStale } from '../src/qualification/admission.mjs';
import { handleQualificationPost, handleQualificationsGet, handleWorkerNext, handleWorkerResult } from '../src/qualification/router.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let mf = null;
let db = null;

async function freshDb(name) {
  const inst = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("local-only")}}',
    compatibilityDate: '2026-10-01',
    d1Databases: { DB: name },
  }));
  const handle = await inst.getD1Database('DB');
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(path.join(ROOT, 'migrations', file), 'utf8')
      .split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    for (const stmt of sql.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
      await handle.exec(`${stmt};`);
    }
  }
  return { inst, db: handle };
}

async function seedResource(ownerId, resourceId, now) {
  await db.prepare('INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(resourceId, ownerId, 'n', 'local', 'local', 'cpu', 'gpu', now).run();
}

before(async () => {
  ({ inst: mf, db } = await freshDb('qual-d1-test'));
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)').bind('u1', 'N1', 'n1@x.invalid', 0, null, now, now),
    db.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)').bind('u2', 'N2', 'n2@x.invalid', 0, null, now, now),
    db.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)').bind('u3', 'N3', 'n3@x.invalid', 0, null, now, now),
    db.prepare('INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, created_at) VALUES (?,?,?,?,?,?,?,?)').bind('r1', 'u1', 'n', 'local', 'local', 'cpu', 'gpu', now),
    // Real reporter shape: canonical transport names with mode, never an
    // invented 'ganglion' snapshot entry (attach entries are probe-gated).
    db.prepare('INSERT INTO node_capabilities (node_id, schema_version, reported_at, os, arch, runtimes_json, mem_json, disk_json, workload_json) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind('r1', 1, now, 'linux', 'x86_64', JSON.stringify([{ name: 'llama-server', mode: 'managed', formats: ['gguf'], models: ['m'], configured: ['m'] }]), JSON.stringify({ ramTotalBytes: 8 * 1024 ** 3, ramAvailBytes: 1 }), JSON.stringify({ totalBytes: 100, availBytes: 1 }), JSON.stringify({})),
  ]);
});

after(async () => { await mf.dispose(); });

test('real D1: 0030 tables, columns and indexes exist', async () => {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results.map((r) => r.name);
  for (const t of ['qualification_recommendations', 'qualification_cache', 'qualification_spend', 'qualification_runs']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  const cols = async (t) => (await db.prepare('SELECT * FROM pragma_table_info(?)').bind(t).all()).results.map((c) => c.name);
  for (const c of ['mode', 'input_digest', 'advice_json']) assert.ok((await cols('qualification_recommendations')).includes(c), `recommendations.${c}`);
  for (const c of ['mode', 'claim_by', 'execution_deadline']) assert.ok((await cols('qualification_runs')).includes(c), `runs.${c}`);
});

test('real D1: foreign keys hold (shim does not enforce them)', async () => {
  const now = new Date().toISOString();
  await assert.rejects(
    db.prepare('INSERT INTO qualification_recommendations (owner_id, node_id, profile_digest, op_key, input_digest, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind('u1', 'missing-node', 'd', 'k-fk', 'd', 'reserved', now, now).run(),
    /FOREIGN KEY/i,
  );
});

test('real D1: concurrent same-key claims admit exactly once', async () => {
  const a = claimQualOp(db, 'u1', 'r1', 'd-same', 'k-same', 'd-same', { env: {} });
  const b = claimQualOp(db, 'u1', 'r1', 'd-same', 'k-same', 'd-same', { env: {} });
  const [ra, rb] = await Promise.all([a, b]);
  const outcomes = [ra.outcome, rb.outcome].sort();
  assert.deepEqual(outcomes, ['claimed', 'in-progress'], `unexpected outcomes ${outcomes}`);
  const rows = (await db.prepare('SELECT op_key FROM qualification_recommendations WHERE owner_id = ? AND op_key = ?').bind('u1', 'k-same').all()).results;
  assert.equal(rows.length, 1);
});

test('real D1: concurrent distinct keys share one request budget', async () => {
  const env = { QUAL_OWNER_PER_HOUR: '1', QUAL_GLOBAL_PER_HOUR: '100' };
  await seedResource('u3', 'r3', new Date().toISOString());
  const { qualWindow } = await import('../src/qualification/admission.mjs');
  const win = qualWindow(new Date());
  const reqCount = async () => (await db.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind('u3', win).first())?.count ?? 0;
  const before = await reqCount();
  const mk = (k) => claimQualOp(db, 'u3', 'r3', `d-cap-${k}`, k, `d-cap-${k}`, { env, mode: 'live' }).then((r) => r.outcome, (e) => e.code);
  const out = await Promise.all([mk('k-cap-a'), mk('k-cap-b')]);
  assert.ok(out.includes('claimed'), `one winner, got ${out}`);
  assert.ok(out.includes('QUAL_OWNER_QUOTA'), `loser quota-refused, got ${out}`);
  assert.equal(await reqCount() - before, 1, 'only the winner wrote the owner request charge');
  const loserRows = (await db.prepare('SELECT op_key FROM qualification_recommendations WHERE owner_id = ? AND op_key IN (?, ?)').bind('u3', 'k-cap-a', 'k-cap-b').all()).results;
  assert.equal(loserRows.length, 1, 'the refused key wrote no op row');
});

test('real D1: fixture claims use a separate owner bucket, never live/global', async () => {
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)').bind('u4', 'N4', 'n4@x.invalid', 0, null, now, now).run();
  await seedResource('u4', 'r4', now);
  const env = { QUAL_OWNER_PER_HOUR: '1', QUAL_GLOBAL_PER_HOUR: '100' };
  const { qualWindow, qualFixtureWindow } = await import('../src/qualification/admission.mjs');
  const at = new Date();
  const liveWin = qualWindow(at);
  const fixWin = qualFixtureWindow(at);
  const countIn = async (u, w) => (await db.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind(u, w).first())?.count ?? 0;
  const liveBefore = await countIn('u4', liveWin);
  const globBefore = await countIn('deployment', liveWin);
  const mk = (k) => claimQualOp(db, 'u4', 'r4', `d-fix-${k}`, k, `d-fix-${k}`, { env, mode: 'fixture' }).then((r) => r.outcome, (e) => e.code);
  const out = await Promise.all([mk('k-fix-a'), mk('k-fix-b')]);
  assert.ok(out.includes('claimed'), `one winner, got ${out}`);
  assert.ok(out.includes('QUAL_FIXTURE_QUOTA'), `loser fixture-refused, got ${out}`);
  assert.equal(await countIn('u4', liveWin) - liveBefore, 0, 'fixture claims never touch the live owner window');
  assert.equal(await countIn('deployment', liveWin) - globBefore, 0, 'fixture claims never touch the global window');
  assert.equal(await countIn('u4', fixWin), 1, 'only the winner charged the fixture window');
});

test('real D1: same identity under a different key waits, never duplicates', async () => {
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)').bind('u5', 'N5', 'n5@x.invalid', 0, null, now, now).run();
  await seedResource('u5', 'r5', now);
  const env = { QUAL_OWNER_PER_HOUR: '100', QUAL_GLOBAL_PER_HOUR: '100' };
  const first = await claimQualOp(db, 'u5', 'r5', 'd-dupe', 'k-dupe-a', 'd-dupe', { env, mode: 'fixture' });
  assert.equal(first.outcome, 'claimed');
  const second = await claimQualOp(db, 'u5', 'r5', 'd-dupe', 'k-dupe-b', 'd-dupe', { env, mode: 'fixture' });
  assert.equal(second.outcome, 'in-progress', `second key must wait, got ${JSON.stringify(second)}`);
  const rows = (await db.prepare("SELECT op_key FROM qualification_recommendations WHERE owner_id = ? AND node_id = ? AND profile_digest = ? AND state IN ('reserved','fetching')").bind('u5', 'r5', 'd-dupe').all()).results;
  assert.equal(rows.length, 1, 'exactly one inflight op for the identity');
  assert.equal(rows[0].op_key, 'k-dupe-a', 'the first key holds the reservation');
});

test('real D1: aggregate spend cap binds concurrent live reservations', async () => {
  const env = { QUAL_OWNER_PER_HOUR: '100', QUAL_GLOBAL_PER_HOUR: '100', QUAL_OWNER_SPEND_CAP_USD: '0.005', QUAL_GLOBAL_SPEND_CAP_USD: '100' };
  const spend = 5000;
  const mk = (k) => claimQualOp(db, 'u1', 'r1', `d-sp-${k}`, k, `d-sp-${k}`, { env, mode: 'live', spendMicro: spend }).then((r) => r.outcome, (e) => e.code);
  const out = await Promise.all([mk('k-sp-a'), mk('k-sp-b')]);
  assert.ok(out.includes('claimed'), `one winner, got ${out}`);
  assert.ok(out.includes('QUAL_SPEND_CAP'), `loser spend-refused, got ${out}`);
  const agg = await db.prepare('SELECT usd_micro FROM qualification_spend WHERE owner_id = ?').bind('u1').first();
  assert.equal(Number(agg.usd_micro), spend, 'the aggregate holds exactly one reservation');
});

test('real D1: completion between pre-checks and reservation replays, never a second call', async () => {
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)').bind('u6', 'N6', 'n6@x.invalid', 0, null, now, now).run();
  await seedResource('u6', 'r6', now);
  const env = { QUAL_OWNER_PER_HOUR: '100', QUAL_GLOBAL_PER_HOUR: '100' };
  const identity = { nodeId: 'r6', profileDigest: 'd-race', mode: 'fixture' };
  const charges = async () => Number((await db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM write_budget WHERE user_id = ?').bind('u6').first())?.n ?? 0);
  // Second key's pre-claim reads: cache empty, nothing uncertain, nothing inflight.
  assert.ok(!(await findCache(db, 'u6', identity)), 'second key reads cache empty');
  assert.ok(!(await findUncertain(db, 'u6', identity)), 'second key reads no uncertain terminal');
  // First key completes (deliver + stable cache) before the second reserves.
  const a = await claimQualOp(db, 'u6', 'r6', 'd-race', 'k-race-a', 'd-race', { env, mode: 'fixture' });
  assert.equal(a.outcome, 'claimed');
  await markQualOp(db, 'u6', 'k-race-a', ['reserved'], 'fetching');
  const advice = JSON.stringify({ summary: 's', suggestions: [], rationale: '', unknowns: [], benchmarkCatalogId: 'unsupported' });
  const receipt = JSON.stringify({ opKey: 'k-race-a', mode: 'fixture' });
  await db.prepare("UPDATE qualification_recommendations SET state = 'delivered', advice_json = ?, receipt_json = ?, updated_at = ? WHERE owner_id = ? AND op_key = ?")
    .bind(advice, receipt, new Date().toISOString(), 'u6', 'k-race-a').run();
  await saveCache(db, 'u6', { ...identity, adviceJson: advice, receiptJson: receipt });
  const spentByFirst = await charges();
  // The late reservation declines atomically and replays the first call:
  // no second dispatch, no second spend, no op row for the refused key.
  const b = await claimQualOp(db, 'u6', 'r6', 'd-race', 'k-race-b', 'd-race', { env, mode: 'fixture' });
  assert.equal(b.outcome, 'settled-replay');
  assert.equal(b.from, 'cached');
  assert.equal(JSON.parse(b.adviceJson).summary, 's', 'first advice replays');
  assert.equal(await charges(), spentByFirst, 'the declined reservation spent nothing');
  const brows = (await db.prepare('SELECT op_key FROM qualification_recommendations WHERE owner_id = ? AND op_key = ?').bind('u6', 'k-race-b').all()).results;
  assert.equal(brows.length, 0, 'the refused key wrote no op row');
  const aroows = (await db.prepare("SELECT op_key FROM qualification_recommendations WHERE owner_id = ? AND node_id = ? AND profile_digest = ? AND state = 'delivered'").bind('u6', 'r6', 'd-race').all()).results;
  assert.equal(aroows.length, 1, 'exactly one delivery for the identity');
});

test('real D1: delivered-without-cache replays from the row; uncertain wins over delivery', async () => {
  const now = new Date().toISOString();
  for (const u of ['u7', 'u8']) {
    await db.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)').bind(u, 'N', `${u}@x.invalid`, 0, null, now, now).run();
    await seedResource(u, 'r' + u.slice(1), now);
  }
  const env = { QUAL_OWNER_PER_HOUR: '100', QUAL_GLOBAL_PER_HOUR: '100' };
  const advice = JSON.stringify({ summary: 's7', suggestions: [], rationale: '', unknowns: [], benchmarkCatalogId: 'unsupported' });
  const receipt = JSON.stringify({ opKey: 'k-race7-a', mode: 'fixture' });
  // Crash window: delivered but the cache row never landed.
  assert.equal((await claimQualOp(db, 'u7', 'r7', 'd-race7', 'k-race7-a', 'd-race7', { env, mode: 'fixture' })).outcome, 'claimed');
  await markQualOp(db, 'u7', 'k-race7-a', ['reserved'], 'fetching');
  await db.prepare("UPDATE qualification_recommendations SET state = 'delivered', advice_json = ?, receipt_json = ?, updated_at = ? WHERE owner_id = ? AND op_key = ?")
    .bind(advice, receipt, new Date().toISOString(), 'u7', 'k-race7-a').run();
  const b7 = await claimQualOp(db, 'u7', 'r7', 'd-race7', 'k-race7-b', 'd-race7', { env, mode: 'fixture' });
  assert.equal(b7.outcome, 'settled-replay');
  assert.equal(b7.from, 'delivered', 'replay comes from the delivered row when the cache is missing');
  // Uncertain wins: a later uncertain terminal for the same identity blocks
  // replay-as-clean, even with an older delivery present.
  await db.prepare("INSERT INTO qualification_recommendations (owner_id, node_id, profile_digest, catalog_version, prompt_version, mode, op_key, input_digest, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .bind('u8', 'r8', 'd-race8', 'qual-catalog-v1', 'qual-prompt-v1', 'fixture', 'k-race8-a', 'd-race8', 'delivered', now, now).run();
  await db.prepare("INSERT INTO qualification_recommendations (owner_id, node_id, profile_digest, catalog_version, prompt_version, mode, op_key, input_digest, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .bind('u8', 'r8', 'd-race8', 'qual-catalog-v1', 'qual-prompt-v1', 'fixture', 'k-race8-b', 'd-race8', 'uncertain', now, now).run();
  const c8 = await claimQualOp(db, 'u8', 'r8', 'd-race8', 'k-race8-c', 'd-race8', { env, mode: 'fixture' });
  assert.equal(c8.outcome, 'uncertain', 'uncertain terminal reconciles, never replays-as-clean');
  const spent8 = Number((await db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM write_budget WHERE user_id = ?').bind('u8').first())?.n ?? 0);
  assert.equal(spent8, 0, 'blocked keys spend nothing');
});

test('real D1: stale reserved converts to uncertain, blocks new keys', async () => {
  const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  await db.prepare('INSERT INTO qualification_recommendations (owner_id, node_id, profile_digest, catalog_version, prompt_version, mode, op_key, input_digest, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind('u1', 'r1', 'd-stale', 'qual-catalog-v1', 'qual-prompt-v1', 'fixture', 'k-stale', 'd-stale', 'reserved', old, old).run();
  await sweepQualStale(db, 'u1');
  const row = await db.prepare('SELECT state FROM qualification_recommendations WHERE owner_id = ? AND op_key = ?').bind('u1', 'k-stale').first();
  assert.equal(row.state, 'uncertain');
  const blocked = await findUncertain(db, 'u1', { nodeId: 'r1', profileDigest: 'd-stale', mode: 'fixture' });
  assert.ok(blocked, 'uncertain identity found for new-key block');
});

test('real D1: end-to-end fixture flow with cache replay and no double spend', async () => {
  const env = { QUALIFICATION_ENABLED: '1' };
  const first = await handleQualificationPost({ db, env, ownerId: 'u1', resourceId: 'r1', body: { opKey: 'k-e2e' } });
  assert.equal(first.status, 200);
  const tokSum = async () => Number((await db.prepare('SELECT SUM(count) AS n FROM write_budget WHERE user_id = ? AND window LIKE ?').bind('u1', 'qual-tok/%').first())?.n ?? 0);
  const spendOf = async () => (await db.prepare('SELECT usd_micro FROM qualification_spend WHERE owner_id = ?').bind('u1').first())?.usd_micro ?? null;
  const [tokBefore, spendBefore] = [await tokSum(), await spendOf()];
  const replay = await handleQualificationPost({ db, env, ownerId: 'u1', resourceId: 'r1', body: { opKey: 'k-e2e-fresh' } });
  assert.equal(replay.body.replay, true);
  assert.equal(replay.body.cached, true);
  assert.deepEqual(replay.body.advice, first.body.advice, 'cached advice replays byte-identically');
  assert.equal(await spendOf(), spendBefore, 'cache replay spends nothing');
  assert.equal(await tokSum(), tokBefore, 'cache replay charges no tokens');
});

test('real D1: lease is single-winner; assigned results refused', async () => {
  const env = { QUALIFICATION_ENABLED: '1' };
  const post = await handleQualificationPost({ db, env, ownerId: 'u1', resourceId: 'r1', body: { opKey: 'k-lease' } });
  const runId = post.body.assignment.run_id;
  const leaseId = post.body.assignment.lease_id;
  await assert.rejects(
    handleWorkerResult({ db, ownerId: 'u1', resourceId: 'r1', runId, body: { leaseId, status: 'failed', result: { reason: 'EARLY' } } }),
    (e) => e.code === 'QUAL_NOT_LEASED',
  );
  const [n1, n2] = await Promise.all([
    handleWorkerNext({ db, ownerId: 'u1', resourceId: 'r1' }).then((r) => r.status, (e) => e.code),
    handleWorkerNext({ db, ownerId: 'u1', resourceId: 'r1' }).then((r) => r.status, (e) => e.code),
  ]);
  assert.ok([n1, n2].includes(200) && ([n1, n2].includes(204) || [n1, n2].includes('QUAL_ALREADY_LEASED')), `single lease winner, got ${n1}/${n2}`);
  const done = await handleWorkerResult({ db, ownerId: 'u1', resourceId: 'r1', runId, body: { leaseId, status: 'succeeded', result: { runtimeId: 'llama-server', modelId: 'm', servedModelId: 'm', placementProvenance: 'unknown', elapsedMs: 5 } } });
  assert.equal(done.body.state, 'succeeded');
  const stored = await db.prepare('SELECT result_json FROM qualification_runs WHERE run_id = ?').bind(runId).first();
  assert.deepEqual(JSON.parse(stored.result_json).placementProvenance, 'unknown', 'provenance persists with the receipt');
});

test('real D1: transfer hides prior report; revoked key refused; grantee sees nothing', async () => {
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)').bind('ug', 'G', 'g@x.invalid', 0, null, now, now).run();
  await db.prepare('INSERT INTO grants (id, resource_id, owner_id, grantee_id, max_jobs, max_tokens, created_at) VALUES (?,?,?,?,?,?,?)').bind('g1', 'r1', 'u1', 'ug', 1, 1, now).run();
  await db.prepare('INSERT INTO key_verifiers (id, owner_id, name, scope, salt, verifier, prefix, metadata, created_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind('key-rev', 'u1', 'n', 'heartbeat', 's', 'v', 'p', '', now, now).run();
  await assert.rejects(handleWorkerNext({ db, ownerId: 'u1', resourceId: 'r1', keyId: 'key-rev' }), (e) => e.code === 'KEY_REVOKED');
  const gList = await handleQualificationsGet({ db, ownerId: 'ug' });
  assert.deepEqual(gList.body.recommendations, [], 'grantee has no report path');
  await db.prepare('UPDATE resources SET owner_id = ? WHERE id = ?').bind('u2', 'r1').run();
  const oldList = await handleQualificationsGet({ db, ownerId: 'u1' });
  assert.deepEqual(oldList.body.recommendations, [], 'previous owner sees nothing after transfer');
  await assert.rejects(
    handleWorkerResult({ db, ownerId: 'u1', resourceId: 'r1', runId: 'qrun_x', body: { leaseId: 'qlease_x', status: 'failed', result: { reason: 'X' } } }),
    (e) => e.code === 'NOT_FOUND',
  );
});

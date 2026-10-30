// Independent sprint review: synthetic data on real, outbound-blocked local D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createTestEnv, readJson, MIGRATION_FILES } from './d1-shim.mjs';
import { heartbeatWindow, HEARTBEAT_GLOBAL_ID } from '../src/lib/quotas.js';

async function fixture(c, name) {
  const t = await createTestEnv({ HEARTBEAT_OWNER_PER_HOUR: '20', HEARTBEAT_GLOBAL_PER_HOUR: '20' });
  const resource = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name, kind: 'local' },
  }));
  assert.equal(resource.status, 201, resource.text);
  const key = await readJson(await t.call('/api/keys', {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf },
    body: { name, scope: 'heartbeat', resourceId: resource.json.id },
  }));
  assert.equal(key.status, 201, key.text);
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: 'export default {fetch(){return new Response("local")}}',
    compatibilityDate: '2026-10-01', d1Databases: { DB: name },
    outboundService: () => new Response('blocked', { status: 403 }),
  }));
  c.after(() => mf.dispose());
  c.after(() => t.sqlite.close());
  const db = await mf.getD1Database('DB');
  for (const file of MIGRATION_FILES) {
    const sql = (await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'))
      .split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.exec(stmt.replace(/\s+/g, ' '));
  }
  const rows = [db.prepare('PRAGMA defer_foreign_keys = ON')];
  for (const { name: table } of t.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all()) {
    for (const row of t.sqlite.prepare(`SELECT * FROM "${table}"`).all()) {
      const columns = Object.keys(row);
      rows.push(db.prepare(`INSERT INTO "${table}" (${columns.map(k => `"${k}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).bind(...Object.values(row)));
    }
  }
  await db.batch(rows);
  // Warm the shared authentication touch independently of admission metering.
  await db.prepare('UPDATE key_verifiers SET last_used_at = ?').bind(new Date().toISOString()).run();
  const meter = { batches: [], writes: [], beforeAdmission: null, appendFailure: false };
  const note = (sql, result) => {
    meter.writes.push({ sql, changes: Number(result.meta?.changes || 0), rows: Number(result.meta?.rows_written || 0) });
    return result;
  };
  const wrap = (inner, sql) => ({
    inner, sql,
    bind: (...p) => wrap(inner.bind(...p), sql),
    first: (...p) => inner.first(...p),
    all: async (...p) => note(sql, await inner.all(...p)),
    run: async (...p) => note(sql, await inner.run(...p)),
    raw: (...p) => inner.raw(...p),
  });
  t.env.DB = {
    prepare: sql => wrap(db.prepare(sql), sql), exec: sql => db.exec(sql),
    async batch(statements) {
      const admission = /UPDATE resources SET heartbeat_at/.test(statements[0]?.sql || '');
      if (admission && meter.beforeAdmission) await meter.beforeAdmission();
      const list = statements.map(s => s.inner || s);
      if (admission && meter.appendFailure) list.push(db.prepare('INSERT INTO write_budget(user_id, window, count) VALUES (NULL, NULL, NULL)'));
      const result = await db.batch(list);
      if (admission) meter.batches.push(result.map(r => ({ changes: r.meta.changes, rows: r.meta.rows_written })));
      for (let i = 0; i < result.length; i++) note(statements[i]?.sql || 'injected failure', result[i]);
      return result;
    },
  };
  const beat = async (body = { usable: true }) => readJson(await t.call(`/api/resources/${resource.json.id}/heartbeat`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + key.json.secret }, body: JSON.stringify(body),
  }));
  const counters = async () => (await db.prepare('SELECT user_id, count FROM write_budget WHERE window = ? ORDER BY user_id').bind(heartbeatWindow()).all()).results;
  const telemetry = () => db.prepare('SELECT online, usable, heartbeat_at FROM resources WHERE id = ?').bind(resource.json.id).first();
  return { t, db, meter, resource: resource.json, key: key.json, beat, counters, telemetry };
}

test('SPRINT real D1: changes() chains through every owner/global bucket existence combination', async c => {
  for (let mask = 0; mask < 4; mask++) {
    await c.test(`bucket mask ${mask}`, async c => {
      const f = await fixture(c, 'hb-sprint-chain-' + mask);
      for (const [bit, id] of [[1, f.t.alice.id], [2, HEARTBEAT_GLOBAL_ID]]) {
        if (mask & bit) await f.db.prepare('INSERT INTO write_budget(user_id, window, count) VALUES (?, ?, 4)').bind(id, heartbeatWindow()).run();
      }
      assert.equal((await f.beat({ usable: false })).status, 200);
      assert.deepEqual(f.meter.batches[0].map(r => r.changes), [1, 1, 1]);
      assert.deepEqual(f.meter.batches[0].map(r => r.rows), [1, mask & 1 ? 1 : 3, mask & 2 ? 1 : 3]);
      const actual = await f.counters();
      assert.equal(actual.find(r => r.user_id === f.t.alice.id).count, mask & 1 ? 5 : 1);
      assert.equal(actual.find(r => r.user_id === HEARTBEAT_GLOBAL_ID).count, mask & 2 ? 5 : 1);
      assert.equal((await f.telemetry()).usable, 0);
      assert.equal(f.meter.writes.filter(r => /INSERT INTO write_budget/.test(r.sql)).length, 2, 'no postcommit accounting fallback ran');
    });
  }
});

test('SPRINT real D1: late competing heartbeat leaves both counters unchanged for every loser', async c => {
  const f = await fixture(c, 'hb-sprint-window');
  const racers = 8;
  let arrived = 0, release;
  const gate = new Promise(r => { release = r; });
  f.meter.beforeAdmission = async () => { if (++arrived === racers) release(); await gate; };
  const result = await Promise.all(Array.from({ length: racers }, () => f.beat()));
  assert.equal(result.filter(r => r.status === 200).length, 1);
  assert.equal(result.filter(r => r.status === 429 && r.json.code === 'HEARTBEAT_TOO_SOON').length, racers - 1);
  assert.equal(f.meter.batches.filter(b => b.every(r => r.changes === 1)).length, 1);
  assert.equal(f.meter.batches.filter(b => b.every(r => r.changes === 0 && r.rows === 0)).length, racers - 1);
  assert.ok((await f.counters()).every(r => r.count === 1));
});

test('SPRINT real D1: revoke, expire, disable, move and rebind after probes fail admission without accounting', async c => {
  for (const change of ['revoke', 'expire', 'disable', 'move', 'rebind']) {
    await c.test(change, async c => {
      const f = await fixture(c, 'hb-sprint-race-' + change);
      f.meter.beforeAdmission = async () => {
        if (change === 'revoke') await f.db.prepare('UPDATE key_verifiers SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), f.key.id).run();
        if (change === 'expire') await f.db.prepare('UPDATE key_verifiers SET expires_at = ? WHERE id = ?').bind('2000-01-01T00:00:00.000Z', f.key.id).run();
        if (change === 'disable') await f.db.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').bind(f.t.alice.id).run();
        if (change === 'move') await f.db.prepare('UPDATE resources SET owner_id = ? WHERE id = ?').bind(f.t.bob.id, f.resource.id).run();
        if (change === 'rebind') await f.db.prepare('UPDATE key_verifiers SET resource_id = NULL WHERE id = ?').bind(f.key.id).run();
      };
      const out = await f.beat();
      assert.equal(out.status, ['move', 'rebind'].includes(change) ? 404 : 401, out.text);
      assert.equal((await f.telemetry()).heartbeat_at, null);
      assert.deepEqual(await f.counters(), []);
      assert.deepEqual(f.meter.batches[0], Array.from({ length: 3 }, () => ({ changes: 0, rows: 0 })));
      assert.equal(f.meter.writes.reduce((sum, r) => sum + r.rows, 0), 0);
    });
  }
});

test('SPRINT real D1: constraint failure after accounting rolls back resource and both counters', async c => {
  const f = await fixture(c, 'hb-sprint-rollback');
  f.meter.appendFailure = true;
  const result = await f.beat();
  assert.equal(result.status, 500);
  assert.equal((await f.telemetry()).heartbeat_at, null);
  assert.deepEqual(await f.counters(), []);
  f.meter.appendFailure = false;
  assert.equal((await f.beat()).status, 200, 'retry is not falsely rate-limited after rollback');
  assert.ok((await f.counters()).every(r => r.count === 1));
});

test('SPRINT real D1: prune rows_written includes indexed bucket removal', async c => {
  const f = await fixture(c, 'hb-sprint-prune');
  await f.db.prepare('INSERT INTO write_budget(user_id, window, count) VALUES (?, ?, 1)').bind(f.t.alice.id, 'hb/2000-01-01T00').run();
  assert.equal((await f.beat()).status, 200);
  const prune = f.meter.writes.find(r => /^DELETE FROM write_budget WHERE window LIKE/.test(r.sql));
  assert.equal(prune.changes, 1);
  assert.equal(prune.rows, 1, 'the documented amortized deletion cost is one row per old bucket');
  console.log('SPRINT indexed bucket prune:', JSON.stringify(prune));
  assert.equal((await f.db.prepare('SELECT count(*) n FROM write_budget WHERE window = ?').bind('hb/2000-01-01T00').first()).n, 0);
});

test('SPRINT real D1: heartbeat scope remains confined and stale telemetry cannot advertise usability', async c => {
  const f = await fixture(c, 'hb-sprint-scope-stale');
  const headers = { Authorization: 'Bearer ' + f.key.secret, 'X-Aipster-CSRF': '1' };
  for (const [method, path] of [
    ['GET', '/api/inventory'], ['GET', '/api/status'], ['GET', '/api/keys'],
    ['GET', '/api/grants'], ['GET', '/api/usage'], ['GET', '/api/settings'],
    ['POST', '/api/inventory'], ['POST', '/api/keys'], ['POST', '/api/grants'],
    ['POST', '/api/jobs'], ['DELETE', '/api/keys/' + f.key.id],
  ]) {
    const out = await readJson(await f.t.call(path, { method, headers, ...(method === 'POST' ? { body: {} } : {}) }));
    assert.equal(out.status, 403, method + ' ' + path + ': ' + out.text);
    assert.ok(['KEY_SCOPE', 'KEY_FORBIDDEN'].includes(out.json.code), 'scope or session-only guard: ' + out.text);
  }
  assert.equal(f.meter.writes.reduce((sum, r) => sum + r.rows, 0), 0, 'scope failures wrote no rows');
  assert.deepEqual(await f.counters(), []);
  assert.equal((await f.beat()).status, 200);
  await f.db.prepare('UPDATE resources SET heartbeat_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - 6 * 60 * 1000).toISOString(), f.resource.id).run();
  const before = await f.counters();
  const status = await readJson(await f.t.call('/api/status', { headers: f.t.as(f.t.alice) }));
  assert.equal(status.json.summary.online, 0);
  assert.equal(status.json.summary.stale, 1);
  assert.equal(status.json.items[0].liveness, 'stale');
  const inventory = await readJson(await f.t.call('/api/inventory', { headers: f.t.as(f.t.alice) }));
  assert.equal(inventory.json.items[0].state.online, false);
  assert.equal(inventory.json.items[0].state.usable, false);
  assert.deepEqual(await f.counters(), before, 'read-only freshness projection charges no heartbeat budget');
  assert.equal((await f.beat({ usable: false })).status, 200);
  const row = await f.db.prepare('SELECT online, usable, authenticated FROM resources WHERE id = ?').bind(f.resource.id).first();
  assert.deepEqual(row, { online: 1, usable: 0, authenticated: 0 }, 'reachability does not confer authentication or inference readiness');
});

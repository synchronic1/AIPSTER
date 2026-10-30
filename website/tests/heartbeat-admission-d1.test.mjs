/* Atomic heartbeat admission on REAL local D1 (Miniflare, outbound
 * blocked, synthetic data only). Codex PR #20 PRRT_kwDOVYKI0c6xZvYv: with
 * separate owner and global claims, requests that lost the global race at
 * cap-1 had already written their owner counter (owner=10, global=1). The
 * admission is now one batch, so these tests assert BOTH counter deltas,
 * the resource writes, and the D1-reported rows_written of every statement
 * the worker runs. A barrier holds every racer at the admission batch until
 * all of them have passed the read-only probes, so the race is the worst
 * case rather than a lucky interleaving. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createTestEnv, readJson, MIGRATION_FILES } from './d1-shim.mjs';
import { heartbeatWindow, HEARTBEAT_GLOBAL_ID } from '../src/lib/quotas.js';

async function register(t, user, name) {
  const res = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: { ...t.as(user), ...t.csrf },
    body: { name, kind: 'local', origin: 'lab', cpu: 'x', gpu: 'y' },
  }));
  assert.equal(res.status, 201, res.text);
  return res.json;
}

async function mintHeartbeat(t, user, resourceId) {
  const out = await readJson(await t.call('/api/keys', {
    method: 'POST', headers: { ...t.as(user), ...t.csrf }, body: { name: 'hb', scope: 'heartbeat', resourceId },
  }));
  assert.equal(out.status, 201, out.text);
  return out.json;
}

const beat = (t, secret, id, body = { usable: true }) => t.call(
  `/api/resources/${id}/heartbeat`,
  { method: 'POST', headers: { Authorization: 'Bearer ' + secret }, body: JSON.stringify(body) },
);

async function fleet(t, owners, perOwner) {
  const out = [];
  for (const user of owners) {
    for (let i = 0; i < perOwner; i++) {
      const r = await register(t, user, `${user.id}-box-${i}`);
      out.push({ user, id: r.id, secret: (await mintHeartbeat(t, user, r.id)).secret });
    }
  }
  return out;
}

const seed = (t, id, count) => t.sqlite.prepare('INSERT INTO write_budget (user_id, window, count) VALUES (?, ?, ?)').run(id, heartbeatWindow(), count);

// Copy the shim database into a real local D1 and point the worker at a
// metering wrapper: every run()/batch() result's meta.rows_written is
// summed, and batch() can be held at a barrier.
async function toRealD1(t, name) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("x")}}',
    compatibilityDate: '2026-10-01', d1Databases: { DB: name }, outboundService: () => new Response('blocked', { status: 403 }) }));
  const db = await mf.getD1Database('DB');
  for (const file of MIGRATION_FILES) {
    const sql = (await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8')).split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    for (const stmt of sql.split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) await db.exec(stmt);
  }
  const stmts = [db.prepare('PRAGMA defer_foreign_keys = ON')];
  for (const { name: table } of t.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all())
    for (const row of t.sqlite.prepare(`SELECT * FROM "${table}"`).all()) { const c = Object.keys(row);
      stmts.push(db.prepare(`INSERT INTO "${table}" (${c.map(x => `"${x}"`).join(',')}) VALUES (${c.map(() => '?').join(',')})`).bind(...c.map(x => row[x]))); }
  await db.batch(stmts);
  const meter = { rowsWritten: 0, writes: [], barrier: null };
  const note = (sql, res) => {
    const n = Number(res && res.meta && res.meta.rows_written) || 0;
    if (n) { meter.rowsWritten += n; meter.writes.push({ sql: sql.replace(/\s+/g, ' ').slice(0, 60), n }); }
    return res;
  };
  const wrap = (stmt, sql) => ({
    bind: (...p) => wrap(stmt.bind(...p), sql),
    first: (...a) => stmt.first(...a),
    all: async () => note(sql, await stmt.all()),
    run: async () => note(sql, await stmt.run()),
    raw: (...a) => stmt.raw(...a),
    inner: stmt,
    sql,
  });
  const metered = {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    exec: (sql) => db.exec(sql),
    async batch(list) {
      // Only the heartbeat admission batch waits at the barrier (Better
      // Auth also batches during its first-request schema introspection).
      if (meter.barrier && /UPDATE resources SET heartbeat_at/.test(list[0].sql || '')) await meter.barrier();
      const out = await db.batch(list.map(s => s.inner || s));
      note('batch', { meta: { rows_written: out.reduce((s, r) => s + (Number(r.meta && r.meta.rows_written) || 0), 0) } });
      return out;
    },
  };
  t.env.DB = metered; t.DB = db;
  return { mf, meter };
}

function barrier(n) {
  let arrived = 0, release;
  const gate = new Promise(r => { release = r; });
  return async () => { if (++arrived >= n) release(); await gate; };
}

const count = async (t, id) => {
  const row = await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind(id, heartbeatWindow()).first();
  return row ? row.count : 0;
};
const beatsLanded = async (t, ids) => (await t.DB.prepare(
  `SELECT COUNT(*) n FROM resources WHERE heartbeat_at IS NOT NULL AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).first()).n;

test('REAL D1: Codex repro, global cap 1, ten same-owner racers: owner = global = accepted = 1', async (c) => {
  const t = await createTestEnv({ HEARTBEAT_OWNER_PER_HOUR: '500', HEARTBEAT_GLOBAL_PER_HOUR: '1' });
  const boxes = await fleet(t, [t.alice], 10);
  seed(t, t.alice.id, 0); seed(t, HEARTBEAT_GLOBAL_ID, 0);
  const { mf, meter } = await toRealD1(t, 'hb-adm-repro'); c.after(() => mf.dispose());
  meter.barrier = barrier(10);
  const results = await Promise.all((await Promise.all(boxes.map(b => beat(t, b.secret, b.id)))).map(readJson));
  const accepted = results.filter(o => o.status === 200).length;
  assert.equal(accepted, 1);
  assert.ok(results.filter(o => o.status !== 200).every(o => o.status === 429 && o.json.code === 'HEARTBEAT_GLOBAL_QUOTA'));
  assert.equal(await count(t, t.alice.id), 1, 'owner counter moved only for the accepted heartbeat');
  assert.equal(await count(t, HEARTBEAT_GLOBAL_ID), 1);
  assert.equal(await beatsLanded(t, boxes.map(b => b.id)), 1);
  const intake = meter.writes.filter(w => w.sql === 'batch');
  assert.equal(intake.reduce((s, w) => s + w.n, 0), 3, 'the admission batches wrote exactly 3 rows in total (1 resource + 2 counters)');
});

test('REAL D1: multi-owner racers at global cap-1 admit exactly one, losers write zero rows', async (c) => {
  const t = await createTestEnv({ HEARTBEAT_OWNER_PER_HOUR: '500', HEARTBEAT_GLOBAL_PER_HOUR: '5' });
  const boxes = await fleet(t, [t.alice, t.bob], 6);
  seed(t, HEARTBEAT_GLOBAL_ID, 4);
  const { mf, meter } = await toRealD1(t, 'hb-adm-multi'); c.after(() => mf.dispose());
  meter.barrier = barrier(boxes.length);
  const results = await Promise.all((await Promise.all(boxes.map(b => beat(t, b.secret, b.id)))).map(readJson));
  assert.equal(results.filter(o => o.status === 200).length, 1);
  assert.equal(await count(t, HEARTBEAT_GLOBAL_ID), 5);
  assert.equal((await count(t, t.alice.id)) + (await count(t, t.bob.id)), 1, 'owner deltas sum to the one accepted heartbeat');
  assert.equal(await beatsLanded(t, boxes.map(b => b.id)), 1);
  // The one winner writes 1 resource row + 2 counter rows, plus 2 index
  // entries for the owner bucket it creates; every losing batch writes 0.
  assert.equal(meter.writes.filter(w => w.sql === 'batch').length, 1, 'exactly one admission batch wrote rows; losers wrote nothing');
});

test('REAL D1: same-owner racers at OWNER cap-1 admit exactly one and never touch the global bucket beyond it', async (c) => {
  const t = await createTestEnv({ HEARTBEAT_OWNER_PER_HOUR: '3', HEARTBEAT_GLOBAL_PER_HOUR: '1000' });
  const boxes = await fleet(t, [t.alice], 8);
  seed(t, t.alice.id, 2); seed(t, HEARTBEAT_GLOBAL_ID, 2);
  const { mf, meter } = await toRealD1(t, 'hb-adm-owner'); c.after(() => mf.dispose());
  meter.barrier = barrier(8);
  const results = await Promise.all((await Promise.all(boxes.map(b => beat(t, b.secret, b.id)))).map(readJson));
  assert.equal(results.filter(o => o.status === 200).length, 1);
  assert.ok(results.filter(o => o.status !== 200).every(o => o.json.code === 'HEARTBEAT_OWNER_QUOTA'));
  assert.equal(await count(t, t.alice.id), 3);
  assert.equal(await count(t, HEARTBEAT_GLOBAL_ID), 3, 'owner-capped losers consumed no deployment budget');
});

test('REAL D1: sustained rejection is write-free; total writes are bounded by accepted heartbeats', async (c) => {
  // Bound under test, per UTC hour: rows_written <= 3 * accepted (resource +
  // two counters) + 2 more per new bucket (primary-key and window index
  // entries; real D1 reports a new bucket as 3 rows) + 1 coarse
  // last_used_at per key + rows pruned from past hours. Rejections add 0.
  const t = await createTestEnv({ HEARTBEAT_OWNER_PER_HOUR: '2', HEARTBEAT_GLOBAL_PER_HOUR: '3' });
  const boxes = await fleet(t, [t.alice, t.bob], 4);
  const { mf, meter } = await toRealD1(t, 'hb-adm-sustained'); c.after(() => mf.dispose());
  let accepted = 0, rejected = 0;
  for (let round = 0; round < 25; round++) {
    for (const b of boxes) {
      const o = await readJson(await beat(t, b.secret, b.id));
      if (o.status === 200) accepted++; else { rejected++; assert.equal(o.status, 429, o.text); }
    }
  }
  assert.equal(accepted, 3, 'global cap bounds accepted heartbeats');
  assert.equal(rejected, 25 * boxes.length - 3);
  assert.equal(await count(t, HEARTBEAT_GLOBAL_ID), 3);
  assert.equal((await count(t, t.alice.id)) + (await count(t, t.bob.id)), 3);
  const keyTouches = meter.writes.filter(w => /UPDATE key_verifiers SET last_used_at/.test(w.sql)).reduce((s, w) => s + w.n, 0);
  assert.ok(keyTouches <= boxes.length, 'last_used_at refresh is at most once per key per hour');
  const buckets = 3; // alice, bob, global
  const bound = 3 * accepted + 2 * buckets + boxes.length;
  assert.ok(meter.writes.filter(w => w.sql === 'batch').length === accepted, 'only accepted admissions wrote');
  assert.ok(meter.rowsWritten <= bound, `rows_written ${meter.rowsWritten} <= bound ${bound} across ${rejected} rejections`);
  const before = meter.rowsWritten;
  for (let i = 0; i < 100; i++) assert.equal((await readJson(await beat(t, boxes[i % boxes.length].secret, boxes[i % boxes.length].id))).status, 429);
  assert.equal(meter.rowsWritten, before, '100 more rejected heartbeats wrote zero rows');
});

test('REAL D1: revoked, expired, disabled-owner and foreign-resource heartbeats write zero rows', async (c) => {
  // A bound resource cannot be deleted at all: key_verifiers.resource_id
  // REFERENCES resources(id) (0013) and D1 enforces it (asserted below).
  // The reachable "resource is gone for this key" state is a row that no
  // longer belongs to the key's owner, which the same predicate rejects.
  const t = await createTestEnv({ HEARTBEAT_OWNER_PER_HOUR: '500', HEARTBEAT_GLOBAL_PER_HOUR: '1000' });
  const [revoked, expired, disabled, moved] = await fleet(t, [t.alice], 4);
  const bobBox = (await fleet(t, [t.bob], 1))[0];
  const { mf, meter } = await toRealD1(t, 'hb-adm-dead'); c.after(() => mf.dispose());
  // Warm every key's coarse last_used_at so later rejections cannot be
  // masked by that hourly refresh.
  for (const b of [revoked, expired, moved, bobBox]) assert.equal((await readJson(await beat(t, b.secret, b.id))).status, 200);
  const [{ id: revokedKey }] = (await t.DB.prepare('SELECT id FROM key_verifiers WHERE resource_id = ?').bind(revoked.id).all()).results;
  const [{ id: expiredKey }] = (await t.DB.prepare('SELECT id FROM key_verifiers WHERE resource_id = ?').bind(expired.id).all()).results;
  await t.DB.prepare('UPDATE key_verifiers SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), revokedKey).run();
  await t.DB.prepare('UPDATE key_verifiers SET expires_at = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), expiredKey).run();
  await assert.rejects(t.DB.prepare('DELETE FROM resources WHERE id = ?').bind(moved.id).run(), /FOREIGN KEY/);
  await t.DB.prepare('UPDATE resources SET owner_id = ? WHERE id = ?').bind(t.bob.id, moved.id).run();
  await t.DB.prepare('UPDATE resources SET heartbeat_at = NULL').run();
  const counters = async () => (await t.DB.prepare("SELECT user_id, count FROM write_budget WHERE window = ? ORDER BY user_id").bind(heartbeatWindow()).all()).results;
  const beforeCounters = await counters();
  const before = meter.rowsWritten;
  for (let i = 0; i < 20; i++) {
    assert.equal((await readJson(await beat(t, revoked.secret, revoked.id))).status, 401);
    assert.equal((await readJson(await beat(t, expired.secret, expired.id))).status, 401);
    assert.equal((await readJson(await beat(t, moved.secret, moved.id))).status, 404);
  }
  await t.DB.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').bind(t.alice.id).run();
  const afterDisable = meter.rowsWritten;
  for (let i = 0; i < 20; i++) assert.equal((await readJson(await beat(t, disabled.secret, disabled.id))).status, 401);
  assert.equal(meter.rowsWritten, before, 'dead-key/resource rejections wrote zero rows');
  assert.equal(meter.rowsWritten, afterDisable, 'disabled-owner rejections wrote zero rows');
  assert.deepEqual(await counters(), beforeCounters, 'no counter moved');
  assert.equal((await readJson(await beat(t, bobBox.secret, bobBox.id))).status, 200, 'other owners are unaffected');
});

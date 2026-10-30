/* Handoff fix 3 (P2 security): configurable per-owner AND deployment-wide
 * hourly heartbeat ceilings, enforced by atomic claims. 429s carry
 * Retry-After; failed claims leave the resource row untouched. Placeholder
 * defaults live in quotas.js (production numbers belong to release review);
 * these tests pin behavior through small env overrides. All keys are
 * disposable local test fixtures — never production credentials. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createTestEnv, readJson, MIGRATION_FILES } from './d1-shim.mjs';
import { budgetWindow, heartbeatWindow } from '../src/lib/quotas.js';

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

const ageWindow = (t, id) => t.DB.prepare('UPDATE resources SET heartbeat_at = ? WHERE id = ?')
  .bind(new Date(Date.now() - 26000).toISOString(), id).run();

async function toRealD1(t) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("x")}}',
    compatibilityDate: '2026-10-01', d1Databases: { DB: 'hb-quota' }, outboundService: () => new Response('blocked', { status: 403 }) }));
  const db = await mf.getD1Database('DB');
  for (const file of MIGRATION_FILES) {
    const sql = (await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8')).split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    for (const stmt of sql.split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) await db.exec(stmt);
  }
  const stmts = [db.prepare('PRAGMA defer_foreign_keys = ON')];
  for (const { name } of t.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all())
    for (const row of t.sqlite.prepare(`SELECT * FROM "${name}"`).all()) { const c = Object.keys(row);
      stmts.push(db.prepare(`INSERT INTO "${name}" (${c.map(x => `"${x}"`).join(',')}) VALUES (${c.map(() => '?').join(',')})`).bind(...c.map(x => row[x]))); }
  await db.batch(stmts);
  t.env.DB = db; t.DB = db; return mf;
}

test('exhausted per-owner cap: 429 OWNER_QUOTA with Retry-After, row unchanged', async () => {
  const t = await createTestEnv({ HEARTBEAT_OWNER_PER_HOUR: '1', HEARTBEAT_GLOBAL_PER_HOUR: '100000' });
  const r = await register(t, t.alice, 'box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  assert.equal((await readJson(await beat(t, key.secret, r.id))).status, 200);
  await ageWindow(t, r.id);
  const before = await t.DB.prepare('SELECT heartbeat_at, online, usable FROM resources WHERE id = ?').bind(r.id).first();
  const out = await readJson(await beat(t, key.secret, r.id, { usable: false }));
  assert.equal(out.status, 429);
  assert.equal(out.json.code, 'HEARTBEAT_OWNER_QUOTA');
  assert.ok(out.headers.get('Retry-After'), 'Retry-After header set');
  assert.equal(Number(out.headers.get('Retry-After')), out.json.retryAfterSec);
  const after = await t.DB.prepare('SELECT heartbeat_at, online, usable FROM resources WHERE id = ?').bind(r.id).first();
  assert.deepEqual(after, before, 'refused heartbeat changes zero columns');
  const bucket = await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind(t.alice.id, heartbeatWindow()).first();
  assert.equal(bucket.count, 1, 'only the accepted heartbeat was counted');
});

test('global ceiling refuses other owners too', async () => {
  const t = await createTestEnv({ HEARTBEAT_OWNER_PER_HOUR: '100000', HEARTBEAT_GLOBAL_PER_HOUR: '1' });
  const a = await register(t, t.alice, 'alice-box');
  const b = await register(t, t.bob, 'bob-box');
  const ka = await mintHeartbeat(t, t.alice, a.id);
  const kb = await mintHeartbeat(t, t.bob, b.id);
  assert.equal((await readJson(await beat(t, ka.secret, a.id))).status, 200);
  const refused = await readJson(await beat(t, kb.secret, b.id));
  assert.equal(refused.status, 429);
  assert.equal(refused.json.code, 'HEARTBEAT_GLOBAL_QUOTA');
  assert.ok(refused.headers.get('Retry-After'), 'Retry-After header set');
  assert.equal((await t.DB.prepare('SELECT heartbeat_at FROM resources WHERE id = ?').bind(b.id).first()).heartbeat_at, null);
  // The owner who spent the global budget is refused on their next resource too.
  const a2 = await register(t, t.alice, 'alice-box-2');
  const ka2 = await mintHeartbeat(t, t.alice, a2.id);
  const again = await readJson(await beat(t, ka2.secret, a2.id));
  assert.equal(again.status, 429);
  assert.equal(again.json.code, 'HEARTBEAT_GLOBAL_QUOTA');
});

test('REAL D1: 10 concurrent heartbeats at cap-1 produce exactly one accepted', async (c) => {
  const t = await createTestEnv({ HEARTBEAT_OWNER_PER_HOUR: '100000', HEARTBEAT_GLOBAL_PER_HOUR: '1' });
  const r = await register(t, t.alice, 'box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  const mf = await toRealD1(t); c.after(() => mf.dispose());
  const responses = await Promise.all(Array.from({ length: 10 }, () => beat(t, key.secret, r.id)));
  const results = await Promise.all(responses.map((res) => readJson(res)));
  assert.equal(results.filter((o) => o.status === 200).length, 1, 'exactly one burst member wins the atomic claims');
  const losers = results.filter((o) => o.status !== 200);
  assert.equal(losers.length, 9);
  assert.ok(losers.every((o) => o.status === 429 && o.json.code === 'HEARTBEAT_GLOBAL_QUOTA' && o.headers.get('Retry-After')),
    'every loser is a quota 429 with Retry-After, never a second write');
  const winner = results.find((o) => o.status === 200);
  const row = await t.DB.prepare('SELECT heartbeat_at FROM resources WHERE id = ?').bind(r.id).first();
  assert.equal(row.heartbeat_at, winner.json.heartbeatAt);
  const owner = await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind(t.alice.id, heartbeatWindow()).first();
  const global = await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind('heartbeat:global', heartbeatWindow()).first();
  assert.equal(owner.count, 1, 'owner bucket moved only with the accepted heartbeat (atomic admission)');
  assert.equal(global.count, 1, 'global bucket holds exactly the accepted heartbeat');
});

test('heartbeat budgets stay separate from the 120/hour write budget', async () => {
  // This direction: a spent heartbeat budget leaves normal writes working
  // (the reverse — heartbeats working at a spent write budget — is covered
  // by heartbeat.test.mjs 'heartbeats never draw the hourly write budget').
  const t = await createTestEnv({ HEARTBEAT_OWNER_PER_HOUR: '1', HEARTBEAT_GLOBAL_PER_HOUR: '100000' });
  const r = await register(t, t.alice, 'box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  assert.equal((await readJson(await beat(t, key.secret, r.id))).status, 200);
  await ageWindow(t, r.id);
  const refused = await readJson(await beat(t, key.secret, r.id));
  assert.equal(refused.status, 429);
  assert.equal(refused.json.code, 'HEARTBEAT_OWNER_QUOTA');
  const second = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'second-box' },
  }));
  assert.equal(second.status, 201, 'normal writes work at a spent heartbeat budget');
  const writes = await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind(t.alice.id, budgetWindow()).first();
  assert.equal(writes.count, 3, 'write bucket holds register+mint+register only (no heartbeat draws)');
  const hb = await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind(t.alice.id, heartbeatWindow()).first();
  assert.equal(hb.count, 1, 'heartbeat bucket holds the accepted heartbeat only');
});

test('spent global ceiling rejects read-only: no owner claim/refund write loop', async () => {
  // Codex PR #20 r4407568064 / r4407276171-follow-up: with the global
  // bucket spent, each rejected heartbeat used to claim and then refund the
  // owner bucket (2 writes, net zero), so the owner never ran out and the
  // 429s were an unbounded write loop. A spent global bucket must now
  // reject before any budget write.
  const t = await createTestEnv({ HEARTBEAT_OWNER_PER_HOUR: '5', HEARTBEAT_GLOBAL_PER_HOUR: '1' });
  const a = await register(t, t.alice, 'alice-box');
  const b = await register(t, t.bob, 'bob-box');
  const ka = await mintHeartbeat(t, t.alice, a.id);
  const kb = await mintHeartbeat(t, t.bob, b.id);
  assert.equal((await readJson(await beat(t, ka.secret, a.id))).status, 200);
  for (let i = 0; i < 25; i++) {
    const out = await readJson(await beat(t, kb.secret, b.id));
    assert.equal(out.status, 429);
    assert.equal(out.json.code, 'HEARTBEAT_GLOBAL_QUOTA');
  }
  const bobBucket = await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind(t.bob.id, heartbeatWindow()).first();
  assert.equal(bobBucket, null, 'no owner bucket row was created or touched for read-only rejections');
  const global = await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind('heartbeat:global', heartbeatWindow()).first();
  assert.equal(global.count, 1);
});

test('a lost resource race writes nothing: counters move only with an accepted heartbeat', async () => {
  // Admission is one batch: the resource UPDATE and both counter upserts
  // commit together or not at all, so a request that loses the 25s window
  // race after passing the read-only probe charges no bucket.
  const t = await createTestEnv({ HEARTBEAT_OWNER_PER_HOUR: '100000', HEARTBEAT_GLOBAL_PER_HOUR: '100000' });
  const r = await register(t, t.alice, 'box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  // Simulate a racer that passed the read-only window probe: open the
  // window, then let a concurrent winner land before our admission by
  // stamping heartbeat_at between probe and batch via a patched prepare.
  const realPrepare = t.DB.prepare.bind(t.DB);
  let armed = true;
  t.DB.prepare = (sql) => {
    if (armed && /^\s*UPDATE resources SET heartbeat_at/.test(sql)) {
      armed = false;
      t.sqlite.prepare('UPDATE resources SET heartbeat_at = ? WHERE id = ?').run(new Date().toISOString(), r.id);
    }
    return realPrepare(sql);
  };
  const lost = await readJson(await beat(t, key.secret, r.id));
  t.DB.prepare = realPrepare;
  assert.equal(lost.status, 429);
  assert.equal(lost.json.code, 'HEARTBEAT_TOO_SOON');
  const owner = await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind(t.alice.id, heartbeatWindow()).first();
  const global = await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind('heartbeat:global', heartbeatWindow()).first();
  assert.equal(owner, null, 'no owner bucket was created or charged');
  assert.equal(global, null, 'no global bucket was created or charged');
});

test('a committed heartbeat whose counter upsert did not register is still charged once', async () => {
  // Independent review P3: if production D1 ever failed to chain changes()
  // into a counter upsert, the accepted heartbeat must not stay uncharged.
  const t = await createTestEnv({ HEARTBEAT_OWNER_PER_HOUR: '100000', HEARTBEAT_GLOBAL_PER_HOUR: '100000' });
  const r = await register(t, t.alice, 'box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  const realBatch = t.DB.batch.bind(t.DB);
  t.DB.batch = async (stmts) => {
    if (!/UPDATE resources SET heartbeat_at/.test(stmts[0].sql || '')) return realBatch(stmts);
    // Drop the owner upsert: the batch commits the resource write and the
    // global charge, and reports zero changes for the owner statement.
    const [resource, global] = await realBatch([stmts[0], stmts[2]]);
    return [resource, { success: true, meta: { changes: 0 } }, global];
  };
  const out = await readJson(await beat(t, key.secret, r.id));
  t.DB.batch = realBatch;
  assert.equal(out.status, 200, out.text);
  const owner = await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind(t.alice.id, heartbeatWindow()).first();
  const global = await t.DB.prepare('SELECT count FROM write_budget WHERE user_id = ? AND window = ?').bind('heartbeat:global', heartbeatWindow()).first();
  assert.equal(owner.count, 1, 'the missing owner charge was completed');
  assert.equal(global.count, 1, 'the global charge was not doubled');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairingEnv, mint, claim, paired, snapshot, hookDb } from './pairing-review-fixtures.mjs';
import { budgetWindow } from '../src/lib/quotas.js';

const state = async t => ({ ...await snapshot(t),
  budget: (await t.DB.prepare('SELECT * FROM write_budget ORDER BY user_id,window').all()).results,
  audit: (await t.DB.prepare('SELECT * FROM audit ORDER BY id').all()).results });
const isClaim = stmts => stmts.some(s => /UPDATE pairing_codes SET used_at/.test(s.sql));
const isMint = stmts => stmts.some(s => /INSERT INTO pairing_codes/.test(s.sql));
for (const real of [false, true]) {
  const engine = real ? 'local D1' : 'sqlite';
  for (const existing of [false, true]) test(`${engine}: overlapping same-code claims recover ${existing ? 'existing' : 'new'} node`, async c => {
    const t = await pairingEnv(c, real); c.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    if (existing) await paired(t);
    const code = await mint(t), db = t.DB;
    let entered = 0, release; const gate = new Promise(r => release = r);
    t.env.DB = hookDb(db, { beforeBatch: async stmts => { if (isClaim(stmts) && ++entered <= 2) { if (entered === 2) release(); await gate; } } });
    const results = await Promise.all([claim(t, code.json.code), claim(t, code.json.code)]);
    assert.deepEqual(results.map(r => r.status).sort(), existing ? [200, 200] : [200, 201]);
    assert.equal(results[0].json.resourceId, results[1].json.resourceId);
    const live = (await db.prepare('SELECT id FROM key_verifiers WHERE revoked_at IS NULL').all()).results;
    assert.equal(live.length, 1); assert.ok(results.some(r => r.json.keyId === live[0].id));
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM resources').first()).n, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM audit WHERE action='pairing.claim'").first()).n, existing ? 3 : 2);
  });
  test(`${engine}: mint audit failure leaves no orphan code or admission charge`, async c => {
    const t = await pairingEnv(c, real), before = await state(t);
    await t.DB.prepare("CREATE TRIGGER mint_fault BEFORE INSERT ON audit WHEN NEW.action='pairing.code.create' BEGIN SELECT RAISE(ABORT,'synthetic mint fault'); END").run();
    for (let n = 0; n < 6; n++) { assert.equal((await mint(t)).status, 500); assert.deepEqual(await state(t), before); }
    await t.DB.prepare('DROP TRIGGER mint_fault').run(); assert.equal((await mint(t)).status, 201);
    const after = await state(t); assert.equal(after.codes.length, 1); assert.equal(after.budget[0].count, 1); assert.equal(after.audit.length, 1);
  });
  test(`${engine}: rejected mint at active-code cap is read-only`, async c => {
    const t = await pairingEnv(c, real);
    for (let n = 0; n < 5; n++) assert.equal((await mint(t)).status, 201);
    const before = await state(t);
    for (let n = 0; n < 3; n++) assert.equal((await mint(t)).status, 409);
    assert.deepEqual(await state(t), before);
  });
  for (const boundary of ['quota', 'slot']) test(`${engine}: concurrent mints serialize final ${boundary}`, async c => {
    const t = await pairingEnv(c, real); c.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    if (boundary === 'quota') await t.DB.prepare('INSERT INTO write_budget VALUES(?,?,119)').bind(t.alice.id, budgetWindow()).run();
    else for (let n = 0; n < 4; n++) await mint(t);
    const before = await state(t), db = t.DB;
    let entered = 0, release; const gate = new Promise(r => release = r);
    t.env.DB = hookDb(db, { beforeBatch: async stmts => { if (isMint(stmts)) { if (++entered === 2) release(); await gate; } } });
    const results = await Promise.all([mint(t), mint(t)]);
    assert.deepEqual(results.map(r => r.status).sort(), boundary === 'quota' ? [201, 429] : [201, 409]);
    const after = await state(t); assert.equal(after.codes.length, before.codes.length + 1);
    assert.equal(after.audit.length, before.audit.length + 1); assert.equal(after.budget[0].count, before.budget[0].count + 1);
  });
  test(`${engine}: owner disabled at mint transaction cannot create or charge`, async c => {
    const t = await pairingEnv(c, real), before = await state(t), db = t.DB; let fired = false;
    t.env.DB = hookDb(db, { beforeBatch: async stmts => { if (!fired && isMint(stmts)) { fired = true; await db.prepare('UPDATE "user" SET disabled=1 WHERE id=?').bind(t.alice.id).run(); } } });
    assert.equal((await mint(t)).status, 401); assert.ok(fired); assert.deepEqual(await state(t), before);
  });
  test(`${engine}: concurrent different-node claim cannot use refreshed consent`, async c => {
    const t = await pairingEnv(c, real), code = await mint(t), db = t.DB;
    let entered = 0, release; const gate = new Promise(r => release = r);
    t.env.DB = hookDb(db, { beforeBatch: async stmts => { if (isClaim(stmts) && ++entered <= 2) { if (entered === 2) release(); await gate; } } });
    const results = await Promise.all([claim(t, code.json.code, 'node-a'), claim(t, code.json.code, 'node-b')]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 404]);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM resources').first()).n, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM key_verifiers').first()).n, 1);
  });
}

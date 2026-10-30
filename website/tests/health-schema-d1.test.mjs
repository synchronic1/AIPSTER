// Real, outbound-blocked local D1: readiness must cover the enabled routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createTestEnv, MIGRATION_FILES, readJson } from './d1-shim.mjs';

async function fixture(c, files) {
  const t = await createTestEnv();
  c.after(() => t.sqlite.close());
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: 'export default {fetch(){return new Response("synthetic")}}',
    compatibilityDate: '2026-10-01', d1Databases: { DB: 'health-schema' },
    outboundService: () => { throw new Error('Unexpected outbound request'); },
  }));
  c.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const apply = async file => {
    const sql = (await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'))
      .split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    for (const stmt of sql.split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) await db.exec(stmt);
  };
  for (const file of files) await apply(file);
  // Baseline identity/session rows have the same columns before/after 0013.
  if (files.length) {
    for (const table of ['user', 'session', 'allowlist']) {
      for (const row of t.sqlite.prepare(`SELECT * FROM "${table}"`).all()) {
        const cols = Object.keys(row);
        await db.prepare(`INSERT INTO "${table}" (${cols.map(k => `"${k}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...Object.values(row)).run();
      }
    }
  }
  t.env.DB = db;
  const health = async enabled => {
    t.env.FEDERATION_ENABLED = enabled;
    let probes = 0;
    t.env.DB = { prepare(sql) {
      assert.match(sql, /^SELECT /, 'health executes only read-only SQL');
      const statement = db.prepare(sql);
      return { async all() {
        probes++;
        const result = await statement.all();
        assert.equal(result.meta.rows_written, 0);
        assert.equal(result.meta.rows_read, 0, 'LIMIT 0 does not scan application data');
        return result;
      } };
    } };
    const result = await readJson(await t.call('/api/health'));
    t.env.DB = db;
    assert.equal(probes, 1, 'one bounded schema probe per health call');
    assert.equal(result.status, 200);
    assert.equal(result.json.auth_configured, true);
    assert.equal(typeof result.json.ready, 'boolean');
    assert.equal(typeof result.json.detail.schema, 'boolean');
    assert.ok(Object.values(result.json.detail).every(v => typeof v === 'boolean'));
    assert.doesNotMatch(result.text, /resource_id|fabric_restriction_receipts|SELECT|no such|test-only-better-auth-secret/);
    return result.json;
  };
  return { t, db, apply, health };
}

test('HEALTH real D1: 0001-0005 cannot report ready while all key minting needs 0013', async c => {
  const f = await fixture(c, MIGRATION_FILES.slice(0, 5));
  const before = await f.health(undefined);
  const mint = () => f.t.call('/api/keys', {
    method: 'POST', headers: { ...f.t.as(f.t.alice), ...f.t.csrf }, body: { name: 'synthetic', scope: 'read' },
  }).then(readJson);
  const missing = await mint();
  console.log('HEALTH partial-schema repro:', JSON.stringify({ ready: before.ready, schema: before.detail.schema, keyMintStatus: missing.status }));
  assert.equal(missing.status, 500, 'missing binding column breaks ordinary key creation too');
  assert.equal(before.ready, false);
  assert.equal(before.detail.schema, false);
  await f.apply('0013_heartbeat_binding.sql');
  assert.equal((await f.health(undefined)).ready, false, 'pairing schema is also required');
  await f.apply('0015_pairing.sql');
  assert.equal((await f.health(undefined)).ready, true, 'disabled federation does not require its migrations');
  assert.equal((await mint()).status, 201);
});

test('HEALTH real D1: enabled federation requires the complete schema through restriction receipts', async c => {
  const f = await fixture(c, [...MIGRATION_FILES.slice(0, 5), '0013_heartbeat_binding.sql', '0015_pairing.sql']);
  assert.equal((await f.health('1')).ready, false, 'no federation tables');
  for (const file of MIGRATION_FILES.slice(5, 12)) {
    await f.apply(file);
    assert.equal((await f.health('1')).ready, false, 'partial federation: ' + file);
  }
  assert.equal((await f.health(undefined)).ready, true, 'base routes are ready with heartbeat and pairing migrations');
  await f.apply('0014_fabric_restriction_receipts.sql');
  assert.equal((await f.health('1')).ready, true);
  assert.equal((await f.health('true')).ready, true, 'only the router exact flag value enables federation');
  await f.db.prepare('ALTER TABLE approvals DROP COLUMN consumed_by_op').run();
  assert.equal((await f.health('1')).ready, false, 'table names alone do not prove late approval columns');
  assert.equal((await f.health(undefined)).ready, true);
});

test('HEALTH real D1: full federation without 0013 is unready even with federation disabled', async c => {
  const f = await fixture(c, MIGRATION_FILES.filter(n => n !== '0013_heartbeat_binding.sql'));
  assert.equal((await f.health('1')).ready, false);
  assert.equal((await f.health(undefined)).ready, false);
  await f.apply('0013_heartbeat_binding.sql');
  assert.equal((await f.health('1')).ready, true);
});

test('HEALTH real D1: empty database fails closed and health is read-only', async c => {
  const f = await fixture(c, []);
  const schema = () => f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'").all();
  const before = (await schema()).results;
  assert.equal((await f.health('1')).ready, false);
  assert.deepEqual((await schema()).results, before);
});


test('HEALTH real D1: pairing routes require migration 0015 even with federation disabled', async c => {
  const f = await fixture(c, [...MIGRATION_FILES.slice(0, 5), '0013_heartbeat_binding.sql']);
  const mint = await readJson(await f.t.call('/api/pairing/codes', { method: 'POST', headers: { ...f.t.as(f.t.alice), ...f.t.csrf }, body: {} }));
  assert.equal(mint.status, 500, 'missing pairing table breaks the compiled route');
  assert.equal((await f.health(undefined)).ready, false, 'base heartbeat schema cannot serve the compiled pairing routes');
  await f.apply('0015_pairing.sql');
  assert.equal((await f.health(undefined)).ready, true);
  await f.db.prepare('ALTER TABLE pairing_codes DROP COLUMN attempts').run();
  assert.equal((await f.health(undefined)).ready, false, 'pairing columns are part of readiness');
});

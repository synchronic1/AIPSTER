// Synthetic upgrade from published main's schema; never contacts remote D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { MIGRATION_FILES } from './d1-shim.mjs';

test('real local D1: federation upgrade preserves main signup budget and identity', async () => {
  const files = (await readdir(new URL('../migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort();
  assert.deepEqual(files, MIGRATION_FILES);
  assert.equal(new Set(files.map(f => f.split('_')[0])).size, files.length, 'unique migration numbers');
  assert.equal(files[4], '0005_write_budget.sql');
  assert.equal(files[5], '0006_fabric.sql');
  assert.deepEqual(files.slice(5), [
    '0006_fabric.sql', '0007_consent.sql', '0008_repair2.sql',
    '0009_state_layer.sql', '0010_revision_receipts.sql',
    '0011_fabric_admission.sql', '0012_fabric_restriction_admission.sql',
    '0013_heartbeat_binding.sql', '0014_fabric_restriction_receipts.sql', '0015_pairing.sql',
    '0016_admin.sql', '0017_dgm_preview.sql', '0018_model_catalog.sql', '0019_model_catalog_reservations.sql'
  ]);
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
    script: 'export default {fetch(){return new Response("synthetic upgrade")}}',
    compatibilityDate: '2026-10-01', d1Databases: { DB: 'main-upgrade-synthetic' },
    outboundService: () => new Response('blocked', { status: 403 }) }));
  try {
    const db = await mf.getD1Database('DB');
    const apply = async file => {
      const sql = (await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'))
        .split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
      for (const stmt of sql.split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) await db.exec(stmt);
    };
    for (const file of files.slice(0, 5)) await apply(file);
    await db.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)')
      .bind('upgrade-user', 'Synthetic', 'upgrade@synthetic.invalid', '2026-01-01', '2026-01-01').run();
    await db.prepare('INSERT INTO write_budget(user_id,window,count) VALUES (?,?,?)')
      .bind('upgrade-user', '2026-10-28T00', 17).run();
    const before = await db.prepare('SELECT * FROM "user" WHERE id = ?').bind('upgrade-user').first();
    for (const file of files.slice(5)) await apply(file);
    assert.deepEqual(await db.prepare('SELECT * FROM "user" WHERE id = ?').bind('upgrade-user').first(), before);
    assert.deepEqual(await db.prepare('SELECT * FROM write_budget').first(),
      { user_id: 'upgrade-user', window: '2026-10-28T00', count: 17 });
    for (const table of ['fabric_revision_receipts', 'fabric_revision_failures', 'fabric_restriction_receipts']) {
      assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n, 0);
    }
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
  } finally { await mf.dispose(); }
});

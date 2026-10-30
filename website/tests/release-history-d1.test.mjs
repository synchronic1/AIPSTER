// Also executable unchanged against the failing base plus revision-fixtures.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revisionFixture } from './revision-fixtures.mjs';
test('real local D1: interrupted revision history retains original before-image', async context => {
  const t = await revisionFixture(true); context.after(t.close);
  await t.db.prepare("CREATE TRIGGER original_repro BEFORE INSERT ON fabric_grant_revisions BEGIN SELECT RAISE(ABORT, 'synthetic history failure'); END").run();
  await assert.rejects(t.revise());
  const applied = await t.db.prepare('SELECT * FROM fabric_grants WHERE id = ?').bind(t.grant).first();
  assert.equal(applied.version, 2); assert.equal(JSON.parse(applied.ceilings).maxTokens, 50);
  await t.db.prepare('DROP TRIGGER original_repro').run();
  assert.equal((await t.revise()).status, 200);
  const history = await t.db.prepare('SELECT * FROM fabric_grant_revisions WHERE grant_id = ?').bind(t.grant).first();
  const old = JSON.parse(history.terms_json);
  assert.equal(history.version, 1); assert.equal(history.approval_id, t.input.approvalId);
  assert.deepEqual({ consumers: old.consumers, snapshot: old.snapshot, ceilings: old.ceilings },
    { consumers: JSON.parse(t.before.consumers), snapshot: JSON.parse(t.before.snapshot), ceilings: JSON.parse(t.before.ceilings) });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revisionFixture, faultOnce, assertComplete } from './revision-fixtures.mjs';
import * as core from '../src/fabric/store.mjs';
import { digestJson } from '../src/fabric/canonical.mjs';

// Run the same content-level assertions on the shim and real local workerd D1.
for (const real of [false, true]) {
  const engine = real ? 'local D1' : 'sqlite';
  for (const [name, pattern, phase, batch, applied, recoverable] of [
    ['before approval claim', /UPDATE approvals SET consumed_at/, 'before', false, false, true],
    ['lost approval claim response', /UPDATE approvals SET consumed_at/, 'after', false, false, false],
    ['before effect batch', /UPDATE fabric_grants SET consumers/, 'before', true, false, false],
    ['lost effect batch response', /UPDATE fabric_grants SET consumers/, 'after', true, true, true],
    ['before history insert', /INSERT OR IGNORE INTO fabric_grant_revisions/, 'before', false, true, true],
    ['lost history response', /INSERT OR IGNORE INTO fabric_grant_revisions/, 'after', false, true, true],
    ['before audit insert', /INSERT OR IGNORE INTO audit/, 'before', false, true, true],
    ['lost audit response', /INSERT OR IGNORE INTO audit/, 'after', false, true, true],
  ]) test(`${engine}: revision recovery ${name}`, async context => {
    const t = await revisionFixture(real); context.after(t.close);
    await assert.rejects(t.revise(faultOnce(t.db, pattern, phase, batch)), /synthetic|Request failed/);
    const interrupted = await t.state();
    assert.equal(interrupted.grant.version, applied ? 2 : 1);
    assert.equal(interrupted.receipts.length, applied ? 1 : 0);
    if (!recoverable) {
      if (batch) assert.equal((await t.revise()).status, 409);
      else await assert.rejects(t.revise(), { code: 'REVISION_UNCERTAIN' });
      assert.deepEqual(await t.state(), interrupted, 'uncommitted operation cannot invent a revision');
    } else {
      assert.deepEqual(await t.revise(), { status: 200, body: { id: t.grant, version: 2 } });
      const completed = await t.state(); assertComplete(completed, t.before, t.input);
      assert.equal(completed.generation, 2);
      for (let i = 0; i < 3; i++) assert.equal((await t.revise()).body.version, 2);
      assert.deepEqual(await t.state(), completed, 'repeated retries preserve every persisted field');
    }
  });

  for (const [name, clause] of [
    ['effect update', 'BEFORE UPDATE ON fabric_grants'],
    ['receipt insert', 'BEFORE INSERT ON fabric_revision_receipts'],
    ['generation update', 'BEFORE UPDATE ON connections'],
  ]) test(`${engine}: SQL failure at ${name} rolls back effect and receipt`, async context => {
    const t = await revisionFixture(real); context.after(t.close);
    const before = await t.state();
    await t.db.prepare(`CREATE TRIGGER revision_fault ${clause} BEGIN SELECT RAISE(ABORT, 'synthetic SQL failure'); END`).run();
    await assert.rejects(t.revise(), /Request failed/);
    await t.db.prepare('DROP TRIGGER revision_fault').run();
    assert.deepEqual(await t.state(), before);
    assert.equal((await t.revise()).status, 409);
    assert.deepEqual(await t.state(), before);
  });

  test(`${engine}: intervening revision and concurrent retries retain original full snapshots`, async context => {
    const t = await revisionFixture(real); context.after(t.close);
    await assert.rejects(t.revise(faultOnce(t.db, /INSERT OR IGNORE INTO fabric_grant_revisions/)));
    const afterFirst = (await t.state()).grant;
    const next = await t.approval(25, t.grant);
    const nextOp = { ...t.op, key: 'second-revision-operation' };
    assert.equal((await core.reviseGrant(t.db, t.alice, t.grant, next, nextOp)).body.version, 3);
    const current = (await t.state()).grant;
    const retries = await Promise.all(Array.from({ length: 6 }, () => t.revise()));
    assert.ok(retries.every(r => r.status === 200 && r.body.version === 2));
    const all = await t.state();
    assert.deepEqual(all.grant, current); assert.equal(all.generation, 3);
    assert.equal(all.history.length, 2); assert.equal(all.receipts.length, 2); assert.equal(all.audits.length, 2);
    for (const [i, before, after, input] of [[0, t.before, afterFirst, t.input], [1, afterFirst, current, next]]) {
      assertComplete({ receipts: [all.receipts[i]], history: [all.history[i]],
        audits: all.audits.filter(a => a.detail === `v${i + 2} via session`) }, before, input, after);
    }
    assert.equal((await t.revise()).body.version, 2);
    assert.deepEqual(await t.state(), all);
  });

  test(`${engine}: concurrent claim loser reconciles from winner receipt`, async context => {
    const t = await revisionFixture(real); context.after(t.close);
    let winner;
    const racing = faultOnce(t.db, /UPDATE approvals SET consumed_at/, 'before', false,
      async () => { winner = await t.revise(); });
    assert.deepEqual(await t.revise(racing), winner);
    const s = await t.state(); assertComplete(s, t.before, t.input); assert.equal(s.generation, 2);
  });

  test(`${engine}: a stale effect creates no receipt or phantom generation`, async context => {
    const t = await revisionFixture(real); context.after(t.close);
    const racing = faultOnce(t.db, /UPDATE fabric_grants SET consumers/, 'before', true, async () => {
      assert.equal((await core.pauseGrant(t.db, t.alice, t.grant, { expectedVersion: 1 })).status, 200);
    });
    assert.equal((await t.revise(racing)).status, 412);
    const s = await t.state();
    assert.equal(s.grant.status, 'paused'); assert.equal(s.grant.version, 2); assert.equal(s.generation, 2);
    assert.deepEqual(s.history, []); assert.deepEqual(s.receipts, []); assert.deepEqual(s.audits, []);
  });

  test(`${engine}: replay binds actor, request and operation; revoke remains final`, async context => {
    const t = await revisionFixture(real); context.after(t.close);
    assert.equal((await t.revise()).status, 200);
    const applied = await t.state();
    await assert.rejects(core.reviseGrant(t.db, t.bob, t.grant, t.input, t.op), e => [403, 404].includes(e.status));
    await assert.rejects(core.reviseGrant(t.db, t.alice, t.grant, { ...t.input, previewHash: 'changed' }, t.op), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal((await core.reviseGrant(t.db, t.alice, t.grant, t.input, { ...t.op, key: 'different-operation' })).status, 409);
    await t.db.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').bind(t.alice.user.id).run();
    await assert.rejects(t.revise(), { code: 'AUTH_REQUIRED' });
    await t.db.prepare('UPDATE "user" SET disabled = 0 WHERE id = ?').bind(t.alice.user.id).run();
    assert.deepEqual(await t.state(), applied);
    assert.equal((await core.revokeGrant(t.db, t.alice, t.grant, { expectedVersion: 2 })).status, 200);
    const revoked = await t.state();
    await assert.rejects(t.revise(), { code: 'BAD_STATE' });
    assert.deepEqual(await t.state(), revoked);
  });

  test(`${engine}: pre-receipt applied operation fails closed instead of guessing history`, async context => {
    const t = await revisionFixture(real); context.after(t.close);
    await assert.rejects(t.revise(faultOnce(t.db, /INSERT OR IGNORE INTO fabric_grant_revisions/)));
    // Simulates a pre-upgrade applied grant whose before-image was never saved.
    await t.db.prepare('DELETE FROM fabric_revision_receipts').run();
    const legacy = await t.state();
    await assert.rejects(t.revise(), { code: 'REVISION_UNCERTAIN' });
    assert.deepEqual(await t.state(), legacy);
  });

  test(`${engine}: expired lease cannot finalize failure while original effect is in flight`, async context => {
    const t = await revisionFixture(real); context.after(t.close);
    const hash = await digestJson(t.input), actorKey = 'session:u_alice';
    const gate = () => core.checkIdempotency(t.db, t.alice, 'POST', t.op.path, t.op.key, hash);
    assert.equal(await gate(), null);
    const oldAttempt = await core.readAttempt(t.db, actorKey, t.op.key);
    const racing = faultOnce(t.db, /UPDATE fabric_grants SET consumers/, 'before', true, async () => {
      await t.db.prepare("UPDATE idempotency_records SET created_at = '2000-01-01T00:00:00.000Z' WHERE idem_key = ?").bind(t.op.key).run();
      assert.equal(await gate(), null);
      const takeover = await core.readAttempt(t.db, actorKey, t.op.key);
      assert.notEqual(takeover, oldAttempt);
      await assert.rejects(core.reviseGrant(t.db, t.alice, t.grant, t.input, { ...t.op, attempt: takeover }), { code: 'REVISION_UNCERTAIN' });
      await core.releaseIdempotency(t.db, t.alice, t.op.key, takeover);
    });
    const original = await t.revise(racing);
    await core.storeIdempotency(t.db, t.alice, t.op.key, 200, original.body, oldAttempt);
    assert.equal(await gate(), null);
    const latest = await core.readAttempt(t.db, actorKey, t.op.key);
    const recovered = await t.revise();
    await core.storeIdempotency(t.db, t.alice, t.op.key, 200, recovered.body, latest);
    assert.deepEqual((await gate()).body, original.body);
    const s = await t.state(); assertComplete(s, t.before, t.input); assert.equal(s.generation, 2);
  });

  for (const phase of ['before', 'after']) test(`${engine}: ${phase} failure-fence persistence remains safe`, async context => {
    const t = await revisionFixture(real); context.after(t.close);
    const before = await t.state();
    await t.db.prepare("CREATE TRIGGER failed_effect BEFORE UPDATE ON fabric_grants BEGIN SELECT RAISE(ABORT, 'synthetic'); END").run();
    await assert.rejects(t.revise(faultOnce(t.db, /INSERT OR IGNORE INTO fabric_revision_failures/, phase)), /Request failed/);
    await t.db.prepare('DROP TRIGGER failed_effect').run();
    if (phase === 'before') await assert.rejects(t.revise(), { code: 'REVISION_UNCERTAIN' });
    else assert.equal((await t.revise()).status, 409);
    assert.deepEqual(await t.state(), before);
  });

  test(`${engine}: failure fence prevents a batch arriving after its error response`, async context => {
    const t = await revisionFixture(real); context.after(t.close);
    const before = await t.state(); let delayed;
    const transport = { prepare: sql => t.db.prepare(sql), exec: sql => t.db.exec(sql),
      async batch(stmts) { delayed = () => t.db.batch(stmts); throw new Error('synthetic uncertain transport'); } };
    await assert.rejects(t.revise(transport), /Request failed/);
    assert.equal((await t.revise()).status, 409);
    const results = await delayed();
    assert.ok(results.every(r => r.meta.changes === 0));
    assert.deepEqual(await t.state(), before);
    assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_revision_failures').first()).n, 1);
  });
}

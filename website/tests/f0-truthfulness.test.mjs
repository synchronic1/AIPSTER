/* Built with Meta Muse. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';

// F0 truthfulness: unknown costs stay unknown in totals; measured costs sum.
// Empty usage (nothing consumed) legitimately totals zero.
test('usage totals are unknown when any row is unmeasured', async () => {
  const t = await createTestEnv();
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO usage (id, owner_id, kind, requests, tokens_in, tokens_out, model_cost_usd, execution_cost_usd, cost_source, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('u1', 'u_alice', 'demo-inference', 12, 900, 1400, null, null, 'demo-estimate', now).run();
  const out = await readJson(await t.call('/api/usage', { headers: t.as(t.alice) }));
  assert.equal(out.json.totals.requests, 12);
  assert.equal(out.json.totals.modelCostUsd, null);
  assert.equal(out.json.totals.executionCostUsd, null);
});

test('usage totals sum measured rows and zero only when empty', async () => {
  const t = await createTestEnv();
  const now = new Date().toISOString();
  const empty = await readJson(await t.call('/api/usage', { headers: t.as(t.alice) }));
  assert.equal(empty.json.totals.modelCostUsd, 0, 'nothing consumed: zero is honest');
  await t.DB.prepare('INSERT INTO usage (id, owner_id, kind, requests, tokens_in, tokens_out, model_cost_usd, execution_cost_usd, cost_source, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('u2', 'u_alice', 'measured', 2, 10, 20, 0.5, 0.25, 'measured', now).run();
  await t.DB.prepare('INSERT INTO usage (id, owner_id, kind, requests, tokens_in, tokens_out, model_cost_usd, execution_cost_usd, cost_source, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('u3', 'u_alice', 'measured', 3, 30, 40, 1.5, 0.75, 'measured', now).run();
  const full = await readJson(await t.call('/api/usage', { headers: t.as(t.alice) }));
  assert.equal(full.json.totals.modelCostUsd, 2);
  assert.equal(full.json.totals.executionCostUsd, 1);
  assert.equal(full.json.totals.requests, 5);
});

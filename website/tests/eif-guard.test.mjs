/* Built with Meta Muse. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createTestEnv, readJson } from './d1-shim.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// Truthfulness guard: EIF restoration belongs to Codex; AIPSTER must not
// dispatch, simulate-then-report, or phone home until the verified, authorized
// execution path exists.
test('job submission stays truthfully disabled and creates nothing', async () => {
  const t = await createTestEnv();
  const reg = await readJson(await t.call('/api/inventory', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'lab-1' } }));
  assert.equal(reg.status, 201);
  const out = await readJson(await t.call('/api/jobs', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { resourceId: reg.json.id, model: 'demo', prompt: 'hi' } }));
  assert.equal(out.status, 501);
  assert.equal(out.json.code, 'INFERENCE_DISABLED');
  const rows = await t.DB.prepare('SELECT id FROM jobs').all();
  assert.equal(rows.results.length, 0, 'no job row may be created while dispatch is disabled');
});

test('worker source performs no outbound inference calls', () => {
  // ASSETS.fetch (same-origin static assets) is the only fetch allowed.
  const files = ['worker.js', 'lib/auth.js', 'lib/store.js', 'lib/keys.js', 'lib/validate.js', 'lib/status.mjs'];
  for (const f of files) {
    const src = readFileSync(path.join(SRC, f), 'utf8');
    assert.ok(!/fetch\(\s*['"`]https?:/.test(src), `${f} must not fetch remote URLs`);
    assert.ok(!/elastic-inference|eif-restoration/i.test(src), `${f} must not hardcode EIF endpoints`);
  }
});

// Until placement confinement and atomic authorization/budget admission exist,
// even attempted activation and unsafe capability claims cannot dispatch work.
test('attempted CPU activation and invalid admission claims still create no job or network call', async () => {
  const t = await createTestEnv({ EIF_CPU_ENABLED: '1', EIF_CPU_TOKEN: 'fixture-secret' });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected execution transport'); };
  try {
    for (const body of [
      { resourceId: 'other-tenant', model: 'fixture' },
      { resourceId: 'revoked', model: 'fixture' },
      { resourceId: 'stale', available: false },
      { model: 'incompatible', memoryBytes: 0 },
      { model: 'fixture', maxTokens: 999999, budget: 0 },
      { endpoint: 'https://untrusted.invalid', model: 'fixture' },
      { model: 'fixture', idempotencyKey: 'same-operation' },
      { model: 'fixture', idempotencyKey: 'same-operation' },
    ]) {
      const out = await readJson(await t.call('/api/jobs', {
        method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body
      }));
      assert.equal(out.status, 501);
      assert.equal(out.json.code, 'INFERENCE_DISABLED');
      assert.ok(!out.text.includes('fixture-secret'));
    }
    assert.equal((await t.DB.prepare('SELECT id FROM jobs').all()).results.length, 0);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; t.sqlite.close(); }
});

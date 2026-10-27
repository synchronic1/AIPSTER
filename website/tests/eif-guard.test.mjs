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
  const files = ['worker.js', 'lib/auth.js', 'lib/store.js', 'lib/keys.js', 'lib/validate.js'];
  for (const f of files) {
    const src = readFileSync(path.join(SRC, f), 'utf8');
    assert.ok(!/fetch\(\s*['"`]https?:/.test(src), `${f} must not fetch remote URLs`);
    assert.ok(!/elastic-inference|eif-restoration/i.test(src), `${f} must not hardcode EIF endpoints`);
  }
});

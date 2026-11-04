// Focused offline tests for scripts/verify-production-readiness.mjs.
// Fixtures here prove validator behavior only; they are not production evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateReadiness, loadRepoExpectations, parseJsonc } from '../scripts/verify-production-readiness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/verify-production-readiness.mjs');
const repo = loadRepoExpectations();
const CAND = 'a'.repeat(40);
const LIVE = 'b'.repeat(40);

function good() {
  return {
    schema: 'aipster.production-readiness-evidence/v1',
    evidence_kind: 'operator-observed-production',
    observed_at: '2026-11-04T08:00:00Z',
    observer: 'fixture',
    candidate_sha: CAND,
    release_mode: 'manual',
    live: { deployment_git_commit: LIVE },
    target: { worker_name: repo.workerName, d1_database_name: repo.d1DatabaseName, d1_database_id: repo.d1DatabaseId },
    d1: { migrations_applied: [...repo.migrations], fabric_grants_columns: ['id', 'ceilings', 'used_tokens', 'used_jobs'] },
    flags: {
      DGM_MUSE_LIVE: { binding: 'unset' },
      DGM_MUSE_SPEND_CAP_USD: { binding: 'unset' },
      DGM_PREVIEW_ENABLED: { binding: 'unset' },
      INFERENCE_ENABLED: { binding: 'unset' },
    },
  };
}
const run = (ev, cand = CAND) => evaluateReadiness(ev, { candidateSha: cand, repo });
const holdWith = (r, re) => { assert.equal(r.verdict, 'HOLD'); assert.ok(r.failures.some(f => re.test(f)), r.failures.join('\n')); };

test('repo expectations come from the reviewed checkout', () => {
  assert.equal(repo.workerName, 'aipster-public-site');
  assert.equal(repo.d1DatabaseName, 'aipster-app');
  assert.ok(repo.migrations.includes('0029_fabric_dispatch_spend.sql'));
  assert.deepEqual(parseJsonc('{"a":"x//y", /* c */ "b":1 // d\n}'), { a: 'x//y', b: 1 });
});

test('complete, disabled-DGM evidence is READY', () => {
  const r = run(good());
  assert.equal(r.verdict, 'READY', r.failures.join('\n'));
  assert.deepEqual(r.effective_flags, { dgm_muse_live: false, dgm_muse_spend_cap_usd: 0, dgm_preview_enabled: false, inference_enabled: false });
  assert.ok(r.warnings.some(w => /manual dispatch skips/.test(w)));
});

test('missing 0029 journal entry holds', () => {
  const ev = good(); ev.d1.migrations_applied = ev.d1.migrations_applied.filter(n => !n.startsWith('0029'));
  holdWith(run(ev), /not applied in production: 0029_fabric_dispatch_spend\.sql/);
});

test('missing used_jobs column holds', () => {
  const ev = good(); ev.d1.fabric_grants_columns = ['id', 'used_tokens'];
  holdWith(run(ev), /column missing in production: used_jobs/);
});

test('columns without journal entry are ambiguous', () => {
  const ev = good(); ev.d1.migrations_applied = ev.d1.migrations_applied.filter(n => !n.startsWith('0029'));
  holdWith(run(ev), /out-of-band ALTER/);
});

test('duplicate or unknown journal entries hold', () => {
  const ev = good(); ev.d1.migrations_applied.push(ev.d1.migrations_applied[0], '9999_future.sql');
  const r = run(ev);
  holdWith(r, /duplicate entries/); holdWith(r, /unknown to the candidate: 9999_future\.sql/);
});

test('enabled DGM live holds', () => {
  const ev = good(); ev.flags.DGM_MUSE_LIVE = { binding: 'plain_text', value: '1' };
  holdWith(run(ev), /DGM_MUSE_LIVE is enabled/);
});

test('nonzero spend cap holds; literal 0 passes; junk cap is ambiguous', () => {
  const ev = good(); ev.flags.DGM_MUSE_SPEND_CAP_USD = { binding: 'plain_text', value: '25' };
  holdWith(run(ev), /requires a zero cap/);
  ev.flags.DGM_MUSE_SPEND_CAP_USD = { binding: 'plain_text', value: '0' };
  assert.equal(run(ev).verdict, 'READY');
  ev.flags.DGM_MUSE_SPEND_CAP_USD = { binding: 'plain_text', value: 'abc' };
  holdWith(run(ev), /parses to 0 only by fallback/);
});

test('wrong target identities hold', () => {
  holdWith(run(good(), 'c'.repeat(40)), /wrong target: evidence candidate_sha/);
  const ev = good(); ev.target.d1_database_id = '00000000-0000-0000-0000-000000000000';
  holdWith(run(ev), /wrong target D1 id/);
  const ev2 = good(); ev2.target.worker_name = 'aipster-staging';
  holdWith(run(ev2), /wrong target worker/);
  const ev3 = good(); delete ev3.live.deployment_git_commit;
  holdWith(run(ev3), /unknown live baseline/);
});

test('missing effective flags hold and are never inferred', () => {
  const ev = good(); delete ev.flags.INFERENCE_ENABLED;
  holdWith(run(ev), /INFERENCE_ENABLED not observed/);
  const ev2 = good(); delete ev2.flags;
  holdWith(run(ev2), /flags object missing/);
});

test('secret-bound or contradictory flags are ambiguous', () => {
  const ev = good(); ev.flags.DGM_MUSE_LIVE = { binding: 'secret' };
  holdWith(run(ev), /DGM_MUSE_LIVE: bound as a secret/);
  const ev2 = good(); ev2.flags.DGM_PREVIEW_ENABLED = { binding: 'unset', value: '0' };
  holdWith(run(ev2), /binding unset but a value/);
  const ev3 = good(); ev3.flags.DGM_MUSE_API_KEY = { binding: 'secret' };
  holdWith(run(ev3), /unexpected flag keys/);
});

test('desired/fixture config is not accepted as observed', () => {
  const ev = good(); ev.evidence_kind = 'desired';
  holdWith(run(ev), /evidence_kind must be/);
  const ev2 = good(); ev2.observed_at = 'yesterday';
  holdWith(run(ev2), /observed_at/);
});

test('plain-text dashboard vars warn about deploy replacement', () => {
  const ev = good(); ev.flags.INFERENCE_ENABLED = { binding: 'plain_text', value: '1' };
  const r = run(ev);
  assert.equal(r.verdict, 'READY');
  assert.equal(r.effective_flags.inference_enabled, true);
  assert.ok(r.warnings.some(w => /INFERENCE_ENABLED is a dashboard plain-text var/.test(w)));
});

test('CLI exit codes: READY 0, HOLD 1, usage 2; no network', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aipster-readiness-'));
  const ok = join(dir, 'ok.json'); writeFileSync(ok, JSON.stringify(good()));
  const bad = good(); bad.flags.DGM_MUSE_LIVE = { binding: 'plain_text', value: '1' };
  const hold = join(dir, 'hold.json'); writeFileSync(hold, JSON.stringify(bad));
  // Any network attempt would throw via the preloaded guard.
  const guard = join(dir, 'guard.mjs');
  writeFileSync(guard, "globalThis.fetch = () => { throw new Error('network forbidden'); };");
  const exec = args => spawnSync(process.execPath, ['--import', guard, SCRIPT, ...args], { encoding: 'utf8' });
  const a = exec(['--evidence', ok, '--candidate', CAND]);
  assert.equal(a.status, 0, a.stdout + a.stderr); assert.equal(JSON.parse(a.stdout).verdict, 'READY');
  const b = exec(['--evidence', hold, '--candidate', CAND]);
  assert.equal(b.status, 1); assert.equal(JSON.parse(b.stdout).verdict, 'HOLD');
  assert.equal(exec(['--evidence', ok]).status, 2);
  assert.equal(exec(['--evidence', join(dir, 'nope.json'), '--candidate', CAND]).status, 2);
});

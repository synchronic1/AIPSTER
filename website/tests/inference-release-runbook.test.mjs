// Keeps docs/release/inference-release-runbook.md honest: every inference
// variable, route, migration and command it tells the operator to use must
// exist in the code that ships with this revision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNBOOK = 'docs/release/inference-release-runbook.md';
const read = (...parts) => readFile(path.join(ROOT, ...parts), 'utf8');

// The four variables activation sets, in the order the runbook sets them.
const ENV_NAMES = [
  'INFERENCE_OWNER_DAILY_TOKENS',
  'INFERENCE_DISPATCH_MAX_ADMISSIONS',
  'INFERENCE_DISPATCH_MAX_OPERATIONS',
  'INFERENCE_ENABLED',
];
// Routes the runbook probes or calls.
const ROUTES = [
  '/api/inference/admissions',
  '/api/worker/jobs/next',
  '/api/jobs',
];

test('runbook inference variables exist in the shipped worker and store', async () => {
  const doc = await read(RUNBOOK);
  const source = (await read('website', 'src', 'worker.js')) + '\n'
    + (await read('website', 'src', 'inference', 'dispatch-store.mjs'));
  for (const name of ENV_NAMES) {
    assert.ok(doc.includes(name), `runbook must document ${name}`);
    assert.ok(source.includes(name), `${name} must exist in source`);
  }
  // Every INFERENCE_* token the runbook mentions must be real (a code such as
  // INFERENCE_DISABLED counts only if the source really emits it).
  const mentioned = new Set(doc.match(/\bINFERENCE_[A-Z0-9_]+\b/g) || []);
  for (const token of mentioned) {
    assert.ok(source.includes(token), `runbook mentions ${token}, absent from source`);
  }
  // The cap fallbacks the runbook quotes are the store's actual defaults.
  assert.match(source, /DEFAULT_DISPATCH_MAX_ADMISSIONS = 20/);
  assert.match(source, /DEFAULT_DISPATCH_MAX_OPERATIONS = 20/);
});

test('runbook routes exist and are flag-gated in the worker', async () => {
  const doc = await read(RUNBOOK);
  const worker = await read('website', 'src', 'worker.js');
  for (const route of ROUTES) {
    assert.ok(doc.includes(route), `runbook must name ${route}`);
    assert.ok(worker.includes(route), `${route} must exist in the worker`);
  }
  // The runbook's core dark-by-default claim: these routes are reachable only
  // with the flag on, so they really do fall through to 404 when it is unset.
  assert.match(worker, /inferenceEnabled\(env\) && path === '\/api\/inference\/admissions'/);
  assert.match(worker, /inferenceEnabled\(env\) && path === '\/api\/worker\/jobs\/next'/);
});

test('runbook migration, deploy workflow and worker command are real', async () => {
  const doc = await read(RUNBOOK);

  const migration = path.join(ROOT, 'website', 'migrations', '0024_inference_dispatch.sql');
  await access(migration);
  assert.ok(doc.includes('0024_inference_dispatch.sql'), 'runbook must name the applied migration');
  const sql = await readFile(migration, 'utf8');
  assert.doesNotMatch(sql, /^\s*(DROP|ALTER)\b/im,
    '0024 is documented as additive, so it must not drop or alter');

  await access(path.join(ROOT, '.github', 'workflows', 'public-site-production-deploy.yml'));
  const workflow = await read('.github', 'workflows', 'public-site-production-deploy.yml');
  assert.ok(doc.includes('public-site-production-deploy.yml'), 'runbook must name the deploy workflow');
  assert.ok(workflow.includes('reviewed_sha'), 'deploy workflow must still take reviewed_sha');

  assert.ok(doc.includes('pairing.py serve-jobs'), 'runbook worker command');
  assert.ok((await read('local-worker', 'pairing.py')).includes('serve-jobs'),
    'pairing.py must still expose serve-jobs');

  // Backup and rollback rely on these exact wrangler surfaces.
  assert.ok(doc.includes('wrangler d1 export aipster-app --remote'));
  assert.ok(doc.includes('wrangler d1 time-travel info aipster-app'));
  assert.ok(doc.includes('wrangler d1 time-travel restore aipster-app --bookmark'));
});

test('the local rehearsal appendix never reaches production', async () => {
  const doc = await read(RUNBOOK);
  const appendix = doc.split('## Appendix A.')[1] || '';
  assert.ok(appendix.includes('d1 migrations apply aipster-app --local'),
    'appendix must show the local apply path');
  const commands = appendix.split(/\r?\n/).filter((line) => line.trim().startsWith('npx wrangler'));
  assert.ok(commands.length > 0, 'appendix must show the wrangler commands');
  for (const line of commands) {
    assert.ok(!line.includes('--remote'), `local rehearsal command reaches production: ${line.trim()}`);
  }
});

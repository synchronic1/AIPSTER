// Structural regression for the production deploy workflow and the worker
// checks trigger. Node has no YAML parser and installs are out of scope, so
// this test works on the workflow text with indentation-aware step blocks:
// every property it asserts is a property a real defect already broke
// (pre-checkout working directory) or a finding required (permissions,
// triggers, wiring). The first real CI run is still the full YAML parse.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

const deployUrl = new URL('../../.github/workflows/public-site-production-deploy.yml', import.meta.url);
const workerUrl = new URL('../../.github/workflows/local-worker-checks.yml', import.meta.url);
const deploy = await readFile(deployUrl, 'utf8');
const worker = await readFile(workerUrl, 'utf8');

// Steps sit at exactly six spaces of indent; a block runs to the next step.
function steps(text) {
  const lines = text.split('\n');
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (/^      - (name|uses|run):/.test(line)) {
      current = {header: line, body: ''};
      blocks.push(current);
    } else if (current && (/^ {8,}\S/.test(line) || line.trim() === '')) {
      current.body += line + '\n';
    } else {
      current = null;
    }
  }
  return blocks;
}

test('deploy workflow has no tabs and the expected top-level shape', () => {
  assert(!deploy.includes('\t'), 'workflow must not contain tabs');
  for (const key of ['name: Public site production deploy', 'on:', 'permissions:',
    'concurrency:', 'jobs:', "|| 'public-site-production' }}", 'environment: production']) {
    assert(deploy.includes(key), `workflow must declare ${key}`);
  }
});

test('deploy workflow wakes on both applicable suites and keeps manual dispatch', () => {
  assert(deploy.includes("workflows: ['Public site checks', 'Public local worker installation']"));
  assert(deploy.includes('types: [completed]'));
  assert(deploy.includes('branches: [main]'));
  assert(deploy.includes('workflow_dispatch:'));
  assert(deploy.includes('reviewed_sha:'));
});

test('deploy workflow keeps minimum read-only permissions', () => {
  assert(deploy.includes('contents: read'));
  assert(deploy.includes('checks: read'));
  assert(deploy.includes('pull-requests: read'));
  assert(!/^ +\w[\w-]*: write$/m.test(deploy), 'no write grants allowed');
});

test('pre-checkout steps run in the workspace root, not website/', () => {
  const texts = steps(deploy).map(b => b.header + '\n' + b.body);
  const checkout = texts.findIndex(t => t.includes('actions/checkout@'));
  assert(checkout > 0, 'checkout step must exist');
  const pre = texts.slice(0, checkout).filter(t => /run:/.test(t));
  assert(pre.length >= 2, 'resolve and trust-gate steps must precede checkout');
  for (const t of pre) {
    assert(t.includes('working-directory: ${{ github.workspace }}'),
      `pre-checkout step must override working-directory: ${t.split('\n')[0].trim()}`);
  }
  for (const t of texts.slice(checkout + 1).filter(t => /run: npm (ci|run check|run test)/.test(t))) {
    assert(!t.includes('github.workspace'), 'post-checkout build steps keep the website default');
  }
});

test('trust gate rejects untrusted events before any fetch', () => {
  const texts = steps(deploy).map(b => b.header + '\n' + b.body);
  const checkout = texts.findIndex(t => t.includes('actions/checkout@'));
  const gate = texts.slice(0, checkout).find(t => t.includes('fork sources'));
  assert(gate, 'event trust gate must precede checkout');
  assert(gate.includes('main push event') && gate.includes('main branch'));
  assert(gate.includes('Public local worker installation'));
});

test('checkout is pinned and HEAD is verified before build', () => {
  assert(deploy.includes('ref: ${{ steps.release.outputs.sha }}'), 'checkout must pin the resolved SHA');
  const blocks = steps(deploy);
  const texts = blocks.map(b => b.header + '\n' + b.body);
  const verify = texts.findIndex(t => t.includes('git rev-parse HEAD'));
  const checkout = texts.findIndex(t => t.includes('actions/checkout@'));
  const build = texts.findIndex(t => t.includes('npm run build'));
  const preflight = texts.findIndex(t => t.includes('release-preflight.mjs') && t.includes('Require the verified'));
  assert(verify > checkout && verify < build, 'rev-parse verification sits between checkout and build');
  assert(preflight > build, 'preflight rechecks after the build, immediately before deploy');
  assert(deploy.includes('BUILT_SHA: ${{ steps.verify.outputs.built_sha }}'));
  assert(deploy.includes('WORKER_APPLICABLE: ${{ steps.worker.outputs.applicable }}'));
});

test('migration hold and worker applicability are fail-closed and visible', () => {
  const hold = steps(deploy).find(b => b.body.includes('id: migration'));
  assert(hold, 'baseline guard step exists');
  assert(hold.body.includes("if: steps.release.outputs.mode == 'auto'"), 'baseline guard stays auto-only');
  assert(hold.body.includes('export ANCESTOR DIFF_OK'), 'auto baseline inputs must reach the decision');
  assert(hold.body.includes('changedMigrationPaths: []'), 'a git diff alone no longer decides; baseline guards stay');
  assert(!hold.body.includes('CLOUDFLARE_API_TOKEN'), 'baseline guard never receives the credential');
  const schema = steps(deploy).find(b => b.body.includes('id: schema'));
  assert(schema, 'credentialed schema step exists');
  assert(!schema.body.includes('mode =='), 'schema check runs in BOTH auto and manual mode');
  assert(schema.body.includes('SELECT name FROM d1_migrations ORDER BY id'), 'reads the authoritative journal');
  assert(schema.body.includes('scripts/migration-state.mjs decide'), 'state-aware decision is evaluated');
  assert(schema.body.includes('--journal-exit') && schema.body.includes('--columns-exit'), 'failed reads reach the decision');
  assert(!/migrations apply|d1 migrations|INSERT|UPDATE|DELETE|ALTER/i.test(schema.body.replace(/^\s*#.*$/gm, '')), 'schema step never writes or applies');
  assert(deploy.includes('export W_OK CHANGED'), 'applicability inputs must reach the decision');
  const report = steps(deploy).find(b => b.header.includes('Report schema hold'));
  assert(report && report.body.includes("steps.migration.outputs.hold == 'true'"), 'hold report runs on hold');
  assert(report.body.includes('exit 1'), 'a hold must not report success');
  assert(report.body.includes('$GITHUB_STEP_SUMMARY'), 'a hold must be explicit in the summary');
});

test('deploy and verify steps are skipped on hold or already-live', () => {
  assert(deploy.includes("steps.migration.outputs.hold != 'true' && steps.schema.outputs.hold == 'false' && steps.live.outputs.already != 'true'"),
    'deploy requires an explicit schema PROCEED (a skipped/failed schema step never deploys)');
});

test('no plain-scalar run step contains YAML-breaking colons', () => {
  // Regression for the line-123 workflow-validation failure: a plain scalar
  // `run: node ... -e "..."` containing ': ' ends the mapping and invalidates
  // the whole workflow file. Inline scripts must use literal block syntax.
  for (const line of deploy.split('\n')) {
    const m = /^(\s*)run: (.*)$/.exec(line);
    if (m && m[2] !== '|' && m[2] !== '>') {
      assert(!m[2].includes(': '), `plain-scalar run must not contain ': ': ${line.trim().slice(0, 80)}`);
    }
  }
});

test('inline node scripts use literal block syntax', () => {
  const texts = steps(deploy).map(b => b.header + '\n' + b.body);
  const inline = texts.filter(t => /node --input-type=module/.test(t));
  assert(inline.length > 0, 'expected inline node steps');
  for (const t of inline) {
    assert(t.includes('run: |'), 'inline node script must run under a literal block');
  }
});

test('live verification receives the already-live mode from the baseline step', () => {
  const texts = steps(deploy).map(b => b.header + '\n' + b.body);
  const verify = texts.find(t => t.includes('npm run verify:live'));
  assert(verify, 'verify step must exist');
  assert(verify.includes('AIPSTER_ALREADY_LIVE: ${{ steps.live.outputs.already }}'),
    'verify step must run the already-live receipt validation on the skip path');
});

test('preflight precedes wrangler deploy and live verification follows it', () => {
  const texts = steps(deploy).map(b => b.header + '\n' + b.body);
  const preflight = texts.findIndex(t => t.includes('release-preflight.mjs') && t.includes('Require the verified'));
  const wrangler = texts.findIndex(t => t.includes('npx wrangler deploy'));
  const verify = texts.findIndex(t => t.includes('npm run verify:live'));
  assert(preflight >= 0 && wrangler >= 0 && verify >= 0, 'preflight, deploy and verify steps must exist');
  assert(preflight < wrangler, 'the last recheck must run before any deployment');
  assert(wrangler < verify, 'live verification must run after the deployment');
});

// The `on:` block runs from its column-0 header to the next column-0 key;
// a trigger section runs to the next two-space key within it.
function triggerSection(text, name) {
  const start = text.search(/^on:$/m);
  assert(start >= 0, 'workflow must declare on:');
  const tail = text.slice(start).slice(3);
  const end = tail.search(/^[a-z]+:/m);
  const block = end < 0 ? text.slice(start) : text.slice(start, start + 3 + end);
  const parts = block.split(new RegExp(`^  ${name}:`, 'm'));
  assert.equal(parts.length, 2, `workflow must declare exactly one ${name} trigger`);
  return parts[1].split(/^  \w[\w-]*:/m)[0];
}

test('worker checks run on every canonical-main push', () => {
  // Regression for the 0de5103 bootstrap gap: the release gate measures
  // worker applicability over the cumulative live-to-target range, but a
  // path-filtered push trigger only qualifies the pushed files. A
  // registry-only or docs-only push after worker changes then leaves the
  // new target without its own mock-install result. Every main push runs
  // the suite; the gate still decides applicability (fail-closed), so
  // unneeded runs are harmless but missing runs are impossible.
  const push = triggerSection(worker, 'push');
  assert(push.includes('branches: [main]'), 'push trigger is scoped to canonical main');
  assert(!/^\s*paths:/m.test(push), 'push trigger must not filter paths');
});

test('worker checks keep PR path filters with fork-safe triggers and permissions', () => {
  const pr = triggerSection(worker, 'pull_request');
  assert(/^\s*paths:/m.test(pr), 'pull_request keeps its path filters');
  assert(!worker.includes('pull_request_target'), 'PR checks run on head code, never the base version');
  assert(!worker.includes('secrets.'), 'worker checks reference no secrets (fork-safe)');
  assert(worker.includes('contents: read'), 'worker checks keep read-only contents');
  assert(!/^ +\w[\w-]*: write$/m.test(worker), 'no write grants allowed');
});

test('worker check keeps the gate-bound mock-install job identity', () => {
  const at = worker.search(/^  mock-install:$/m);
  assert(at >= 0, 'mock-install job must exist');
  const job = worker.slice(worker.indexOf('\n', at)).split(/^  \w[\w-]*:/m)[0];
  assert(job.includes('runs-on: windows-2025'), 'mock-install keeps its qualified runner');
  assert(!/^\s*name:/m.test(job), 'mock-install keeps its job-id check name (the gate binds on it)');
});

test('the Cloudflare credential reaches no step before main-revision preflight and the release gate', () => {
  const all = steps(deploy.split('\n  schema-diagnostic:\n')[0]);
  const at = (pred, label) => { const i = all.findIndex(pred); assert(i >= 0, label); return i; };
  const preflight = at(b => b.header.includes('Require the verified current main revision'), 'preflight step');
  const gate = at(b => b.header.includes('Enforce release gate over included PRs'), 'release gate step');
  const schema = at(b => b.body.includes('id: schema'), 'schema step');
  const wrangler = at(b => b.header.includes('npx wrangler deploy'), 'deploy step');
  const credentialed = all.map((b, i) => (b.body.includes('secrets.CLOUDFLARE_API_TOKEN') ? i : -1)).filter(i => i >= 0);
  assert.deepEqual(credentialed, [schema, wrangler], 'only the schema check and deploy hold the credential');
  assert(preflight < gate && gate < schema && schema < wrangler, 'preflight < gate < schema check < deploy');
  const report = all.find(b => b.header.includes('Report schema hold'));
  assert(report.body.includes("steps.schema.outputs.hold == 'true'"), 'a schema hold is reported and fails the job');
});

// Read-only schema diagnostic job: deploy exclusion and SHA binding.
const [deployJob, diagJob] = deploy.split('\n  schema-diagnostic:\n');
const runBlock = (step) => step.body.split('run: |\n')[1].split(/\n {8}env:/)[0]
  .split('\n').map(l => l.replace(/^ {10}/, '')).join('\n');

test('diagnostic mode can never reach the deploy job on main or any branch', () => {
  assert(diagJob, 'schema-diagnostic job exists');
  const deployIf = deployJob.match(/\n {4}if: (.+)\n/)[1];
  assert(deployIf.startsWith("github.ref == 'refs/heads/main' && "), 'main-only deploy guard preserved');
  assert(deployIf.includes("(github.event_name != 'workflow_dispatch' || inputs.mode == 'deploy')"),
    'a dispatch deploys only in explicit deploy mode, on every ref');
  const diagIf = diagJob.match(/(?:^|\n) {4}if: (.+)\n/)[1];
  assert.equal(diagIf, "github.event_name == 'workflow_dispatch' && inputs.mode == 'schema-diagnostic' && github.repository == 'synchronic1/AIPSTER'");
  assert(!/needs:/.test(diagJob), 'diagnostic is independent of the deploy job');
  assert(deploy.includes("group: ${{ inputs.mode == 'schema-diagnostic' && 'public-site-schema-diagnostic' || 'public-site-production' }}"),
    'diagnostic never shares the production concurrency group');
  assert(deploy.includes('options: [deploy, schema-diagnostic]') && deploy.includes('default: deploy'));
});

test('diagnostic job is read-only, credential-minimal and fixed-query', () => {
  const body = diagJob.replace(/^\s*#.*$/gm, '');
  for (const bad of [/wrangler deploy/, /migrations apply/, /d1 migrations/, /environment:/, /upload-artifact/,
    /secret put/, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/, /verify:live/, /npm test/, /npm run build/])
    assert(!bad.test(body), `diagnostic must not contain ${bad}`);
  assert.deepEqual(body.match(/secrets\.[A-Z_]+/g), ['secrets.CLOUDFLARE_API_TOKEN'], 'exactly one secret reference');
  assert.match(body, /permissions:\n {6}contents: read\n {4}defaults/, 'contents: read only');
  const st = steps(diagJob);
  const reqRev = st.findIndex(b => b.header.includes('Require the exact reviewed workflow revision'));
  const checkout = st.findIndex(b => b.header.includes('actions/checkout'));
  const verify = st.findIndex(b => b.header.includes('Verify checkout matches the reviewed SHA'));
  const query = st.findIndex(b => b.body.includes('secrets.CLOUDFLARE_API_TOKEN'));
  assert(reqRev === 0 && reqRev < checkout && checkout < verify && verify < query && query === st.length - 1,
    'both SHA proofs precede the only credentialed step, which is last');
  assert(st[checkout].body.includes('persist-credentials: false') && st[checkout].body.includes('ref: ${{ inputs.reviewed_sha }}'));
  const q = st[query].body;
  assert.equal((q.match(/--command/g) || []).length, 2, 'exactly two fixed queries');
  assert(q.includes(`SELECT name FROM d1_migrations WHERE name = '0029_fabric_dispatch_spend.sql'`));
  assert(q.includes(`FROM pragma_table_info('fabric_grants')`));
  assert(!/\$\{\{\s*inputs/.test(q), 'no input reaches the query text');
  assert(q.includes('migration-state.mjs diagnose'), 'only the sanitized verdict is printed');
});

test('diagnostic refuses a wrong, short or mismatched reviewed SHA before any secret', () => {
  const step = steps(diagJob).find(b => b.header.includes('Require the exact reviewed workflow revision'));
  const script = runBlock(step);
  const run = (env) => spawnSync('bash', ['-e', '-c', script], {encoding: 'utf8', env: {PATH: process.env.PATH, ...env}}).status;
  const A = 'a'.repeat(40), B = 'b'.repeat(40);
  assert.equal(run({REVIEWED_SHA: A, RUN_SHA: A}), 0);
  assert.notEqual(run({REVIEWED_SHA: A, RUN_SHA: B}), 0, 'dispatched revision differs');
  assert.notEqual(run({REVIEWED_SHA: 'a'.repeat(7), RUN_SHA: 'a'.repeat(7)}), 0, 'short SHA');
  assert.notEqual(run({REVIEWED_SHA: A.toUpperCase(), RUN_SHA: A.toUpperCase()}), 0, 'non-canonical SHA');
  assert.notEqual(run({REVIEWED_SHA: '', RUN_SHA: ''}), 0, 'missing SHA');
  const verify = runBlock(steps(diagJob).find(b => b.header.includes('Verify checkout matches the reviewed SHA')));
  assert(verify.includes('test "$BUILT_SHA" = "$REVIEWED_SHA"'), 'checkout is re-proven');
});

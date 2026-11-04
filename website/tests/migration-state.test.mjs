// Focused tests for scripts/migration-state.mjs. Every D1 payload below is a
// FIXTURE shaped like `wrangler d1 execute --remote --json` output; none of it
// is production evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addedColumns, expectedColumns, listRepoMigrations, parseD1Rows, probeSql,
  schemaStateDecision, combinedDecision } from '../scripts/migration-state.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/migration-state.mjs');
const repoMigrations = listRepoMigrations();
const expected = expectedColumns();
const M29 = '0029_fabric_dispatch_spend.sql';
const allCols = () => Object.values(expected).flat().map(c => ({ t: c.table, name: c.column }));
const journal = names => names.map(name => ({ name }));
const fixtureD1 = rows => JSON.stringify([{ results: rows, success: true, meta: {} }]);
const decide = over => schemaStateDecision({ repoMigrations, expected,
  journalRows: journal(repoMigrations), columnRows: allCols(), ...over });

test('expected columns are derived from the reviewed migrations (0029 included)', () => {
  assert.deepEqual(expected[M29], [{ table: 'fabric_grants', column: 'used_tokens' }, { table: 'fabric_grants', column: 'used_jobs' }]);
  assert.deepEqual(addedColumns('-- ALTER TABLE x ADD COLUMN y\nALTER TABLE "a" ADD b INT;'), [{ table: 'a', column: 'b' }]);
  const sql = probeSql(expected);
  assert.match(sql, /pragma_table_info\('fabric_grants'\)/);
  assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE|ALTER|DROP/i);
});

test('fully applied, consistent production state proceeds', () => {
  const d = decide({});
  assert.equal(d.hold, false, d.reason);
  assert.deepEqual(d.pending, []);
});

test('missing 0029 with no 0029 columns holds as unapplied (never applied here)', () => {
  const d = decide({ journalRows: journal(repoMigrations.filter(m => m !== M29)),
    columnRows: allCols().filter(c => c.t !== 'fabric_grants' || !/^used_(tokens|jobs)$/.test(c.name)) });
  assert.equal(d.hold, true);
  assert.match(d.reason, /unapplied migrations .*0029_fabric_dispatch_spend\.sql/);
});

test('0029 columns present without journal entry is ambiguous (non-idempotent ALTER)', () => {
  const d = decide({ journalRows: journal(repoMigrations.filter(m => m !== M29)) });
  assert.equal(d.hold, true);
  assert.match(d.reason, /ambiguous schema: 0029.*do not re-run/);
});

test('partial 0029 (one column) without journal entry is ambiguous', () => {
  const d = decide({ journalRows: journal(repoMigrations.filter(m => m !== M29)),
    columnRows: allCols().filter(c => !(c.t === 'fabric_grants' && c.name === 'used_jobs')) });
  assert.match(d.reason, /ambiguous schema: 0029/);
});

test('0029 journaled but a column missing is drift', () => {
  const d = decide({ columnRows: allCols().filter(c => !(c.t === 'fabric_grants' && c.name === 'used_jobs')) });
  assert.equal(d.hold, true);
  assert.match(d.reason, /schema drift: 0029.*fabric_grants\.used_jobs/);
});

test('unknown, duplicate, empty or unobservable journal holds', () => {
  assert.match(decide({ journalRows: journal([...repoMigrations, '0030_future.sql']) }).reason, /unknown to the target: 0030_future\.sql/);
  assert.match(decide({ journalRows: journal([...repoMigrations, repoMigrations[0]]) }).reason, /duplicate/);
  assert.match(decide({ journalRows: [] }).reason, /empty or malformed/);
  assert.match(decide({ journalRows: null }).reason, /journal unobservable/);
  assert.match(decide({ columnRows: null }).reason, /column state unobservable/);
  assert.match(decide({ columnRows: [{ name: 'x' }] }).reason, /column state malformed/);
});

test('wrangler output parsing fails closed', () => {
  assert.deepEqual(parseD1Rows(fixtureD1([{ name: 'a' }])), [{ name: 'a' }]);
  assert.equal(parseD1Rows(fixtureD1([{ name: 'a' }]), 1), null, 'non-zero exit');
  assert.equal(parseD1Rows(''), null);
  assert.equal(parseD1Rows('not json'), null);
  assert.equal(parseD1Rows(JSON.stringify([{ results: [], success: false }])), null);
  assert.equal(parseD1Rows(JSON.stringify([{ results: [] , success: true }, { results: [], success: true }])), null);
  assert.equal(parseD1Rows(JSON.stringify({ error: { code: 7403 } })), null, 'authorization error payload');
});

test('auto-mode baseline guards still win over a clean state', () => {
  const d = combinedDecision({ baselineHold: true, baselineReason: 'unknown live baseline or target', state: decide({}) });
  assert.deepEqual(d, { hold: true, reason: 'unknown live baseline or target' });
  assert.equal(combinedDecision({ baselineHold: false, state: decide({}) }).hold, false);
});

test('CLI writes hold/reason outputs and holds on failed reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-state-'));
  const j = join(dir, 'j.json'), c = join(dir, 'c.json'), out = join(dir, 'out');
  writeFileSync(j, fixtureD1(journal(repoMigrations))); writeFileSync(c, fixtureD1(allCols()));
  const run = (args) => { writeFileSync(out, '');
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out } }); };
  let r = run(['decide', '--journal', j, '--columns', c, '--baseline-hold', 'false']);
  assert.equal(r.status, 0, r.stderr); assert.match(readFileSync(out, 'utf8'), /^hold=false$/m);
  r = run(['decide', '--journal', j, '--columns', c, '--journal-exit', '1']);
  assert.match(readFileSync(out, 'utf8'), /^hold=true$/m); assert.match(r.stdout, /journal unobservable/);
  r = run(['decide', '--journal', join(dir, 'missing.json'), '--columns', c]);
  assert.match(readFileSync(out, 'utf8'), /^hold=true$/m);
  r = run(['decide', '--journal', j, '--columns', c, '--baseline-hold', 'true', '--baseline-reason', 'live baseline is not an ancestor of the target']);
  assert.match(readFileSync(out, 'utf8'), /^reason=live baseline is not an ancestor/m);
  assert.equal(run(['decide', '--journal', j]).status, 2, 'usage error fails the step');
  assert.match(run(['probe-sql']).stdout, /UNION ALL/);
});

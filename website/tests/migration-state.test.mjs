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
import { diagnose0029, addedColumns, expectedColumns, listRepoMigrations, parseD1Rows, probeSql,
  schemaStateDecision, combinedDecision } from '../scripts/migration-state.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/migration-state.mjs');
const repoMigrations = listRepoMigrations();
const expected = expectedColumns();
const M29 = '0029_fabric_dispatch_spend.sql';
// FIXTURE rows shaped like SQLite pragma_table_info for the expected definitions.
const allCols = () => Object.values(expected).flat().map(c => ({ t: c.table, name: c.column,
  type: c.type, nn: c.notNull ? 1 : 0, dflt: c.dflt }));
const journal = names => names.map(name => ({ name }));
const fixtureD1 = rows => JSON.stringify([{ results: rows, success: true, meta: {} }]);
const decide = over => schemaStateDecision({ repoMigrations, expected,
  journalRows: journal(repoMigrations), columnRows: allCols(), ...over });

test('expected columns are derived from the reviewed migrations (0029 included)', () => {
  assert.deepEqual(expected[M29], [
    { table: 'fabric_grants', column: 'used_tokens', type: 'INTEGER', notNull: true, dflt: '0' },
    { table: 'fabric_grants', column: 'used_jobs', type: 'INTEGER', notNull: true, dflt: '0' }]);
  assert.deepEqual(addedColumns('-- ALTER TABLE x ADD COLUMN y\nALTER TABLE "a" ADD b INT;'),
    [{ table: 'a', column: 'b', type: 'INT', notNull: false, dflt: null }]);
  assert.deepEqual(addedColumns("ALTER TABLE r ADD COLUMN inc TEXT NOT NULL DEFAULT 'gen1';").map(c => c.dflt), ["'gen1'"]);
  assert.throws(() => addedColumns('ALTER TABLE a ADD COLUMN b INTEGER CHECK (b > 0);'), /cannot derive expected definition/);
  assert.throws(() => addedColumns('ALTER TABLE a RENAME TO b;'), /unparsed ALTER TABLE/);
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
  assert.match(decide({ columnRows: allCols().map(c => ({ ...c, nn: true })) }).reason, /column state malformed/);
  assert.match(decide({ columnRows: [...allCols(), allCols()[0]] }).reason, /duplicate/);
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

test('0029 columns with the right names but wrong definitions are drift, not PASS', () => {
  const tweak = (name, over) => allCols().map(c => (c.t === 'fabric_grants' && c.name === name ? { ...c, ...over } : c));
  for (const [label, rows, re] of [
    ['wrong type', tweak('used_tokens', { type: 'TEXT' }), /used_tokens is TEXT NOT NULL DEFAULT 0, expected INTEGER NOT NULL DEFAULT 0/],
    ['nullable', tweak('used_jobs', { nn: 0 }), /used_jobs is INTEGER NULL DEFAULT 0/],
    ['no default', tweak('used_jobs', { dflt: null }), /used_jobs is INTEGER NOT NULL DEFAULT none/],
    ['other default', tweak('used_tokens', { dflt: '1' }), /DEFAULT 1, expected INTEGER NOT NULL DEFAULT 0/],
  ]) {
    const d = decide({ columnRows: rows });
    assert.equal(d.hold, true, label);
    assert.match(d.reason, /schema drift: 0029_fabric_dispatch_spend\.sql column definition mismatch/, label);
    assert.match(d.reason, re, label);
  }
  assert.equal(decide({ columnRows: allCols().map(c => ({ ...c, type: c.type.toLowerCase() })) }).hold, false, 'declared type compared case-insensitively');
});

test('Astra repro: nullable TEXT DEFAULT \'bad\' / INTEGER DEFAULT 7 with full journal is drift (was false PASS)', () => {
  const rows = allCols().map(c => (c.t !== 'fabric_grants' ? c
    : c.name === 'used_tokens' ? { ...c, type: 'TEXT', nn: 0, dflt: "'bad'" }
    : c.name === 'used_jobs' ? { ...c, type: 'INTEGER', nn: 0, dflt: '7' } : c));
  const d = decide({ columnRows: rows });
  assert.equal(d.hold, true);
  assert.match(d.reason, /used_tokens is TEXT NULL DEFAULT 'bad', expected INTEGER NOT NULL DEFAULT 0/);
  assert.match(d.reason, /used_jobs is INTEGER NULL DEFAULT 7, expected INTEGER NOT NULL DEFAULT 0/);
});

// Diagnostic (FIXTURES): fixed 0029 journal row + fabric_grants pragma rows.
const fg = (over = {}) => [
  { t: 'fabric_grants', name: 'id', type: 'TEXT', nn: 1, dflt: null },
  { t: 'fabric_grants', name: 'used_tokens', type: 'INTEGER', nn: 1, dflt: '0', ...over.used_tokens },
  { t: 'fabric_grants', name: 'used_jobs', type: 'INTEGER', nn: 1, dflt: '0', ...over.used_jobs },
].filter(r => !(over.drop || []).includes(r.name));
const diag = over => diagnose0029({ expected, journalRows: [{ name: M29 }], columnRows: fg(), ...over });

test('diagnostic verdicts: APPLIED, NOT_APPLIED, AMBIGUOUS, DRIFT', () => {
  assert.equal(diag({}).verdict, 'APPLIED');
  assert.equal(diag({ journalRows: [], columnRows: fg({ drop: ['used_tokens', 'used_jobs'] }) }).verdict, 'NOT_APPLIED');
  assert.equal(diag({ journalRows: [] }).verdict, 'AMBIGUOUS');
  assert.equal(diag({ journalRows: [], columnRows: fg({ drop: ['used_jobs'] }) }).verdict, 'AMBIGUOUS');
  assert.equal(diag({ columnRows: fg({ used_jobs: { nn: 0, dflt: '7' } }) }).verdict, 'DRIFT');
  assert.equal(diag({ columnRows: fg({ drop: ['used_jobs'] }) }).verdict, 'DRIFT');
});

test('diagnostic fails closed on bad responses and emits only sanitized metadata', () => {
  for (const over of [{ journalRows: null }, { columnRows: null }, { columnRows: [] },
    { journalRows: [{ name: 'other.sql' }] }, { journalRows: [{ name: M29 }, { name: M29 }] },
    { columnRows: [{ t: 'fabric_grants', name: 'used_jobs', type: 'INTEGER', nn: true, dflt: '0' }] },
    { columnRows: [...fg(), fg()[1]] }])
    assert.equal(diag(over).verdict, 'UNOBSERVABLE', JSON.stringify(over));
  const d = diag({ journalRows: null, journalErr: '{"error":{"text":"Authentication error [code: 7403] acct 5bdd4f746ccac889f54e026435565e70"}}' });
  assert.deepEqual(d.error_codes, ['7403']);
  assert.doesNotMatch(JSON.stringify(d), /5bdd4f74|Authentication/, 'no raw error text or identifiers');
  const ok = diag({});
  assert.deepEqual(Object.keys(ok).sort(), ['columns', 'error_codes', 'journal_0029', 'migration', 'schema', 'verdict']);
  assert.deepEqual(Object.keys(ok.columns).sort(), ['used_jobs', 'used_tokens'], 'no other column names leak');
});

test('diagnose CLI: failed reads are UNOBSERVABLE, never a crash or PASS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diag-'));
  const j = join(dir, 'j'), c = join(dir, 'c'), e = join(dir, 'e');
  writeFileSync(j, fixtureD1([{ name: M29 }])); writeFileSync(c, fixtureD1(fg()));
  writeFileSync(e, '✘ [ERROR] A request to the Cloudflare API failed. Authentication error [code: 10000]');
  const run = args => spawnSync(process.execPath, [SCRIPT, 'diagnose', ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
  let r = run(['--journal', j, '--columns', c]);
  assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).verdict, 'APPLIED');
  r = run(['--journal', j, '--columns', c, '--columns-exit', '1', '--columns-stderr', e]);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, 'UNOBSERVABLE'); assert.deepEqual(out.error_codes, ['10000']);
  assert.equal(run(['--journal', j]).status, 2);
});

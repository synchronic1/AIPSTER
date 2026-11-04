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
import { readSizes, describeRead, diagnose0029, addedColumns, expectedColumns, listRepoMigrations, parseD1Rows, probeSql,
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
  const ok = diag({});
  assert.deepEqual(Object.keys(ok).sort(), ['columns', 'columns_read', 'journal_0029', 'journal_read', 'migration', 'schema', 'verdict']);
  assert.deepEqual(Object.keys(ok.columns).sort(), ['used_jobs', 'used_tokens'], 'no other column names leak');
});

// Shapes from wrangler 4.153.0 --json: success prints the D1 result array;
// failure prints {"error": {...}} on STDOUT and exits non-zero (FIXTURES).
const core = (r) => ({ exit: r.exit, shape: r.shape, error_code: r.error_code, error_class: r.error_class });
const wErr = (error) => JSON.stringify({ error }, null, 2);
test('describeRead classifies the run 41935825294 failure path instead of losing it', () => {
  const ACCT = '5bdd4f746ccac889f54e026435565e70';
  const api = describeRead(wErr({ name: 'APIError', text: `A request to the Cloudflare API (/accounts/${ACCT}/d1/database/x/query) failed.`,
    notes: [{ text: 'Authentication error [code: 10000]' }], kind: 'error', code: 10000 }), '', 1);
  assert.deepEqual(api, { exit: 1, shape: 'wrangler-error', error_code: 10000, error_class: 'authentication' });
  assert.deepEqual(describeRead(wErr({ text: 'In a non-interactive environment, it\'s necessary to set a CLOUDFLARE_API_TOKEN' }), '', 1),
    { exit: 1, shape: 'wrangler-error', error_code: null, error_class: 'missing-api-token' });
  assert.equal(describeRead(wErr({ text: 'More than one account available but unable to select one in non-interactive mode.' }), '', 1).error_class, 'account-selection');
  assert.equal(describeRead(wErr({ text: 'no such table: d1_migrations: SQLITE_ERROR', code: 7500 }), '', 1).error_class, 'no-such-table');
  assert.equal(describeRead(wErr({ text: 'something new' }), '', 1).error_class, 'unclassified');
  assert.deepEqual(describeRead('', 'npm error could not determine executable to run', 1),
    { exit: 1, shape: 'empty', error_code: null, error_class: 'unclassified' });
  assert.deepEqual(describeRead('', 'Error: fetch failed ECONNRESET', 1).error_class, 'network');
  assert.equal(describeRead('not json', '', 0).shape, 'not-json');
  assert.equal(describeRead(fixtureD1([{ name: M29 }]), '', 0).shape, 'd1-result');
  assert.deepEqual(describeRead(fixtureD1([]), '', 0), { exit: 0, shape: 'd1-result', error_code: null, error_class: null });
  assert.equal(describeRead(wErr({ text: 'x', code: '7403' }), '', 1).error_code, null, 'only integer codes are emitted');
  const all = JSON.stringify([api, describeRead(wErr({ text: `acct ${ACCT} token abc123` }), `token=abc123 ${ACCT}`, 1)]);
  assert.doesNotMatch(all, /5bdd4f74|abc123|Cloudflare API|accounts/, 'no raw text, ids or tokens are emitted');
});

test('diagnose CLI: failed reads are UNOBSERVABLE with a safe classification, never a crash or PASS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diag-'));
  const j = join(dir, 'j'), c = join(dir, 'c'), e = join(dir, 'e'), je = join(dir, 'je');
  writeFileSync(j, fixtureD1([{ name: M29 }])); writeFileSync(c, fixtureD1(fg()));
  writeFileSync(e, ''); writeFileSync(je, wErr({ name: 'APIError', text: 'A request to the Cloudflare API failed.',
    notes: [{ text: 'Authentication error [code: 10000]' }], code: 10000 }));
  const run = args => spawnSync(process.execPath, [SCRIPT, 'diagnose', ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
  let r = run(['--journal', j, '--columns', c]);
  assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).verdict, 'APPLIED');
  // Exactly the run 41935825294 outcome: error JSON on the journal STDOUT, exit 1.
  r = run(['--journal', je, '--columns', c, '--journal-exit', '1', '--journal-stderr', e]);
  assert.equal(r.status, 3, 'UNOBSERVABLE fails the step after the report');
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, 'UNOBSERVABLE');
  assert.equal(out.reason, 'journal read failed or malformed');
  assert.deepEqual(core(out.journal_read), { exit: 1, shape: 'wrangler-error', error_code: 10000, error_class: 'authentication' });
  assert.equal(out.columns_read.shape, 'd1-result');
  assert.doesNotMatch(r.stdout, /Cloudflare API|Authentication error/);
  assert.equal(run(['--journal', j]).status, 2);
});

test('journal and columns are reported independently; verdict still needs both', () => {
  // Run 41935825294 shape: journal read failed, column read may have succeeded.
  const d = diag({ journalRows: null });
  assert.equal(d.verdict, 'UNOBSERVABLE');
  assert.equal(d.journal_0029, 'unobservable');
  assert.deepEqual(d.columns, { used_tokens: 'INTEGER NOT NULL DEFAULT 0', used_jobs: 'INTEGER NOT NULL DEFAULT 0' },
    'a valid column read is still reported');
  assert.equal(d.reason, 'journal read failed or malformed');
  const c = diag({ columnRows: null });
  assert.equal(c.verdict, 'UNOBSERVABLE'); assert.equal(c.journal_0029, 'present'); assert.equal(c.columns, null);
  assert.equal(c.reason, 'fabric_grants column read failed, empty or malformed');
  const both = diag({ journalRows: null, columnRows: [...fg(), fg()[1]] });
  assert.equal(both.reason, 'journal read failed or malformed; duplicate column rows');
  assert.equal(both.columns, null);
});

test('diagnose CLI reports both reads when the journal fails and columns succeed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diag2-'));
  const je = join(dir, 'je'), c = join(dir, 'c');
  writeFileSync(je, wErr({ name: 'APIError', text: 'A request to the Cloudflare API failed.', code: 7500 }));
  writeFileSync(c, fixtureD1(fg()));
  const r = spawnSync(process.execPath, [SCRIPT, 'diagnose', '--journal', je, '--columns', c, '--journal-exit', '1'],
    { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, 'UNOBSERVABLE');
  assert.deepEqual(core(out.journal_read), { exit: 1, shape: 'wrangler-error', error_code: 7500, error_class: 'unclassified' });
  assert.deepEqual(core(out.columns_read), { exit: 0, shape: 'd1-result', error_code: null, error_class: null });
  assert.equal(out.columns.used_jobs, 'INTEGER NOT NULL DEFAULT 0');
  assert.doesNotMatch(r.stdout, /Cloudflare API/);
});

test('per-read sizes are counts only; version is a bare version string', async () => {
  assert.deepEqual(readSizes(fixtureD1([{ name: M29 }]), ''), { stdout_bytes: Buffer.byteLength(fixtureD1([{ name: M29 }])), stderr_bytes: 0, rows: 1 });
  assert.deepEqual(readSizes(fixtureD1([]), 'warn'), { stdout_bytes: Buffer.byteLength(fixtureD1([])), stderr_bytes: 4, rows: 0 });
  assert.deepEqual(readSizes(wErr({ text: 'x', code: 7500 }), null), { stdout_bytes: Buffer.byteLength(wErr({ text: 'x', code: 7500 })), stderr_bytes: null, rows: null });
  const { installedWranglerVersion } = await import('../scripts/migration-state.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'wv-'));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'node_modules/wrangler'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/wrangler/package.json'), JSON.stringify({ version: '4.153.0' }));
  assert.equal(installedWranglerVersion(dir), '4.153.0');
  writeFileSync(join(dir, 'node_modules/wrangler/package.json'), JSON.stringify({ version: '4.153.0 token=abc' }));
  assert.equal(installedWranglerVersion(dir), null);
  assert.equal(installedWranglerVersion(join(dir, 'missing')), null);
});

test('diagnose CLI exit: 0 for a decided verdict, 3 for UNOBSERVABLE, never raw text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diag3-'));
  const j0 = join(dir, 'j0'), c = join(dir, 'c'), bad = join(dir, 'bad');
  writeFileSync(j0, fixtureD1([])); writeFileSync(c, fixtureD1(fg({ drop: ['used_tokens', 'used_jobs'] }))); writeFileSync(bad, 'Error: something\n[{"results":[]}]');
  const run = args => spawnSync(process.execPath, [SCRIPT, 'diagnose', ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
  let r = run(['--journal', j0, '--columns', c]);
  assert.equal(r.status, 0); const ok = JSON.parse(r.stdout);
  assert.equal(ok.verdict, 'NOT_APPLIED', 'a successful empty journal result is decided, not unobservable');
  assert.equal(ok.journal_read.rows, 0);
  r = run(['--journal', bad, '--columns', c]);
  assert.equal(r.status, 3);
  const out = JSON.parse(r.stdout);
  assert.equal(out.journal_read.shape, 'not-json', 'log-contaminated output is never scraped for an embedded array');
  assert.doesNotMatch(r.stdout, /something/);
});

#!/usr/bin/env node
// State-aware production schema preflight (fail closed, read-only).
//
// Replaces the blanket "any migration diff since live" hold with a decision
// over the AUTHORITATIVE production state: the D1 `d1_migrations` journal and
// the observed columns of every table the repo's migrations ALTER. It never
// applies, edits or repairs a migration; anything not proven applied holds.
//
// Inputs are the raw `wrangler d1 execute --remote --json` outputs captured by
// the workflow (read-only SELECTs). A missing, failed, empty or malformed
// read is "unobservable" and holds. Git diffs are never treated as proof of
// production state in either direction.
//
// Idempotency: the ALTER TABLE ... ADD COLUMN migrations (e.g. 0029) are not
// re-runnable, so "columns present but journal entry missing" is an
// out-of-band/partial state that needs operator reconciliation, and
// "journaled but columns missing" is drift. Both hold.
//
// CLI (working directory: website/):
//   node scripts/migration-state.mjs probe-sql
//   node scripts/migration-state.mjs decide --journal j.json --columns c.json
//     [--journal-exit N] [--columns-exit N] [--baseline-hold true|false --baseline-reason R]
// `decide` prints the decision JSON and, under Actions, appends hold/reason
// to $GITHUB_OUTPUT. Exit 0 whether or not it holds; usage errors exit 2.

import { readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(HERE, '../migrations');
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const M0029 = '0029_fabric_dispatch_spend.sql';

export function listRepoMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort();
}

// One ADD COLUMN definition: `name TYPE [NOT NULL] [DEFAULT literal]
// [REFERENCES t(c)]`. Anything else is not derivable and throws (fail
// closed): the expected definition must be exact, never guessed.
const DEF = /^(\w+)\s+(\w+)(\s+NOT\s+NULL)?(?:\s+DEFAULT\s+(-?\d+(?:\.\d+)?|'(?:[^']|'')*'))?(?:\s+REFERENCES\s+\w+\s*\(\s*\w+\s*\))?$/i;

/** ADD COLUMN statements in one migration's SQL (comments stripped). */
export function addedColumns(sql) {
  const text = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const re = /ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ADD\s+(?:COLUMN\s+)?([^;]+);/gi;
  for (let m; (m = re.exec(text));) {
    const def = m[2].trim().replace(/\s+/g, ' ').replace(/^["`](\w+)["`]/, '$1');
    const d = DEF.exec(def);
    if (!d) throw new Error(`cannot derive expected definition for ALTER TABLE ${m[1]} ADD COLUMN ${def}`);
    out.push({ table: m[1], column: d[1], type: d[2].toUpperCase(), notNull: !!d[3], dflt: d[4] ?? null });
  }
  if (/ALTER\s+TABLE/i.test(text) && out.length !== (text.match(/ALTER\s+TABLE/gi) || []).length)
    throw new Error('unparsed ALTER TABLE statement (fail closed)');
  return out;
}

/** Expected ADD COLUMN facts per migration file, from the reviewed checkout. */
export function expectedColumns(dir = MIGRATIONS_DIR) {
  const map = {};
  for (const f of listRepoMigrations(dir)) map[f] = addedColumns(readFileSync(resolve(dir, f), 'utf8'));
  return map;
}

/** One read-only SELECT returning (t, name) for every altered table. */
export function probeSql(expected) {
  const tables = [...new Set(Object.values(expected).flat().map(c => c.table))].sort();
  if (!tables.length) return null;
  for (const t of tables) if (!IDENT.test(t)) throw new Error(`unsafe table name ${t}`);
  return tables.map(t => `SELECT '${t}' AS t, name, type, "notnull" AS nn, dflt_value AS dflt FROM pragma_table_info('${t}')`).join(' UNION ALL ') + ';';
}

/**
 * Parse `wrangler d1 execute --json` output into rows, or null when the read
 * is not a single successful result set (unobservable).
 */
export function parseD1Rows(text, exitCode = 0) {
  if (exitCode !== 0 || typeof text !== 'string' || !text.trim()) return null;
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(data) || data.length !== 1) return null;
  const r = data[0];
  if (!r || r.success !== true || !Array.isArray(r.results)) return null;
  return r.results;
}

/**
 * Pure decision. `journalRows`/`columnRows` are parsed rows or null.
 * Returns {hold, reason, pending, applied}.
 */
export function schemaStateDecision({ repoMigrations, expected, journalRows, columnRows }) {
  const H = reason => ({ hold: true, reason });
  if (!Array.isArray(repoMigrations) || !repoMigrations.length) return H('no reviewed migrations found in checkout');
  if (!journalRows) return H('production migration journal unobservable');
  if (!journalRows.length || !journalRows.every(r => r && typeof r.name === 'string'))
    return H('production migration journal empty or malformed');
  const names = journalRows.map(r => r.name);
  const seen = new Set(), dups = new Set();
  for (const n of names) (seen.has(n) ? dups : seen).add(n);
  if (dups.size) return H(`ambiguous journal: duplicate entries ${[...dups].join(', ')}`);
  const unknown = names.filter(n => !repoMigrations.includes(n));
  if (unknown.length) return H(`production journal has migrations unknown to the target: ${unknown.join(', ')}`);

  const needsColumns = Object.values(expected || {}).some(c => c.length);
  const cols = new Map();
  if (needsColumns) {
    if (!columnRows) return H('production column state unobservable');
    if (!columnRows.every(r => r && typeof r.t === 'string' && typeof r.name === 'string'
      && typeof r.type === 'string' && (r.nn === 0 || r.nn === 1)
      && (r.dflt === null || typeof r.dflt === 'string')))
      return H('production column state malformed');
    for (const r of columnRows) {
      const k = `${r.t}.${r.name}`;
      if (cols.has(k)) return H(`ambiguous column state: duplicate ${k}`);
      cols.set(k, r);
    }
  }
  const has = c => cols.has(`${c.table}.${c.column}`);
  // Exact definition: declared type, NOT NULL and default as written.
  const mismatch = c => {
    const r = cols.get(`${c.table}.${c.column}`);
    const want = `${c.type} ${c.notNull ? 'NOT NULL' : 'NULL'} DEFAULT ${c.dflt ?? 'none'}`;
    const got = `${r.type.toUpperCase()} ${r.nn ? 'NOT NULL' : 'NULL'} DEFAULT ${r.dflt ?? 'none'}`;
    return want === got ? null : `${c.table}.${c.column} is ${got}, expected ${want}`;
  };

  const pending = repoMigrations.filter(m => !seen.has(m));
  for (const m of repoMigrations) {
    const c = (expected && expected[m]) || [];
    if (seen.has(m)) {
      const missing = c.filter(x => !has(x));
      if (missing.length)
        return H(`schema drift: ${m} journaled but columns missing: ${missing.map(x => `${x.table}.${x.column}`).join(', ')}`);
      const wrong = c.map(mismatch).filter(Boolean);
      if (wrong.length) return H(`schema drift: ${m} column definition mismatch: ${wrong.join('; ')}`);
    } else if (c.some(has)) {
      return H(`ambiguous schema: ${m} not journaled but its columns exist (out-of-band or partial apply; operator reconciliation required, do not re-run)`);
    }
  }
  if (pending.length)
    return { hold: true, reason: `unapplied migrations (operator must apply before deploy): ${pending.join(', ')}`, pending, applied: names.length };
  return { hold: false, reason: `production schema matches all ${repoMigrations.length} reviewed migrations`, pending: [], applied: names.length };
}

// Allowlisted failure labels. Only the label is ever emitted, never text.
const ERROR_CLASSES = [
  ['missing-api-token', /CLOUDFLARE_API_TOKEN|non-interactive environment|wrangler login/i],
  ['account-selection', /more than one account|account_id|select an account/i],
  ['authentication', /authenticat|unauthori[sz]ed|not authori[sz]ed|forbidden|permission/i],
  ['database-not-found', /couldn'?t find a D1|database .*not found|could not be found/i],
  ['no-such-table', /no such table/i],
  ['sql-error', /SQLITE_|syntax error|no such column/i],
  ['network', /ECONN|ETIMEDOUT|ENOTFOUND|fetch failed|socket/i],
];
const classify = (...texts) => {
  const t = texts.filter(x => typeof x === 'string').join('\n');
  if (!t.trim()) return null;
  for (const [label, re] of ERROR_CLASSES) if (re.test(t)) return label;
  return 'unclassified';
};

/**
 * Safe description of one `wrangler d1 execute --json` read. Wrangler 4.x
 * prints a --json failure as `{"error": {...}}` on STDOUT (JsonFriendlyFatalError
 * via logger.log) and exits non-zero; APIError carries a numeric `code`.
 * Emits only exit code, response shape, an integer code and an allowlisted
 * label; never raw stdout/stderr text.
 */
/** Byte/row counts only (never content), reported beside describeRead. */
export function readSizes(stdout, stderr) {
  const bytes = t => (typeof t === 'string' ? Buffer.byteLength(t) : null);
  const rows = parseD1Rows(stdout, 0);
  return { stdout_bytes: bytes(stdout), stderr_bytes: bytes(stderr), rows: rows ? rows.length : null };
}

export function describeRead(stdout, stderr, exitCode) {
  const out = { exit: Number.isSafeInteger(exitCode) ? exitCode : null, shape: 'empty', error_code: null, error_class: null };
  let data;
  if (typeof stdout === 'string' && stdout.trim()) {
    try { data = JSON.parse(stdout); out.shape = 'unexpected-json'; } catch { out.shape = 'not-json'; }
  }
  if (Array.isArray(data) && data.length === 1 && data[0] && data[0].success === true && Array.isArray(data[0].results)) {
    out.shape = 'd1-result';
  } else if (data && typeof data === 'object' && !Array.isArray(data) && data.error && typeof data.error === 'object') {
    out.shape = 'wrangler-error';
    if (Number.isSafeInteger(data.error.code) && data.error.code > 0) out.error_code = data.error.code;
    const notes = Array.isArray(data.error.notes) ? data.error.notes.map(n => n && n.text) : [];
    out.error_class = classify(data.error.text, ...notes) || 'unclassified';
  }
  if (out.shape !== 'd1-result' && !out.error_class) out.error_class = classify(stderr) || (out.exit ? 'unclassified' : null);
  return out;
}

/**
 * Sanitized 0029 diagnostic over the two fixed diagnostic reads. Emits only
 * the verdict, the 0029 journal presence, the two column definitions and a
 * safe description of each read; never other column names or raw text.
 */
export function diagnose0029({ expected, journalRows, columnRows, journalRead = null, columnsRead = null }) {
  const want = (expected && expected[M0029]) || [];
  const out = { schema: 'aipster.schema-diagnostic/v2', migration: M0029, verdict: 'UNOBSERVABLE',
    journal_0029: 'unobservable', columns: null, journal_read: journalRead, columns_read: columnsRead };
  if (want.length !== 2) { out.reason = 'expected 0029 definition not derivable'; return out; }
  // Journal and columns are evaluated and reported independently; the
  // verdict needs BOTH to be valid, otherwise it stays UNOBSERVABLE.
  const reasons = [];
  if (!journalRows || !journalRows.every(r => r && r.name === M0029) || journalRows.length > 1) {
    reasons.push('journal read failed or malformed');
  } else {
    out.journal_0029 = journalRows.length ? 'present' : 'absent';
  }
  let present = 0, exact = 0;
  const by = new Map();
  if (!columnRows || !columnRows.length || !columnRows.every(r => r && r.t === 'fabric_grants' && typeof r.name === 'string'
    && typeof r.type === 'string' && (r.nn === 0 || r.nn === 1) && (r.dflt === null || typeof r.dflt === 'string'))) {
    reasons.push('fabric_grants column read failed, empty or malformed');
  } else if (columnRows.some(r => (by.has(r.name) ? true : (by.set(r.name, r), false)))) {
    reasons.push('duplicate column rows');
  } else {
    out.columns = {};
    for (const c of want) {
      const r = by.get(c.column);
      if (!r) { out.columns[c.column] = 'absent'; continue; }
      present++;
      const got = `${r.type.toUpperCase()} ${r.nn ? 'NOT NULL' : 'NULL'} DEFAULT ${r.dflt ?? 'none'}`;
      if (got === `${c.type} ${c.notNull ? 'NOT NULL' : 'NULL'} DEFAULT ${c.dflt ?? 'none'}`) exact++;
      out.columns[c.column] = got;
    }
  }
  if (reasons.length) { out.reason = reasons.join('; '); return out; }
  if (out.journal_0029 === 'present') out.verdict = exact === want.length ? 'APPLIED' : 'DRIFT';
  else out.verdict = present === 0 ? 'NOT_APPLIED' : 'AMBIGUOUS';
  return out;
}

/** Baseline hold (auto mode) is preserved and checked before production state. */
export function combinedDecision({ baselineHold, baselineReason, state }) {
  if (baselineHold) return { hold: true, reason: baselineReason || 'release baseline unverified' };
  return { hold: state.hold, reason: state.reason };
}

function argMap(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}
function readOrNull(p) { try { return readFileSync(p, 'utf8'); } catch { return null; } }
/** Installed wrangler package version (a version string only), or null. */
export function installedWranglerVersion(dir = resolve(HERE, '..')) {
  try {
    const v = JSON.parse(readFileSync(resolve(dir, 'node_modules/wrangler/package.json'), 'utf8')).version;
    return typeof v === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v) ? v : null;
  } catch { return null; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    const expected = expectedColumns();
    if (cmd === 'probe-sql') {
      const sql = probeSql(expected);
      if (!sql) throw new Error('no altered tables to probe');
      process.stdout.write(sql + '\n');
    } else if (cmd === 'decide') {
      const a = argMap(rest);
      if (!a.journal || !a.columns) throw new Error('decide requires --journal and --columns');
      const state = schemaStateDecision({
        repoMigrations: listRepoMigrations(), expected,
        journalRows: parseD1Rows(readOrNull(a.journal), Number(a['journal-exit'] ?? 0)),
        columnRows: parseD1Rows(readOrNull(a.columns), Number(a['columns-exit'] ?? 0)),
      });
      const d = combinedDecision({ baselineHold: a['baseline-hold'] === 'true', baselineReason: a['baseline-reason'], state });
      const reason = d.reason.replace(/[\r\n]+/g, ' ');
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `hold=${d.hold}\nreason=${reason}\n`);
      console.log((d.hold ? 'HOLD: ' : 'PROCEED: ') + reason);
      console.log(JSON.stringify({ ...d, pending: state.pending || null, applied: state.applied ?? null }));
    } else if (cmd === 'diagnose') {
      const a = argMap(rest);
      if (!a.journal || !a.columns) throw new Error('diagnose requires --journal and --columns');
      const jOut = readOrNull(a.journal), cOut = readOrNull(a.columns);
      const jErr = a['journal-stderr'] ? readOrNull(a['journal-stderr']) : '';
      const cErr = a['columns-stderr'] ? readOrNull(a['columns-stderr']) : '';
      const jExit = Number(a['journal-exit'] ?? 0), cExit = Number(a['columns-exit'] ?? 0);
      const d = diagnose0029({ expected,
        journalRows: parseD1Rows(jOut, jExit), columnRows: parseD1Rows(cOut, cExit),
        journalRead: { ...describeRead(jOut, jErr, jExit), ...readSizes(jOut, jErr) },
        columnsRead: { ...describeRead(cOut, cErr, cExit), ...readSizes(cOut, cErr) } });
      d.wrangler_version = installedWranglerVersion();
      console.log(JSON.stringify(d));
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Schema diagnostic (read-only, no deploy)\n\n\`${JSON.stringify(d)}\`\n`);
      // The sanitized report is printed first; an unobservable state then
      // fails the job so a green run can never be read as schema evidence.
      if (d.verdict === 'UNOBSERVABLE') process.exit(3);
    } else {
      throw new Error('usage: migration-state.mjs probe-sql | decide ... | diagnose --journal <f> --columns <f> [...]');
    }
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(2);
  }
}

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

export function listRepoMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort();
}

/** ADD COLUMN statements in one migration's SQL (comments stripped). */
export function addedColumns(sql) {
  const text = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const re = /ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ADD\s+(?:COLUMN\s+)?["`]?(\w+)["`]?/gi;
  for (let m; (m = re.exec(text));) out.push({ table: m[1], column: m[2] });
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
  return tables.map(t => `SELECT '${t}' AS t, name FROM pragma_table_info('${t}')`).join(' UNION ALL ') + ';';
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
  const cols = new Set();
  if (needsColumns) {
    if (!columnRows) return H('production column state unobservable');
    if (!columnRows.every(r => r && typeof r.t === 'string' && typeof r.name === 'string'))
      return H('production column state malformed');
    for (const r of columnRows) cols.add(`${r.t}.${r.name}`);
  }
  const has = c => cols.has(`${c.table}.${c.column}`);

  const pending = repoMigrations.filter(m => !seen.has(m));
  for (const m of repoMigrations) {
    const c = (expected && expected[m]) || [];
    if (seen.has(m)) {
      const missing = c.filter(x => !has(x));
      if (missing.length)
        return H(`schema drift: ${m} journaled but columns missing: ${missing.map(x => `${x.table}.${x.column}`).join(', ')}`);
    } else if (c.some(has)) {
      return H(`ambiguous schema: ${m} not journaled but its columns exist (out-of-band or partial apply; operator reconciliation required, do not re-run)`);
    }
  }
  if (pending.length)
    return { hold: true, reason: `unapplied migrations (operator must apply before deploy): ${pending.join(', ')}`, pending, applied: names.length };
  return { hold: false, reason: `production schema matches all ${repoMigrations.length} reviewed migrations`, pending: [], applied: names.length };
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
    } else {
      throw new Error('usage: migration-state.mjs probe-sql | decide --journal <f> --columns <f> [...]');
    }
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(2);
  }
}

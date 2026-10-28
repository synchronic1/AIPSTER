/* Built with Meta Muse. */
// Operator account disable. Preserves identity classification (the demo flag
// is never modified), then revokes access: disabled=1 blocks new sessions,
// existing sessions are deleted, API keys are revoked, the allowlist entry
// is removed, and --delete-password also removes the password credential.
//
//   node scripts/disable-user.mjs --db aipster-app --user <id-or-email> [--delete-password] [--remote]
//
// Demo procedure: --user demo --delete-password. Rotation stays separate:
// re-run scripts/setup-demo.mjs with a new password.
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { disableUserStatements, sqlQuote } from './lib/operator-sql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wranglerJs = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

function fail(msg) {
  console.error('disable-user: ' + msg);
  process.exit(1);
}

const args = process.argv.slice(2);
function flagValue(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length || args[i + 1].startsWith('--')) return fallback;
  return args[i + 1];
}
const dbName = (flagValue('--db', '') || '').trim() || 'aipster-app';
const remote = args.includes('--remote');
const target = flagValue('--user', '');
const deletePassword = args.includes('--delete-password');
if (!target) fail('pass --user <id-or-email>.');

function wrangler(argv, { stdio = 'pipe' } = {}) {
  const r = spawnSync(process.execPath, [wranglerJs, ...argv], { stdio, cwd: root, encoding: 'utf8' });
  if (!r || r.status !== 0) fail('wrangler failed: ' + ((r && r.stderr) || 'unknown error'));
  return r;
}

// Resolve the target without trusting its claimed identity fields.
const lookup = wrangler(['d1', 'execute', dbName, ...(remote ? ['--remote'] : ['--local']), '--json', '--command',
  `SELECT id, email, username, demo, disabled FROM "user" WHERE id = ${sqlQuote(target)} OR email = ${sqlQuote(target.toLowerCase())} OR username = ${sqlQuote(target)} LIMIT 1`]);
let row = null;
try {
  const parsed = JSON.parse(lookup.stdout);
  const results = Array.isArray(parsed) ? parsed[0].results : parsed.results;
  row = results && results[0] ? results[0] : null;
} catch { row = null; }
if (!row) fail('no such user: ' + target);

const statements = disableUserStatements({ userId: row.id, email: row.email, deletePassword });
console.log(`disable-user: ${row.id} (email=${row.email || 'none'} username=${row.username || 'none'} demo=${row.demo} disabled=${row.disabled}) on ${dbName}${remote ? ' (remote)' : ' (local)'}`);
console.log('disable-user: demo classification is preserved; applying:');
for (const s of statements) console.log('  ' + s + ';');
const sqlFile = path.join(tmpdir(), `aipster-disable-user-${process.pid}.sql`);
writeFileSync(sqlFile, statements.join(';\n') + ';\n', 'utf8');
try {
  wrangler(['d1', 'execute', dbName, ...(remote ? ['--remote'] : ['--local']), '--file', sqlFile], { stdio: 'inherit' });
} finally {
  try { unlinkSync(sqlFile); } catch { /* best effort */ }
}
console.log('disable-user: done. Sessions deleted, keys revoked, new sign-ins blocked.');

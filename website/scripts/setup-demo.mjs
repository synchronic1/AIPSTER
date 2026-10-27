/* Built with Meta Muse. */
// One-time demo-identity setup. Run by the rollout owner AFTER migrations
// 0001-0003 are applied to the target D1 database:
//
//   1. Choose a strong password (>= 20 chars, generated, e.g. with a password
//      manager). Deliver it to whoever needs it over a PRIVATE channel only.
//   2. D1_PASSWORD='<secret>' node scripts/setup-demo.mjs --db aipster-app [--remote]
//   3. The script prints the SQL it will run, then applies it with wrangler.
//      The password itself is hashed with better-auth's own scrypt routine
//      before it ever touches SQL; the plaintext is never stored or logged.
//
// Idempotent: re-running updates the credential row and demo fixtures.
// To rotate: re-run with a new D1_PASSWORD (or answer the hidden prompt).
// To disable: node scripts/disable-user.mjs --db aipster-app --user demo --delete-password [--remote]
//   The demo classification is immutable: disabling keeps demo=1 and revokes
//   sessions/keys/sign-ins. Never "disable" by clearing the demo flag — that
//   would promote the account to live authority.
import { hashPassword } from 'better-auth/crypto';
import { promptPassword } from './lib/prompt-password.mjs';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEMO_USER_ID = 'u_demo';
const DEMO_USERNAME = 'demo';
const DEMO_EMAIL = 'demo@aipster.invalid';
const DEMO_NAME = 'Demo explorer';

function fail(msg) {
  console.error('setup-demo: ' + msg);
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
let password = process.env.D1_PASSWORD;
if (!password) {
  try {
    password = await promptPassword('Demo password (min 20 chars, hidden): ');
  } catch (e) {
    fail(e.message + ' Or set D1_PASSWORD to a generated password of at least 20 characters.');
  }
}
if (!password || password.length < 20) {
  fail('use a generated password of at least 20 characters (D1_PASSWORD or the hidden prompt).');
}
const now = new Date().toISOString();

const hash = await hashPassword(password);
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const statements = [
  // Identity: username + unroutable email, demo workspace flag. NOT added to
  // the OAuth allowlist: this account signs in only via username/password.
  `INSERT INTO "user" (id, name, email, emailVerified, image, username, displayUsername, demo, createdAt, updatedAt)
   VALUES (${q(DEMO_USER_ID)}, ${q(DEMO_NAME)}, ${q(DEMO_EMAIL)}, 0, NULL, ${q(DEMO_USERNAME)}, ${q(DEMO_USERNAME)}, 1, ${q(now)}, ${q(now)})
   ON CONFLICT(id) DO UPDATE SET name=excluded.name, username=excluded.username,
     displayUsername=excluded.displayUsername, demo=1, updatedAt=excluded.updatedAt`,
  `INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
   VALUES ('acc_demo_credential', ${q(DEMO_USER_ID)}, 'credential', ${q(DEMO_USER_ID)}, ${q(hash)}, ${q(now)}, ${q(now)})
   ON CONFLICT(id) DO UPDATE SET password=excluded.password, updatedAt=excluded.updatedAt`,
  // Isolated synthetic fixtures, owned by the demo user only.
  `INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated, online, usable, heartbeat_at, limits_json, scope, verification_json, credits_json, created_at)
   VALUES ('r_demo_1', ${q(DEMO_USER_ID)}, 'Demo inference node (simulated)', 'local', 'demo-fixture', 'demo cpu', 'none', '["demo-echo"]', 1, 0, 0, 0, NULL, '{}', 'owner only', ${q(JSON.stringify({ note: 'DEMO DATA: fixture; not a real node.' }))}, NULL, ${q(now)})
   ON CONFLICT(id) DO NOTHING`,
  `INSERT INTO usage (id, owner_id, kind, requests, tokens_in, tokens_out, model_cost_usd, execution_cost_usd, cost_source, at)
   VALUES ('u_demo_1', ${q(DEMO_USER_ID)}, 'demo-inference', 12, 900, 1400, NULL, NULL, 'demo-estimate', ${q(now)})
   ON CONFLICT(id) DO NOTHING`
];

console.log('-- demo setup for D1 database: ' + dbName + (remote ? ' (remote)' : ' (local)'));
for (const s of statements) console.log(s.replace(/'[^']*:[0-9a-f]{32,}[^']*'/, "'<scrypt-hash-redacted>'") + ';');
// SQL travels via a temp file (--file), never process argv: no shell-quoting
// bugs and the hash never appears in process listings.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sqlFile = path.join(tmpdir(), `aipster-setup-demo-${process.pid}.sql`);
writeFileSync(sqlFile, statements.join(';\n') + ';\n', 'utf8');
let wr;
try {
  wr = spawnSync(process.execPath, [path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'd1', 'execute', dbName, ...(remote ? ['--remote'] : ['--local']), '--file', sqlFile], { stdio: 'inherit', cwd: root });
} finally {
  try { unlinkSync(sqlFile); } catch { /* best effort */ }
}
if (!wr || wr.status !== 0) fail('wrangler d1 execute failed.');
console.log('setup-demo: demo identity ready. Rotate with a new D1_PASSWORD; disable per header comment.');

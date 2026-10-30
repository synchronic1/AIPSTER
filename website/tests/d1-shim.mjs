/* Built with Meta Muse. */
// Test-only D1-compatible shim over node:sqlite (never shipped).
// Replicates better-call's signed session-cookie format (HMAC-SHA256,
// base64, URI-encoded) exactly as verified in better-auth 1.7.14, so tests
// exercise the REAL better-auth signature + DB verification path.
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEST_SECRET = 'test-only-better-auth-secret-0123456789abcdef-0123456789abcdef';
export const TEST_URL = 'http://localhost:8787';

let batchSeq = 0;

export function createD1Shim(sqlite) {
  const bound = (sql, params) => ({
    sql, params,
    bind(...p) { return bound(sql, p); },
    async all() { return { results: sqlite.prepare(sql).all(...params), success: true, meta: {} }; },
    async first(col) {
      const row = sqlite.prepare(sql).get(...params) ?? null;
      if (col === undefined || row === null) return row;
      return row[col] ?? null;
    },
    async run() {
      const info = sqlite.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    }
  });
  return {
    prepare(sql) { return bound(sql, []); },
    async batch(stmts) {
      // F1R3: mirror D1 batch-as-transaction (proven by
      // qa-d1-contract.test.mjs against real local D1): all-or-nothing.
      // Savepoints (nestable) instead of BEGIN: deterministic test
      // interleavings run a nested batch inside an intercepted
      // statement, which then behaves like a separate serial batch.
      // Statements execute through their own run()/all() methods so
      // white-box statement interceptors observe them.
      const sp = `f1r3_${++batchSeq}`;
      sqlite.exec(`SAVEPOINT ${sp}`);
      const out = [];
      try {
        for (const s of stmts) {
          const isSelect = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(s.sql || '');
          if (s && typeof s.run === 'function' && typeof s.all === 'function') {
            out.push(isSelect ? await s.all() : await s.run());
          } else if (isSelect) {
            out.push({ results: sqlite.prepare(s.sql).all(...(s.params || [])), success: true, meta: {} });
          } else {
            const info = sqlite.prepare(s.sql).run(...(s.params || []));
            out.push({ success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } });
          }
        }
        sqlite.exec(`RELEASE ${sp}`);
        return out;
      } catch (e) {
        try { sqlite.exec(`ROLLBACK TO ${sp}`); sqlite.exec(`RELEASE ${sp}`); } catch { /* torn down */ }
        throw e;
      }
    },
    async exec(sql) { sqlite.exec(sql); return { success: true }; }
  };
}

export const MIGRATION_FILES = ['0001_better_auth.sql', '0002_app.sql', '0003_demo_auth.sql', '0004_disable_flag.sql', '0005_write_budget.sql', '0006_fabric.sql', '0007_consent.sql', '0008_repair2.sql', '0009_state_layer.sql', '0010_revision_receipts.sql', '0011_fabric_admission.sql', '0012_fabric_restriction_admission.sql', '0013_heartbeat_binding.sql', '0014_fabric_restriction_receipts.sql', '0015_pairing.sql'];

export function applyMigrations(sqlite, names = MIGRATION_FILES) {
  for (const name of names) {
    sqlite.exec(readFileSync(path.join(ROOT, 'migrations', name), 'utf8'));
  }
}

export function signSessionCookie(token, secret) {
  const sig = createHmac('sha256', secret).update(token, 'utf8').digest('base64');
  return encodeURIComponent(`${token}.${sig}`);
}

export function sessionCookieHeader(token, secret) {
  return `better-auth.session_token=${signSessionCookie(token, secret)}`;
}

export async function createTestEnv(overrides = {}) {
  const sqlite = new DatabaseSync(':memory:');
  const skipMigrations = !!overrides.skipMigrations;
  if (!skipMigrations) applyMigrations(sqlite);
  const DB = createD1Shim(sqlite);
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  const seed = async (email, name, id) => {
    await DB.prepare('INSERT INTO allowlist (email, added_at) VALUES (?, ?)').bind(email, now).run();
    await DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, name, email, 1, null, now, now).run();
    const token = randomBytes(32).toString('hex');
    await DB.prepare('INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('s_' + token.slice(0, 8), future, token, now, now, null, 'test', id).run();
    return { id, name, email, token };
  };
  const alice = skipMigrations ? null : await seed('alice@example.com', 'Alice', 'u_alice');
  const bob = skipMigrations ? null : await seed('bob@example.com', 'Bob', 'u_bob');
  const assetsHits = [];
  const ASSETS = {
    async fetch(input) {
      const req = input instanceof Request ? input : new Request(input);
      const p = new URL(req.url).pathname;
      assetsHits.push(p);
      const bodies = {
        '/app/index.html': '<!doctype html><title>app</title><script src="/app/app.js"></script>',
        '/app/app.js': '/* panel */',
        '/': '<!doctype html><title>landing</title>'
      };
      if (bodies[p]) return new Response(bodies[p], { status: 200, headers: { 'Content-Type': p.endsWith('.js') ? 'text/javascript' : 'text/html' } });
      return new Response('asset missing', { status: 404 });
    }
  };
  const env = {
    DB, ASSETS,
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: TEST_URL,
    GITHUB_CLIENT_ID: 'test-client-id',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
    ...overrides
  };
  // Fresh worker module per env so the per-isolate auth cache cannot leak DBs.
  const worker = await import(`../src/worker.js?env=${randomBytes(4).toString('hex')}`);
  const call = (pathname, { method = 'GET', headers = {}, body } = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    return worker.default.fetch(new Request(TEST_URL + pathname, init), env);
  };
  const as = (user) => ({ Cookie: sessionCookieHeader(user.token, TEST_SECRET) });
  const csrf = { 'X-Aipster-CSRF': '1' };
  return { env, DB, sqlite, alice, bob, call, as, csrf, assetsHits };
}

export async function readJson(res) {
  const text = await res.text();
  try { return { status: res.status, headers: res.headers, json: JSON.parse(text), text }; }
  catch { return { status: res.status, headers: res.headers, json: null, text }; }
}

/* Built with Meta Muse. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { verifyLive } from '../scripts/verify-live.mjs';

// Finding 7: readiness validates the migration contract (columns), not just
// table names. A database at 0001-0003 must not report ready.
test('health fails closed when migration columns are missing', async () => {
  const t = await createTestEnv();
  t.sqlite.exec('ALTER TABLE "user" DROP COLUMN disabled');
  const missing0004 = await readJson(await t.call('/api/health'));
  assert.equal(missing0004.json.ready, false);
  assert.equal(missing0004.json.detail.schema, false);

  const t2 = await createTestEnv();
  t2.sqlite.exec('DROP INDEX idx_user_username; ALTER TABLE "user" DROP COLUMN username');
  const missing0003 = await readJson(await t2.call('/api/health'));
  assert.equal(missing0003.json.ready, false);

  const t3 = await createTestEnv();
  t3.sqlite.exec('DROP TABLE rateLimit');
  const missingTable = await readJson(await t3.call('/api/health'));
  assert.equal(missingTable.json.ready, false);
});

// Finding 8: the deployment verifier requires the reviewed readiness signal.
const commit = '1'.repeat(40);
async function verifierFixture(t, healthBody) {
  const dist = await mkdtemp(join(tmpdir(), 'aipster-f77-verifier-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await mkdir(join(dist, 'app'));
  const data = {
    'index.html': '<title>Landing</title>', 'app/index.html': '<title>Sign in</title>',
    'app/app.js': '/* reviewed client */', 'release.json': '{}',
    'deployment.json': JSON.stringify({ git_commit: commit, source_manifest_sha256: 'fixture' })
  };
  for (const [p, body] of Object.entries(data)) await writeFile(join(dist, p), body);
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    let status = 200, body, headers = { 'Content-Type': 'application/json' };
    const asset = path === '/' ? 'index.html' : path === '/app/' ? 'app/index.html' : path.slice(1);
    if (asset in data) {
      body = data[asset];
      headers['Cache-Control'] = asset.startsWith('app/') ? 'no-store' : 'public, no-transform';
      headers['Content-Type'] = asset.endsWith('.html') ? 'text/html; charset=utf-8' : asset.endsWith('.js') ? 'text/javascript' : 'application/json';
      if (asset === 'app/index.html') {
        headers['Content-Security-Policy'] = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
        headers['X-Content-Type-Options'] = 'nosniff';
      }
    } else if (path === '/app') { status = 302; headers.Location = '/app/'; }
    else if (path === '/api/health') body = healthBody;
    else if (path === '/api/auth/get-session') body = 'null';
    else if (path.startsWith('/api/')) { status = 401; body = '{"code":"AUTH_REQUIRED"}'; }
    else status = 404;
    return new Response(body, { status, headers });
  };
  return { dist, files: Object.keys(data).filter((p) => p !== 'deployment.json'), expectedCommit: commit, fetchImpl };
}

test('verifier rejects explicitly unready health', async (t) => {
  const unready = JSON.stringify({ ok: true, auth_configured: true, ready: false, detail: { schema: false, oauth: false } });
  await assert.rejects(verifyLive(await verifierFixture(t, unready)), /not ready/);
});

test('verifier rejects health that omits readiness', async (t) => {
  const legacy = JSON.stringify({ ok: true, auth_configured: true, detail: { oauth: false } });
  await assert.rejects(verifyLive(await verifierFixture(t, legacy)), /not ready/);
});

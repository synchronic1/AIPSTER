import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyLive} from '../scripts/verify-live.mjs';

const commit = '1'.repeat(40);
async function fixture(t, mutate = () => {}) {
  const dist = await mkdtemp(join(tmpdir(), 'aipster-verifier-'));
  t.after(() => rm(dist, {recursive: true, force: true}));
  await mkdir(join(dist, 'app'));
  const data = {'index.html': '<title>Landing</title>', 'app/index.html': '<title>Sign in</title>',
    'app/app.js': '/* reviewed client */', 'release.json': '{}',
    'deployment.json': JSON.stringify({git_commit: commit, source_manifest_sha256: 'fixture'})};
  for (const [path, body] of Object.entries(data)) await writeFile(join(dist, path), body);
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'manual');
    const path = new URL(url).pathname;
    let status = 200, body, headers = {'Content-Type': 'application/json'};
    const asset = path === '/' ? 'index.html' : path === '/app/' ? 'app/index.html' : path.slice(1);
    if (asset in data) {
      body = data[asset]; headers['Cache-Control'] = asset.startsWith('app/') ? 'no-store' : 'public, no-transform';
      headers['Content-Type'] = asset.endsWith('.html') ? 'text/html; charset=utf-8' : asset.endsWith('.js') ? 'text/javascript' : 'application/json';
      if (asset === 'app/index.html') {
        headers['Content-Security-Policy'] = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
        headers['X-Content-Type-Options'] = 'nosniff';
      }
    } else if (path === '/app') { status = 302; headers.Location = '/app/'; }
    else if (path === '/api/health') body = JSON.stringify({ok: true, auth_configured: true, ready: true, detail: {oauth: false, schema: true}});
    else if (path === '/api/auth/get-session') body = 'null';
    else if (path.startsWith('/api/')) { status = 401; body = '{"code":"AUTH_REQUIRED"}'; }
    else status = 404;
    const reply = {status, body, headers}; mutate(path, reply);
    return new Response(reply.body, {status: reply.status, headers: reply.headers});
  };
  return {dist, files: Object.keys(data).filter(p => p !== 'deployment.json'), expectedCommit: commit, fetchImpl};
}
test('verifier accepts app routing/cache contract and states evidence limits', async t => {
  const result = await verifyLive(await fixture(t));
  assert.equal(result.git_commit, commit); assert.equal(result.oauth_configured, false);
  assert.equal(result.inference_verified, false); assert(result.pending.includes('two-identity isolation'));
});
for (const [name, mutate] of [
  ['unprotected inventory', (p, r) => { if (p === '/api/inventory') r.status = 200; }],
  ['missing auth configuration', (p, r) => { if (p === '/api/health') r.body = '{"ok":true,"auth_configured":false}'; }],
  ['wrong release bytes', (p, r) => { if (p === '/deployment.json') r.body = '{}'; }],
  ['app cache regression', (p, r) => { if (p === '/app/app.js') r.headers['Cache-Control'] = 'public'; }],
  ['HTML MIME regression', (p, r) => { if (p === '/app/index.html') r.headers['Content-Type'] = 'application/json'; }],
  ['script MIME regression', (p, r) => { if (p === '/app/app.js') r.headers['Content-Type'] = 'text/plain'; }],
  ['permissive CSP', (p, r) => { if (p === '/app/index.html') r.headers['Content-Security-Policy'] += '; script-src *'; }],
  ['CSP override', (p, r) => { if (p === '/app/index.html') r.headers['Content-Security-Policy'] += '; script-src-elem *'; }],
  ['missing nosniff', (p, r) => { if (p === '/app/index.html') delete r.headers['X-Content-Type-Options']; }],
  ['cross-origin redirect', (p, r) => { if (p === '/app') r.headers.Location = 'https://attacker.invalid/app/'; }],
]) test(`verifier rejects ${name}`, async t => { await assert.rejects(verifyLive(await fixture(t, mutate))); });
test('verifier refuses a build from a different commit', async t => {
  const options = await fixture(t); options.expectedCommit = '2'.repeat(40);
  await assert.rejects(verifyLive(options), /expected commit/);
});
test('verifier waits out stale edge bytes within the propagation window', async t => {
  let stale = 2, sleeps = 0;
  const options = await fixture(t, (path, reply) => { if (path === '/app/app.js' && stale > 0) { stale--; reply.body = '/* previous release */'; } });
  const result = await verifyLive({...options, propagation: {attempts: 3, delayMs: 5}, sleep: async () => { sleeps++; }});
  assert.equal(result.verified, true);
  assert.equal(sleeps, 2);
});
test('verifier still rejects bytes that stay stale past the window', async t => {
  let sleeps = 0;
  const options = await fixture(t, (path, reply) => { if (path === '/app/app.js') reply.body = '/* previous release */'; });
  await assert.rejects(verifyLive({...options, propagation: {attempts: 3, delayMs: 5}, sleep: async () => { sleeps++; }}), /Live bytes differ: app\/app.js/);
  assert.equal(sleeps, 2);
});
test('verifier does not retry a wrong status or content type', async t => {
  let calls = 0;
  const options = await fixture(t, (path, reply) => { if (path === '/app/app.js') { calls++; reply.status = 404; } });
  await assert.rejects(verifyLive({...options, propagation: {attempts: 5, delayMs: 5}, sleep: async () => {}}), /Expected HTTPS 200/);
  assert.equal(calls, 1);
});
test('the propagation budget is shared across assets, not per asset', async t => {
  let sleeps = 0;
  const options = await fixture(t, (path, reply) => { if (path === '/' || path === '/app/app.js') reply.body = '/* previous release */'; });
  await assert.rejects(verifyLive({...options, propagation: {attempts: 3, delayMs: 5}, sleep: async () => { sleeps++; }}), /Live bytes differ/);
  assert.equal(sleeps, 2, 'two retries total across every stale asset');
});
test('a malformed propagation option falls back to a single attempt', async t => {
  let sleeps = 0;
  const options = await fixture(t, (path, reply) => { if (path === '/app/app.js') reply.body = '/* previous release */'; });
  await assert.rejects(verifyLive({...options, propagation: {attempts: 'x', delayMs: -1}, sleep: async () => { sleeps++; }}), /Live bytes differ/);
  assert.equal(sleeps, 0);
});

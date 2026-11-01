// Usage (from website/): node scripts/e2e-python-worker.mjs <repo-root> [ganglion|llama-server]
// Cross-language end-to-end: real worker.js + real L1 D1 store (in-memory shim)
// served over loopback HTTP, driven by the REAL Python local worker
// (pairing.py pair / heartbeat-once / serve-jobs --once) against a fake
// upstream (no live inference, no network beyond 127.0.0.1).
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.argv[2];
const RUNTIME = process.argv[3] || 'ganglion';
const { createTestEnv, readJson } = await import(pathToFileURL(join(REPO, 'website/tests/d1-shim.mjs')).href);
const MODEL = 'qwen3.8-27b-atx-iq4_xs';
const t = await createTestEnv({ INFERENCE_ENABLED: '1', INFERENCE_OWNER_DAILY_TOKENS: '8192' });
const S = { ...t.as(t.alice), ...t.csrf };

// Loopback proxy into the worker fetch handler.
const api = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!['host', 'content-length', 'connection'].includes(k)) headers[k] = v;
  const init = { method: req.method, headers };
  if (chunks.length) init.body = Buffer.concat(chunks);
  const out = await (await import(pathToFileURL(join(REPO, 'website/src/worker.js')).href)).default
    .fetch(new Request('https://aipster.test' + req.url, init), t.env);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
});
// Fake upstream (Ganglion or llama-server shape).
const calls = [];
const up = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  calls.push({ method: req.method, url: req.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/models') return res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
  if (req.url === '/v1/completions') return res.end(JSON.stringify({ id: 'cmpl-1', object: 'text_completion', model: MODEL,
    choices: [{ index: 0, text: 'hello from fake upstream', finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } }));
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
await new Promise((r) => up.listen(0, '127.0.0.1', r));
const API = `http://127.0.0.1:${api.address().port}`, UP = `http://127.0.0.1:${up.address().port}`;
const data = mkdtempSync(join(tmpdir(), 'aipster-e2e-'));
const py = (args) => {
  const r = spawnSync('python', [join(REPO, 'local-worker/pairing.py'), '--api-base', API, '--data-dir', data, ...args],
    { encoding: 'utf8', timeout: 60000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const step = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`); if (!ok) process.exitCode = 1; };
// pairing.py runs blocking in spawnSync; serve the API from a child loop instead.
// spawnSync blocks the event loop, so use async spawn via a promise.
import { spawn } from 'node:child_process';
const pyAsync = (args) => new Promise((resolve) => {
  const p = spawn('python', [join(REPO, 'local-worker/pairing.py'), '--api-base', API, '--data-dir', data, ...args],
    { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  let out = ''; p.stdout.on('data', (d) => out += d); p.stderr.on('data', (d) => out += d);
  const timer = setTimeout(() => p.kill(), 90000);
  p.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
});

try {
  const mint = await readJson(await t.call('/api/pairing/codes', { method: 'POST', headers: S, body: {} }));
  step('mint pairing code', mint.status === 201, String(mint.status));
  const pair = await pyAsync(['pair', '--code', mint.json.code]);
  step('python pair', pair.code === 0, `exit ${pair.code}`);
  const beat = await pyAsync(['heartbeat-once']);
  step('python heartbeat-once', beat.code === 0, `exit ${beat.code}`);
  const inv = await readJson(await t.call('/api/inventory', { headers: S }));
  const resourceId = inv.json.items[0].id;
  const adm = await readJson(await t.call('/api/inference/admissions', { method: 'POST', headers: S,
    body: { resource_id: resourceId, model_id: MODEL, max_tokens: 32, runtime_id: RUNTIME } }));
  step('admission', adm.status === 201, adm.text.slice(0, 160));
  const key = 'alice-pye2e-00000001';
  const sub = await readJson(await t.call('/api/jobs', { method: 'POST', headers: S, body: { contract_version: 'v1.0.0',
    admission_ref: adm.json.admission_ref, idempotency_key: key, model_id: MODEL, prompt: 'Say hello', max_tokens: 32,
    deadline_at: Date.now() + 120000 } }));
  step('submit', sub.status === 202 && sub.json.status === 'dispatched', sub.text.slice(0, 160));
  const serve = await pyAsync(['serve-jobs', '--once', '--upstream-url', UP, '--runtime-id', RUNTIME, '--interval', '0.05']);
  step('python serve-jobs --once', serve.code === 0, `exit ${serve.code} ${serve.out.replace(/\s+/g, ' ').slice(0, 240)}`);
  const comp = calls.filter((c) => c.url === '/v1/completions');
  step('exactly one upstream completion', comp.length === 1, JSON.stringify(comp.map((c) => ({ model: c.body.model, max_tokens: c.body.max_tokens, temperature: c.body.temperature, stream: c.body.stream }))));
  const done = await readJson(await t.call(`/api/jobs/${key}`, { headers: S }));
  step('reconcile settles with content', done.status === 200 && done.json.outcome?.content === 'hello from fake upstream',
    done.text.slice(0, 300));
  step('provenance runtime', done.json.outcome?.provenance?.runtime_id === RUNTIME && done.json.outcome?.provenance?.simulated === false,
    JSON.stringify(done.json.outcome?.provenance));
  const again = await pyAsync(['serve-jobs', '--once', '--upstream-url', UP, '--runtime-id', RUNTIME, '--interval', '0.05']);
  step('second serve-jobs finds nothing, no re-execution', again.code === 0 && calls.filter((c) => c.url === '/v1/completions').length === 1, `exit ${again.code}`);
  step('no secret in worker output', ![pair.out, beat.out, serve.out].some((o) => /ak_|sk_|Bearer /.test(o)));
} finally {
  api.close(); up.close(); rmSync(data, { recursive: true, force: true });
}

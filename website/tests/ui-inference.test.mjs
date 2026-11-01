/* W2: control-panel inference runner.
 *
 * Runs the exact checked-in client against real local handlers (auth,
 * inventory, GET /api/status) and mocked inference endpoints, using the same
 * minimal-DOM harness as ui-session/ui-models. What is proven here:
 *  - the panel exists only when GET /api/status reports features.inference
 *    (false when INFERENCE_ENABLED is unset, so nothing renders);
 *  - admission -> job (client idempotency key, deadline) -> reconcile polling;
 *  - model output renders inert (escaped text, never a live element);
 *  - a transport-error retry reuses the SAME idempotency key and body;
 *  - leaving the tab stops polling;
 *  - stable server error codes reach the panel;
 *  - pre-start cancel calls POST /api/jobs/:key/cancel.
 */
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as deadline, clearTimeout as cancelDeadline } from 'node:timers';
import { parse } from 'parse5';
import { createTestEnv, readJson } from './d1-shim.mjs';

const APP_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app', 'app.js');
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const PROVENANCE = { runtime_id: 'ganglion', model_id: 'fixture-model', runtime_instance: 'node-a#ganglion', simulated: false };

async function makeUi({ inference = false, handlers = [] } = {}) {
  const source = await readFile(APP_JS, 'utf8');
  const t = await createTestEnv(inference ? { INFERENCE_ENABLED: '1' } : {});
  const elements = new Map();
  const observers = new Set();
  function el(id) {
    if (!elements.has(id)) {
      const element = {
        id, hidden: false, value: '', attrs: {}, listeners: {}, dataset: {},
        addEventListener(type, fn) { this.listeners[type] = fn; },
        setAttribute(name, value) { this.attrs[name] = value; },
        querySelectorAll() { return []; },
      };
      let html = '';
      let text = '';
      const notify = () => { for (const fn of [...observers]) fn(); };
      Object.defineProperty(element, 'innerHTML', {
        configurable: true, enumerable: true,
        get() { return html; }, set(v) { html = v; notify(); },
      });
      Object.defineProperty(element, 'textContent', {
        configurable: true, enumerable: true,
        get() { return text; }, set(v) { text = v; notify(); },
      });
      elements.set(id, element);
    }
    return elements.get(id);
  }
  const names = ['overview', 'compute', 'shared', 'sharing', 'models', 'federation', 'keys', 'usage', 'advice', 'settings'];
  const tabs = names.map((name) => { const e = el('nav-' + name); e.dataset.tab = name; e.attrs['aria-selected'] = name === 'overview' ? 'true' : 'false'; return e; });
  names.forEach((name) => { el('tab-' + name).hidden = name !== 'overview'; });
  // Mirror public/app/index.html's initial hidden state.
  for (const id of ['view-app', 'sessionbar', 'inference-panel', 'inf-cancel', 'inf-retry', 'inf-error', 'banner']) el(id).hidden = true;
  el('view-login').hidden = false;

  const calls = [];
  const timers = [];
  const fetchImpl = async (fetchPath, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push(`${method} ${fetchPath}`);
    let body = null;
    if (opts.body) { try { body = JSON.parse(opts.body); } catch { body = opts.body; } }
    const req = { path: fetchPath, method, body, headers: opts.headers || {} };
    for (const handler of handlers) {
      const res = await handler(req);
      if (res) return res;
    }
    return t.call(fetchPath, { method, headers: { Cookie: t.as(t.alice).Cookie, Origin: 'http://localhost:8787', ...opts.headers }, body: opts.body });
  };
  const context = vm.createContext({
    document: {
      getElementById: el,
      querySelectorAll(sel) { return sel === '[data-tab]' ? tabs : sel === '[role="tabpanel"]' ? names.map((n) => el('tab-' + n)) : []; },
    },
    location: { origin: 'http://localhost:8787', pathname: '/app/', search: '' },
    fetch: fetchImpl,
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    console, URLSearchParams, crypto,
    history: { replaceState() {} },
  });
  await new vm.Script(source, { filename: 'exact-client.js' }).runInContext(context);
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
  await flush();
  const clickTab = async (name) => { tabs.find((e) => e.dataset.tab === name).listeners.click(); await flush(); };
  const waitForDOM = (read, message) => new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { observers.delete(check); cancelDeadline(timer); };
    const check = () => {
      try { const value = read(); if (value) { cleanup(); resolve(value); } }
      catch (error) { cleanup(); reject(error); }
    };
    observers.add(check);
    timer = deadline(() => { cleanup(); reject(new assert.AssertionError({ message })); }, 10000);
    check();
  });
  // Drains short delays only: the Overview status strip re-arms at 30 s and
  // must not be driven by inference polling tests.
  const runTimers = async (maxMs = 5000) => {
    for (let i = 0; i < 80; i++) {
      const at = timers.findIndex((x) => x.ms <= maxMs);
      if (at < 0) return;
      const [next] = timers.splice(at, 1);
      next.fn();
      await flush();
    }
    throw new Error('timer queue never settled');
  };
  const reachable = async (name = 'dash-box') => {
    const out = await readJson(await t.call('/api/inventory', {
      method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name, kind: 'local' },
    }));
    assert.equal(out.status, 201, out.text);
    await t.DB.prepare('UPDATE resources SET configured = 1, authenticated = 1, online = 1, usable = 1, heartbeat_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), out.json.id).run();
    return out.json;
  };
  return { t, el, calls, clickTab, flush, waitForDOM, runTimers, reachable };
}

function nodesOf(html) {
  const nodes = [];
  (function visit(n) { nodes.push(n); for (const c of n.childNodes || []) visit(c); })(parse(`<!doctype html><body>${html}</body>`));
  return nodes;
}
const textOf = (html) => nodesOf(html).filter((n) => n.nodeName === '#text').map((n) => n.value).join('').replace(/\s+/g, ' ');
const nodeNamed = (html, tag) => nodesOf(html).filter((n) => n.tagName === tag);

const admission = (body, over = {}) => Response.json({
  admission_ref: 'adm_0123456789abcdef', expires_at: Date.now() + 10 * 60 * 1000,
  model_id: body.model_id, max_tokens: body.max_tokens, ...over,
}, { status: 201 });
const dispatched = () => Response.json({ status: 'dispatched', op_id: 'op_1', job_id: 'job_1', remote_stopped: false, automatic_retry: false }, { status: 202 });
const settled = (content = 'hello from the worker', over = {}) => Response.json({
  status: 'settled', op_id: 'op_1', job_id: 'job_1', remote_stopped: false, automatic_retry: false,
  outcome: { finish: 'succeeded', released: true, content, provenance: PROVENANCE, ...over },
}, { status: 200 });

async function openPanel(ui) {
  const resource = await ui.reachable();
  await ui.clickTab('compute');
  await ui.waitForDOM(() => ui.el('inference-panel').hidden === false, 'inference panel never rendered');
  await ui.waitForDOM(() => ui.el('inf-resource').innerHTML.includes(resource.id), 'reachable resource never listed');
  return resource;
}

function fillRun(ui, resource, over = {}) {
  ui.el('inf-resource').value = resource.id;
  ui.el('inf-model').value = over.model || 'fixture-model';
  ui.el('inf-max-tokens').value = String(over.maxTokens || 64);
  ui.el('inf-prompt').value = over.prompt || 'Reply with exactly: hello';
}

const runOnce = async (ui) => { await ui.el('inference-form').listeners.submit({ preventDefault() {} }); await ui.flush(); };

// ---- feature signal (the field the UI gates on) ----
test('status reports features.inference false when the flag is off', async () => {
  const t = await createTestEnv();
  const out = await readJson(await t.call('/api/status', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200, out.text);
  assert.deepEqual(out.json.features, { inference: false });
});

test('status reports features.inference true when the flag is on', async () => {
  const t = await createTestEnv({ INFERENCE_ENABLED: '1' });
  const anonymous = await readJson(await t.call('/api/status'));
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.code, 'AUTH_REQUIRED');
  const out = await readJson(await t.call('/api/status', { headers: t.as(t.alice) }));
  assert.equal(out.status, 200, out.text);
  assert.deepEqual(out.json.features, { inference: true });
});

// ---- feature exposure ----
test('flag off: My Compute renders exactly as before, with no inference panel', async () => {
  const ui = await makeUi({ inference: false });
  await ui.reachable();
  await ui.clickTab('compute');
  await ui.waitForDOM(() => ui.el('compute-list').innerHTML.includes('dash-box'), 'inventory never rendered');
  assert.equal(ui.el('inference-panel').hidden, true, 'no inference controls without the server signal');
  assert.ok(ui.calls.includes('GET /api/status'), 'the flag comes from the status read the app already makes');
  assert.ok(!ui.calls.some((c) => c.includes('/api/inference/')), 'flag off adds no inference request');
});

test('flag on: My Compute renders the run panel with only reachable resources', async () => {
  const ui = await makeUi({ inference: true });
  const resource = await openPanel(ui);
  assert.equal(ui.el('inference-panel').hidden, false);
  assert.ok(ui.el('inf-resource').innerHTML.includes(resource.id), 'reachable resource offered');
  assert.ok(ui.el('inf-note').textContent.includes('Reachability only'), 'reachability is not claimed as readiness');
  assert.equal(ui.el('inf-run').disabled, false);
});

test('a dropped status read is re-checked once on entry, and failures stay hidden', async () => {
  // The startup status read is fenced by the tab switch; the panel must not
  // depend on that one request winning. One direct re-read settles the flag.
  let reads = 0;
  const ui = await makeUi({
    inference: true,
    handlers: [async (r) => {
      if (r.method === 'GET' && r.path === '/api/status' && ++reads === 1) {
        return Response.json({ error: 'unavailable' }, { status: 503 });
      }
      return null;
    }],
  });
  const resource = await openPanel(ui);
  assert.ok(ui.el('inf-resource').innerHTML.includes(resource.id));
  assert.equal(reads, 2, 'exactly one re-read, not a probe per render');

  // Every status read failing is indistinguishable from "not enabled" here:
  // the controls never appear.
  const dark = await makeUi({
    inference: true,
    handlers: [async (r) => {
      if (r.method === 'GET' && r.path === '/api/status') return Response.json({ error: 'unavailable' }, { status: 503 });
      return null;
    }],
  });
  await dark.reachable();
  await dark.clickTab('compute');
  await dark.waitForDOM(() => dark.el('compute-list').innerHTML.includes('dash-box'), 'inventory never rendered');
  assert.equal(dark.el('inference-panel').hidden, true, 'unknown feature state fails closed');
});

// ---- happy path ----
test('run once: admission, job with client key and deadline, reconcile settles safely', async () => {
  const seen = [];
  const ui = await makeUi({
    inference: true,
    handlers: [async (r) => {
      if (r.method === 'POST' && r.path === '/api/inference/admissions') { seen.push(r); return admission(r.body); }
      if (r.method === 'POST' && r.path === '/api/jobs') { seen.push(r); return dispatched(); }
      if (r.method === 'GET' && /^\/api\/jobs\/[^/]+$/.test(r.path)) { seen.push(r); return settled(); }
      return null;
    }],
  });
  const resource = await openPanel(ui);
  const before = Date.now();
  fillRun(ui, resource);
  await runOnce(ui);
  await ui.waitForDOM(() => ui.el('inf-result').innerHTML.includes('hello from the worker'), 'settled content never rendered');

  const admit = seen.find((r) => r.path === '/api/inference/admissions');
  assert.deepEqual(admit.body, { resource_id: resource.id, model_id: 'fixture-model', max_tokens: 64 });
  const job = seen.find((r) => r.method === 'POST' && r.path === '/api/jobs');
  assert.equal(job.body.contract_version, 'v1.0.0');
  assert.equal(job.body.admission_ref, 'adm_0123456789abcdef');
  assert.match(job.body.idempotency_key, KEY_RE, 'client key matches the server regex');
  assert.equal(job.body.idempotency_key.length, 36, '128-bit random key');
  assert.equal(job.body.model_id, 'fixture-model');
  assert.equal(job.body.prompt, 'Reply with exactly: hello');
  assert.equal(job.body.max_tokens, 64);
  assert.ok(job.body.deadline_at > before && job.body.deadline_at <= before + 120000 + 1000, 'deadline is now + 120 s');
  for (const forged of ['principal_id', 'tenant_id', 'placement', 'runtime_id', 'grant_id']) {
    assert.ok(!(forged in job.body), `no client-asserted authority field: ${forged}`);
  }
  const poll = seen.find((r) => r.method === 'GET' && r.path.startsWith('/api/jobs/'));
  assert.equal(poll.path, '/api/jobs/' + job.body.idempotency_key, 'reconcile uses the same key');

  const html = ui.el('inf-result').innerHTML;
  const text = textOf(html);
  assert.ok(text.includes('hello from the worker'));
  assert.ok(text.includes('succeeded'), 'finish is a text label');
  assert.ok(text.includes('runtime: ganglion'), 'provenance runtime_id');
  assert.ok(text.includes('model: fixture-model'), 'provenance model_id');
  assert.ok(text.includes('simulated: false'), 'provenance proves a real result');
  assert.equal(ui.el('inf-error').hidden, true, 'no error on the happy path');
  assert.equal(ui.el('inf-cancel').hidden, true, 'cancel is gone once settled');
});

test('model output is escaped: a script tag in content stays text', async () => {
  const payload = '</pre><script>alert(1)</script><img src=x onerror=alert(2)>';
  const ui = await makeUi({
    inference: true,
    handlers: [async (r) => {
      if (r.method === 'POST' && r.path === '/api/inference/admissions') return admission(r.body);
      if (r.method === 'POST' && r.path === '/api/jobs') return dispatched();
      if (r.method === 'GET' && r.path.startsWith('/api/jobs/')) return settled(payload);
      return null;
    }],
  });
  const resource = await openPanel(ui);
  fillRun(ui, resource);
  await runOnce(ui);
  await ui.waitForDOM(() => ui.el('inf-result').innerHTML.length > 0, 'result never rendered');
  const html = ui.el('inf-result').innerHTML;
  assert.ok(html.includes('&lt;script&gt;'), 'script tag is entity-escaped');
  assert.equal(nodeNamed(html, 'script').length, 0, 'no live script element');
  assert.equal(nodeNamed(html, 'img').length, 0, 'no live img element');
  assert.equal(nodesOf(html).filter((n) => (n.attrs || []).some((a) => /^on/i.test(a.name))).length, 0, 'no event handler attributes');
  assert.ok(textOf(html).includes('<script>alert(1)</script>'), 'the text is still visible, just inert');
});

// ---- retry / idempotency ----
test('a retry after a transport error reuses the same key and body', async () => {
  const jobBodies = [];
  const ui = await makeUi({
    inference: true,
    handlers: [async (r) => {
      if (r.method === 'POST' && r.path === '/api/inference/admissions') return admission(r.body);
      if (r.method === 'POST' && r.path === '/api/jobs') {
        jobBodies.push(r.body);
        if (jobBodies.length === 1) throw new Error('network down');
        return dispatched();
      }
      if (r.method === 'GET' && r.path.startsWith('/api/jobs/')) return settled('retried once');
      return null;
    }],
  });
  const resource = await openPanel(ui);
  fillRun(ui, resource);
  await runOnce(ui);
  await ui.waitForDOM(() => ui.el('inf-error').hidden === false, 'transport error never surfaced');
  assert.ok(ui.el('inf-error').textContent.includes('network down'), ui.el('inf-error').textContent);
  assert.equal(ui.el('inf-retry').hidden, false, 'retry is offered');
  // Click retry (not Run once) so no new admission or key is minted.
  const admBefore = ui.calls.filter((c) => c === 'POST /api/inference/admissions').length;
  ui.el('inf-retry').listeners.click();
  await ui.flush();
  await ui.waitForDOM(() => ui.el('inf-result').innerHTML.includes('retried once'), 'retry never settled');
  assert.equal(jobBodies.length, 2, 'two job submissions');
  assert.equal(ui.calls.filter((c) => c === 'POST /api/inference/admissions').length, admBefore, 'retry minted no new admission');
  assert.match(jobBodies[0].idempotency_key, KEY_RE);
  assert.deepEqual(jobBodies[1], jobBodies[0], 'the retry reused the identical key and body');
  const polls = ui.calls.filter((c) => c.startsWith('GET /api/jobs/'));
  assert.ok(polls.length > 0 && polls.every((p) => p.endsWith(jobBodies[0].idempotency_key)), 'every poll uses the same key');
});

// ---- polling lifetime ----
test('leaving the tab stops polling and renders no late result', async () => {
  let gets = 0;
  const ui = await makeUi({
    inference: true,
    handlers: [async (r) => {
      if (r.method === 'POST' && r.path === '/api/inference/admissions') return admission(r.body);
      if (r.method === 'POST' && r.path === '/api/jobs') return dispatched();
      if (r.method === 'GET' && r.path.startsWith('/api/jobs/')) { gets++; return dispatched(); }
      return null;
    }],
  });
  const resource = await openPanel(ui);
  fillRun(ui, resource);
  await runOnce(ui);
  await ui.waitForDOM(() => ui.el('inf-status').textContent.includes('Waiting'), 'poll never reported waiting');
  assert.equal(gets, 1, 'the first reconcile ran immediately');
  await ui.clickTab('overview');
  const callsAtLeave = ui.calls.length;
  await ui.runTimers();
  assert.equal(gets, 1, 'leaving the tab stopped the scheduled poll');
  assert.equal(ui.calls.length, callsAtLeave, 'no further inference request after leaving');
  assert.equal(ui.el('inf-result').innerHTML, '', 'no late result rendered');
});

// ---- stable error codes ----
async function errorRun(handlers) {
  const ui = await makeUi({ inference: true, handlers });
  const resource = await openPanel(ui);
  fillRun(ui, resource);
  await runOnce(ui);
  await ui.waitForDOM(() => ui.el('inf-error').hidden === false, 'error never surfaced');
  return { ui, text: ui.el('inf-error').textContent };
}

test('stable error codes are shown verbatim', async () => {
  const cases = [
    ['DISPATCH_LIMIT', async (r) => r.method === 'POST' && r.path === '/api/inference/admissions'
      ? Response.json({ error: 'Too many live operations.', code: 'DISPATCH_LIMIT' }, { status: 429 }) : null],
    ['BAD_RUNTIME', async (r) => r.method === 'POST' && r.path === '/api/inference/admissions'
      ? Response.json({ error: 'runtime_id must be ganglion or llama-server.', code: 'BAD_RUNTIME' }, { status: 400 }) : null],
    ['GRANT_QUOTA_EXHAUSTED', async (r) => r.method === 'POST' && r.path === '/api/inference/admissions'
      ? Response.json({ error: 'Grant capacity is exhausted.', code: 'GRANT_QUOTA_EXHAUSTED' }, { status: 429 }) : null],
    ['MODEL_NOT_ADVERTISED', async (r) => {
      if (r.method === 'POST' && r.path === '/api/inference/admissions') return admission(r.body);
      if (r.method === 'POST' && r.path === '/api/jobs') return Response.json({ error: 'The worker does not advertise this model.', code: 'MODEL_NOT_ADVERTISED' }, { status: 400 });
      return null;
    }],
    ['INFERENCE_DISABLED', async (r) => {
      if (r.method === 'POST' && r.path === '/api/inference/admissions') return admission(r.body);
      if (r.method === 'POST' && r.path === '/api/jobs') return Response.json({ error: 'Inference dispatch is disabled.', code: 'INFERENCE_DISABLED' }, { status: 501 });
      return null;
    }],
  ];
  for (const [code, handler] of cases) {
    const { ui, text } = await errorRun([handler]);
    assert.ok(text.includes(code), `${code} shown, got: ${text}`);
    assert.ok(ui.el('inf-error').textContent.length > code.length, `${code} carries explanatory copy`);
    assert.equal(ui.el('inf-result').innerHTML, '', `${code} never renders a fake result`);
  }
});

test('budget exhaustion copy names the budget and keeps the code', async () => {
  const { text } = await errorRun([async (r) => r.method === 'POST' && r.path === '/api/inference/admissions'
    ? Response.json({ error: 'Grant capacity is exhausted for this request.', code: 'GRANT_QUOTA_EXHAUSTED' }, { status: 429 }) : null]);
  assert.ok(text.includes('GRANT_QUOTA_EXHAUSTED'));
  assert.ok(/budget/i.test(text), text);
});

// ---- cancellation ----
test('pre-start cancel posts to the job cancel route and stops polling', async () => {
  let cancelled = null;
  let gets = 0;
  const ui = await makeUi({
    inference: true,
    handlers: [async (r) => {
      if (r.method === 'POST' && r.path === '/api/inference/admissions') return admission(r.body);
      if (r.method === 'POST' && r.path === '/api/jobs') return dispatched();
      if (r.method === 'POST' && /\/cancel$/.test(r.path)) { cancelled = r.path; return Response.json({ status: 'cancelled_before_start', code: 'CANCELLED', op_id: 'op_1' }, { status: 200 }); }
      if (r.method === 'GET' && r.path.startsWith('/api/jobs/')) { gets++; return dispatched(); }
      return null;
    }],
  });
  const resource = await openPanel(ui);
  fillRun(ui, resource);
  await runOnce(ui);
  await ui.waitForDOM(() => ui.el('inf-status').textContent.includes('Waiting'), 'poll never started');
  assert.equal(ui.el('inf-cancel').hidden, false, 'cancel is offered before start');
  ui.el('inf-cancel').listeners.click();
  await ui.flush();
  await ui.waitForDOM(() => ui.el('inf-status').textContent.includes('Cancelled'), 'cancel never acknowledged');
  assert.match(cancelled, /^\/api\/jobs\/[A-Za-z0-9][A-Za-z0-9._:-]{7,127}\/cancel$/, 'cancel addressed the same key');
  const at = gets;
  await ui.runTimers();
  assert.equal(gets, at, 'cancel stopped the poll');
});

/* Built with Meta Muse. */
// Models tab UI (Phase 1): runs the exact checked-in client against real
// local handlers in fixture mode (same minimal-DOM pattern as
// ui-connect-card). Covers AC04 (hostile cards render inert), blocked/
// unknown/compatible decision states with text labels, empty/error states,
// the Overview card, demo restrictions, stale-generation drops, and AC22
// announcements/focus affordances.
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as deadline, clearTimeout as cancelDeadline } from 'node:timers';
import { parse } from 'parse5';
import { hashPassword } from 'better-auth/crypto';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { fixtureSnapshot } from '../src/lib/catalog/fixtures.mjs';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SECRET_SHAPED = /aip_[a-z0-9_]{8,}|gh[pousr]_|sk-[\w]{8,}|token=|secret=|key=|[?&](?:code|auth)=/i;

async function makeUi({ asDemo = false, failPaths = [] } = {}) {
  const source = await readFile(path.join(PUBLIC, 'app', 'app.js'), 'utf8');
  const t = await createTestEnv({ CATALOG_FIXTURES: '1' });
  const elements = new Map();
  const domObservers = new Set();
  function el(id) {
    if (!elements.has(id)) {
      const element = {
        id, hidden: false, textContent: '', value: '', attrs: {}, listeners: {}, dataset: {},
        addEventListener(type, fn) { this.listeners[type] = fn; },
        setAttribute(name, value) { this.attrs[name] = value; },
        querySelectorAll() { return []; },
      };
      let html = '';
      Object.defineProperty(element, 'innerHTML', {
        configurable: true, enumerable: true,
        get() { return html; },
        set(value) { html = value; for (const notify of [...domObservers]) notify(); },
      });
      elements.set(id, element);
    }
    return elements.get(id);
  }
  const names = ['overview', 'compute', 'shared', 'sharing', 'models', 'federation', 'keys', 'usage', 'settings'];
  const tabs = names.map((name) => { const e = el('nav-' + name); e.dataset.tab = name; return e; });
  names.forEach((name) => { el('tab-' + name).hidden = name !== 'overview'; });
  for (const id of ['view-app', 'sessionbar']) el(id).hidden = true;
  let cookie = t.as(t.alice).Cookie;
  let demoUser = null;
  if (asDemo) {
    const now = new Date().toISOString();
    await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, username, displayUsername, demo, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('u_demo_models', 'Demo', 'demomodels@example.com', 0, null, 'demomodels', 'demomodels', 1, now, now).run();
    const hash = await hashPassword('demo-models-password-01');
    await t.DB.prepare('INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('acc_demo_models', 'u_demo_models', 'credential', 'u_demo_models', hash, now, now).run();
    const res = await t.call('/api/auth/sign-in/username', { method: 'POST', body: { username: 'demomodels', password: 'demo-models-password-01' } });
    assert.equal(res.status, 200, (await readJson(res)).text);
    cookie = res.headers.getSetCookie().find((c) => c.startsWith('better-auth.session_token=')).split(';')[0];
    demoUser = { id: 'u_demo_models' };
  }
  const calls = [];
  const fetchImpl = async (fetchPath, opts = {}) => {
    calls.push(`${opts.method ?? 'GET'} ${fetchPath}`);
    if (failPaths.some((p) => fetchPath.startsWith(p))) {
      return new Response(JSON.stringify({ error: 'injected failure' }), { status: 500 });
    }
    return t.call(fetchPath, { method: opts.method ?? 'GET', headers: { Cookie: cookie, Origin: 'http://localhost:8787', ...opts.headers }, body: opts.body });
  };
  const logs = [];
  const globals = {
    document: { getElementById: el, querySelectorAll(sel) { return sel === '[data-tab]' ? tabs : sel === '[role="tabpanel"]' ? names.map((n) => el('tab-' + n)) : []; } },
    location: { origin: 'http://localhost:8787', pathname: '/app/', search: '' }, fetch: fetchImpl, setTimeout() { return 0; },
    console: { log: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a), info: (...a) => logs.push(a) },
    URLSearchParams, history: { replaceState() {} },
  };
  const context = vm.createContext(globals);
  await new vm.Script(source, { filename: 'exact-client.js' }).runInContext(context);
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
  await flush();
  const clickTab = async (name) => { tabs.find((e) => e.dataset.tab === name).listeners.click(); await flush(); };
  const waitForDOM = (read, message) => new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { domObservers.delete(check); cancelDeadline(timer); };
    const check = () => {
      try {
        const value = read();
        if (value) { cleanup(); resolve(value); }
      } catch (error) { cleanup(); reject(error); }
    };
    domObservers.add(check);
    timer = deadline(() => { cleanup(); reject(new assert.AssertionError({ message })); }, 10000);
    check();
  });
  return { t, el, calls, logs, clickTab, flush, waitForDOM, demoUser };
}

function nodesOf(html) {
  const out = [];
  (function visit(n) { out.push(n); for (const c of n.childNodes || []) visit(c); })(parse(`<!doctype html><body>${html}</body>`));
  return out;
}
const textOf = (html) => nodesOf(html).filter((n) => n.nodeName === '#text').map((n) => n.value).join('').replace(/\s+/g, ' ');
const attr = (n, name) => ((n.attrs || []).find((x) => x.name === name) || {}).value;

async function registerResource(ui, name) {
  const res = await readJson(await ui.t.call('/api/inventory', {
    method: 'POST', headers: { ...ui.t.as(ui.t.alice), ...ui.t.csrf }, body: { name, kind: 'local' },
  }));
  assert.equal(res.status, 201, res.text);
  return res.json;
}

async function openDetail(ui, repo, wired = true) {
  await ui.clickTab('models');
  await ui.waitForDOM(() => ui.el('catalog-list').innerHTML.includes(repo), 'search never listed ' + repo);
  ui.el('catalog-list').onclick({ target: { dataset: { asset: repo } } });
  await ui.waitForDOM(() => ui.el('asset-detail').innerHTML.includes('Model card'), 'detail never rendered for ' + repo);
  if (wired) {
    // The client wires the compat submit after its node inventory
    // resolves; no DOM mutation marks that, so poll the listener map.
    for (let i = 0; i < 200; i++) {
      if (ui.el('compat-form').listeners.submit) return;
      await new Promise(setImmediate);
    }
    assert.fail('compat form never wired for ' + repo);
  }
}

test('Models tab lists fixtures labeled DEMO DATA with honest states', async () => {
  const ui = await makeUi();
  await ui.clickTab('models');
  await ui.waitForDOM(() => ui.el('catalog-list').innerHTML.includes('fixture-org/tiny-instruct-gguf'), 'search never rendered');
  const html = ui.el('catalog-list').innerHTML;
  assert.ok(html.includes('fixture-org/tiny-base'), 'all fixtures listed');
  assert.ok(html.includes('fixture-org/gated-clinical'), 'gated fixture listed with its gate label');
  assert.ok(html.includes('gated access'), 'gate is explicit');
  assert.ok(textOf(html).includes('DEMO'), 'fixture rows carry the DEMO marker');
  assert.ok(ui.el('catalog-meta').textContent.includes('DEMO DATA'), 'meta announces fixture provenance');
  assert.ok(!SECRET_SHAPED.test(html), 'no secret-shaped content in results');
  const links = nodesOf(html).filter((n) => n.tagName === 'a');
  assert.ok(links.length > 0, 'Hub links render');
  for (const a of links) {
    assert.equal(attr(a, 'target'), '_blank');
    assert.equal(attr(a, 'rel'), 'noopener');
    assert.ok(attr(a, 'href').startsWith('https://huggingface.co/fixture-org/'));
  }
  assert.ok(textOf(html).includes('(external)'), 'off-site links are marked external');
});

test('AC04: hostile model-card markup and instructions render inert', async () => {
  const ui = await makeUi();
  await openDetail(ui, 'fixture-org/gated-clinical');
  const html = ui.el('asset-detail').innerHTML;
  assert.ok(html.includes('&lt;img'), 'markup is entity-escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'script tags are entity-escaped');
  assert.ok(!/<img[\s>]/.test(html), 'no live img element from the card');
  assert.ok(!/<script[\s>]/.test(html), 'no live script element from the card');
  const nodes = nodesOf(html);
  assert.ok(!nodes.some((n) => n.tagName === 'img'), 'parsed DOM has no card-driven img');
  assert.ok(!nodes.some((n) => n.tagName === 'script'), 'parsed DOM has no card-driven script');
  assert.ok(textOf(html).includes('ignore previous instructions'), 'instruction text is visible but inert');
  for (const n of nodes) {
    for (const a of n.attrs || []) assert.ok(!/^on/i.test(a.name), 'no card-driven event handler: ' + a.name);
  }
});

test('detail shows pinned revision, manifest, license evidence; compat unknown without telemetry', async () => {
  const ui = await makeUi();
  const node = await registerResource(ui, 'bare-box');
  await openDetail(ui, 'fixture-org/tiny-instruct-gguf');
  const html = ui.el('asset-detail').innerHTML;
  assert.ok(html.includes('ffffffffffff'), 'pinned revision prefix shown');
  assert.ok(html.includes('tiny-instruct-Q4_K_M.gguf'), 'manifest names files');
  assert.ok(html.includes('digest pending pinned resolve'), 'digests honestly pending');
  assert.ok(html.includes('apache-2.0'), 'license tag shown as evidence');
  ui.el('compat-node').value = node.id;
  ui.el('compat-runtime').value = 'fixture-llama';
  ui.el('compat-context').value = '2048';
  ui.el('compat-concurrency').value = '1';
  ui.el('compat-form').listeners.submit({ preventDefault() {} });
  await ui.waitForDOM(() => ui.el('compat-out').innerHTML.includes('Decision:'), 'compat never rendered');
  const out = ui.el('compat-out').innerHTML;
  assert.ok(textOf(out).includes('unknown'), 'no snapshot means unknown');
  assert.ok(out.includes('TELEMETRY_MISSING'), 'missing evidence is named');
  assert.ok(out.includes('Deploy (unavailable)'), 'deploy is an honestly disabled action');
  const deploy = nodesOf(out).find((n) => n.tagName === 'button' && textOf(out).includes('Deploy'));
  assert.ok(deploy && deploy.attrs.some((x) => x.name === 'disabled'), 'deploy button is disabled, not a fake success');
});

test('compat compatible path renders the estimate breakdown with method and uncertainty', async () => {
  const ui = await makeUi();
  const node = await registerResource(ui, 'big-box');
  const s = fixtureSnapshot();
  const now = new Date().toISOString();
  await ui.t.DB.prepare('INSERT INTO node_capabilities (node_id, schema_version, reported_at, os, arch, runtimes_json, mem_json, disk_json, workload_json) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)')
    .bind(node.id, now, s.os, s.arch, JSON.stringify(s.runtimes), JSON.stringify(s.mem), JSON.stringify(s.disk), JSON.stringify(s.workload)).run();
  await openDetail(ui, 'fixture-org/tiny-instruct-gguf');
  ui.el('compat-node').value = node.id;
  ui.el('compat-runtime').value = 'fixture-llama';
  ui.el('compat-context').value = '2048';
  ui.el('compat-concurrency').value = '1';
  ui.el('compat-form').listeners.submit({ preventDefault() {} });
  await ui.waitForDOM(() => ui.el('compat-out').innerHTML.includes('Decision:'), 'compat never rendered');
  const text = textOf(ui.el('compat-out').innerHTML);
  assert.ok(text.includes('estimated compatible'), 'text label, not color-only: ' + text);
  assert.ok(text.includes('KV cache'), 'breakdown names KV cache');
  assert.ok(text.includes('safety reserve'), 'breakdown names the reserve');
  assert.ok(text.includes('method:'), 'method is disclosed');
  assert.ok(!SECRET_SHAPED.test(ui.el('compat-out').innerHTML), 'no secret-shaped content in decisions');
});

test('empty and upstream-error search states are distinct and honest', async () => {
  const ui = await makeUi();
  await ui.clickTab('models');
  await ui.waitForDOM(() => ui.el('catalog-list').innerHTML.includes('fixture-org/'), 'initial search never rendered');
  ui.el('cat-q').value = 'zzz-no-such-model';
  ui.el('catalog-form').listeners.submit({ preventDefault() {} });
  await ui.waitForDOM(() => ui.el('catalog-list').innerHTML.includes('No models match'), 'empty state never rendered');
  const failing = await makeUi({ failPaths: ['/api/catalog/search'] });
  await failing.clickTab('models');
  // textContent sets emit no DOM mutation; the error text is asserted via
  // the list re-render that always accompanies it.
  await failing.waitForDOM(() => failing.el('catalog-list').innerHTML.includes('injected failure'), 'error state never surfaced');
  assert.ok(failing.el('catalog-error').textContent.includes('injected failure'));
  assert.ok(failing.el('catalog-list').innerHTML.includes('injected failure'), 'list shows the error, not invented results');
});

test('Overview carries a Models card with counts and a Browse action', async () => {
  const ui = await makeUi();
  await ui.clickTab('overview');
  await ui.waitForDOM(() => ui.el('ov-cards').innerHTML.includes('Models & adapters'), 'overview never rendered the catalog card');
  const text = textOf(ui.el('ov-cards').innerHTML);
  assert.ok(text.includes('0 private'), 'Phase 1 has no private assets yet: ' + text);
  assert.ok(text.includes('Browse catalog'), 'card links into the Models tab');
  assert.ok(ui.el('ov-cards').innerHTML.includes('data-goto="models"'), 'navigation delegates to the real tab');
});

test('demo browses fixtures but gets no compat form', async () => {
  const ui = await makeUi({ asDemo: true });
  await ui.clickTab('models');
  await ui.waitForDOM(() => ui.el('catalog-list').innerHTML.includes('fixture-org/'), 'demo search never rendered');
  assert.equal(ui.el('demo-models-note').hidden, false, 'demo note shown after load');
  assert.ok(ui.el('catalog-meta').textContent.includes('DEMO DATA'));
  await openDetail(ui, 'fixture-org/tiny-base', false);
  assert.ok(ui.el('asset-detail').innerHTML.includes('disabled for the demo account'));
  assert.ok(!ui.el('asset-detail').innerHTML.includes('compat-form'), 'no evaluation form for demo');
});

test('AC22: status announcements, focus target, and text state labels', async () => {
  const ui = await makeUi();
  const node = await registerResource(ui, 'box');
  await openDetail(ui, 'fixture-org/tiny-instruct-gguf');
  ui.el('compat-node').value = node.id;
  ui.el('compat-runtime').value = 'fixture-llama';
  ui.el('compat-context').value = '2048';
  ui.el('compat-concurrency').value = '1';
  ui.el('compat-form').listeners.submit({ preventDefault() {} });
  await ui.waitForDOM(() => ui.el('compat-out').innerHTML.includes('compat-head'), 'decision never rendered');
  const out = ui.el('compat-out').innerHTML;
  const head = nodesOf(out).find((n) => attr(n, 'id') === 'compat-head');
  assert.ok(head, 'decision heading exists');
  assert.equal(attr(head, 'tabindex'), '-1', 'decision heading is a focus target');
  assert.ok(/estimated compatible|blocked|unknown/.test(textOf(out)), 'state is a text label, never color-only');
  // role=status regions are static markup in index.html; the compat host is
  // rendered with the role by the client template.
  assert.ok((await readFile(PUBLIC + '/app/index.html', 'utf8')).includes('id="catalog-meta" class="muted" role="status"'));
  assert.ok(ui.el('asset-detail').innerHTML.includes('id="compat-out" role="status"'), 'compat host keeps its announced role');
});

test('switching tabs drops the late search response instead of rendering it', async () => {
  const ui = await makeUi();
  const pending = ui.clickTab('models');
  await ui.clickTab('overview');
  await pending;
  await ui.flush();
  assert.ok(!ui.el('catalog-list').innerHTML.includes('fixture-org/'), 'stale results never render after navigation');
});

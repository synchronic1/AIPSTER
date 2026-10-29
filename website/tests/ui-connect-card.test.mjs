// "Connect your computer" quickstart card: runs the exact checked-in client
// against real local handlers (same minimal-DOM pattern as ui-session).
// Asserts authenticated rendering, anonymous denial, pinned public
// destinations, honest labels, and no API/credential surface.
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'parse5';
import { createTestEnv } from './d1-shim.mjs';
import { checkPublic } from '../scripts/check.mjs';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COMMIT = '7b38ba071d6a6f1520140486835f9d6a01adafab';
const TREE = `https://github.com/synchronic1/AIPSTER/blob/${COMMIT}/local-worker/`;
const EXPECTED_LINKS = [
  `https://github.com/synchronic1/AIPSTER/archive/${COMMIT}.zip`,
  `${TREE}README.md`,
  `${TREE}README.md#tested-installation`,
  `${TREE}README.md#optional-real-engine-preparation-not-needed-for-the-mock-check`,
  `${TREE}README.md#stop-uninstall-and-troubleshoot`,
  `${TREE}VERIFICATION.md`,
  `${TREE}EXECUTION-GAPS.md`,
  'https://github.com/synchronic1/AIPSTER/pull/20'
].sort();

async function makeUi({ anonymous = false } = {}) {
  const source = await readFile(path.join(PUBLIC, 'app', 'app.js'), 'utf8');
  const t = await createTestEnv();
  const elements = new Map();
  function el(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id, hidden: false, textContent: '', innerHTML: '', value: '', attrs: {}, listeners: {}, dataset: {},
        addEventListener(type, fn) { this.listeners[type] = fn; },
        setAttribute(name, value) { this.attrs[name] = value; },
        querySelectorAll() { return []; }
      });
    }
    return elements.get(id);
  }
  const names = ['overview', 'compute', 'shared', 'sharing', 'keys', 'usage', 'settings'];
  const tabs = names.map((name) => { const e = el('nav-' + name); e.dataset.tab = name; return e; });
  names.forEach((name) => { el('tab-' + name).hidden = name !== 'overview'; });
  for (const id of ['view-app', 'sessionbar', 'connect-card']) el(id).hidden = true;
  let cookie = anonymous ? '' : t.as(t.alice).Cookie;
  const calls = [];
  const fetchImpl = async (fetchPath, opts = {}) => {
    calls.push(`${opts.method ?? 'GET'} ${fetchPath}`);
    const res = await t.call(fetchPath, { method: opts.method ?? 'GET', headers: { Cookie: cookie, Origin: 'http://localhost:8787', ...opts.headers }, body: opts.body });
    if (fetchPath === '/api/auth/sign-out' && res.ok) cookie = '';
    return res;
  };
  const logs = [];
  const context = vm.createContext({
    document: { getElementById: el, querySelectorAll(sel) { return sel === '[data-tab]' ? tabs : sel === '[role="tabpanel"]' ? names.map((n) => el('tab-' + n)) : []; } },
    location: { origin: 'http://localhost:8787', pathname: '/app/', search: '' }, fetch: fetchImpl, setTimeout() { return 0; },
    console: { log: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a), info: (...a) => logs.push(a) },
    URLSearchParams, history: { replaceState() {} }
  });
  await new vm.Script(source, { filename: 'exact-client.js' }).runInContext(context);
  const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
  await flush();
  const clickTab = async (name) => { tabs.find((e) => e.dataset.tab === name).listeners.click(); await flush(); };
  return { el, calls, logs, clickTab, flush, logout: async () => { await el('logout').listeners.click(); await flush(); } };
}

function nodesOf(html) {
  const out = [];
  (function visit(n) { out.push(n); for (const c of n.childNodes || []) visit(c); })(parse(`<!doctype html><body>${html}</body>`));
  return out;
}
const textOf = (html) => nodesOf(html).filter((n) => n.nodeName === '#text').map((n) => n.value).join('').replace(/\s+/g, ' ');

test('anonymous visitors never get the card', async () => {
  const ui = await makeUi({ anonymous: true });
  assert.equal(ui.el('view-app').hidden, true, 'signed-out shell stays on login');
  assert.equal(ui.el('connect-card').hidden, true);
  assert.equal(ui.el('connect-card').innerHTML, '', 'no quickstart markup without a session');
  assert.deepEqual(ui.calls, ['GET /api/auth/get-session']);
});

test('signed-in owner sees the card on My Compute with pinned public destinations', async () => {
  const ui = await makeUi();
  assert.equal(ui.el('view-app').hidden, false, 'positive control: session restored');
  const before = ui.calls.length;
  await ui.clickTab('compute');
  const card = ui.el('connect-card');
  assert.equal(card.hidden, false);
  const nodes = nodesOf(card.innerHTML);
  const anchors = nodes.filter((n) => n.tagName === 'a');
  const hrefs = [...new Set(anchors.map((a) => a.attrs.find((x) => x.name === 'href').value))].sort();
  assert.deepEqual(hrefs, EXPECTED_LINKS, 'every destination is the public repo at the pinned commit');
  const anchorText = (a) => a.childNodes.map((c) => c.value || '').join('').trim();
  for (const a of anchors) {
    assert.deepEqual(a.attrs.map((x) => x.name === 'class' ? 'class' : x.name).filter((n) => n !== 'class'), ['href'], 'plain links: no target/onclick/download attributes');
    assert.ok(anchorText(a).length > 3, 'links have descriptive visible text');
  }
  const archive = anchors.find((a) => a.attrs.find((x) => x.name === 'href').value.endsWith('.zip'));
  assert.equal(anchorText(archive), 'Get worker source (.zip)', 'source-only download is labelled as source');
  assert.equal(nodes.filter((n) => n.tagName === 'button' || n.tagName === 'form' || n.tagName === 'input').length, 0, 'card performs no actions');
  // Only the existing inventory read happens; the card adds no API call.
  assert.deepEqual(ui.calls.slice(before), ['GET /api/inventory?limit=50']);
});

test('card copy is honest about status, platforms and prerequisites', async () => {
  const ui = await makeUi();
  await ui.clickTab('compute');
  const html = ui.el('connect-card').innerHTML;
  const text = textOf(html);
  for (const phrase of ['Connect your computer', 'Connection setup pending', 'Not connected.', 'does not share your resources or enable inference',
    'Windows x64: tested', 'mock check only', 'macOS / Linux: not qualified', 'untested', 'separate prerequisites',
    'There is no installer or binary yet', 'There is no pairing code or worker credential yet', 'Disconnect and uninstall', 'Troubleshooting',
    'ganglion-dendrite 0.1.0', COMMIT]) {
    assert.ok(text.includes(phrase), `missing: ${phrase}`);
  }
  assert.ok(!/\bconnected\b/i.test(text.replace(/not connected/gi, '')), 'never claims a connected state');
  assert.ok(!/\bready\b|\bonline\b/i.test(text.replace(/offline/gi, '')), 'never claims readiness or liveness');
  assert.ok(!/download (the )?(binary|installer|\.exe)|pairing (token|code):/i.test(text));
  assert.ok(html.includes('<span class="pill warn">Connection setup pending</span>'));
  assert.equal((html.match(/class="pill ok"/g) || []).length, 1, 'only the Windows platform label is green');
  assert.ok(html.includes('<span class="pill ok">Windows x64: tested</span>'));
  // Commands are copied from the published quickstart, pinned to the commit.
  assert.ok(text.includes(`git checkout --detach ${COMMIT}`));
  assert.ok(text.includes('uv run --no-project --python 3.12.14 python install.py'));
  assert.ok(text.includes('.\\.venv\\Scripts\\dendrite.exe serve --config configs/mock.toml'));
});

test('card carries no credentials and nothing is logged', async () => {
  const ui = await makeUi();
  await ui.clickTab('compute');
  const html = ui.el('connect-card').innerHTML;
  assert.ok(!/aip_[a-z0-9_]{8,}|gh[pousr]_|sk-[\w]{8,}|token=|secret=|key=|[?&](?:code|auth)=/i.test(html), 'no credential-shaped material or query secrets');
  assert.ok(!html.includes('?'), 'no query strings in any destination');
  assert.deepEqual(ui.logs, [], 'client logs nothing');
});

test('logout removes the card', async () => {
  const ui = await makeUi();
  await ui.clickTab('compute');
  assert.notEqual(ui.el('connect-card').innerHTML, '', 'positive control');
  await ui.logout();
  assert.equal(ui.el('view-login').hidden, false);
  assert.equal(ui.el('connect-card').innerHTML, '');
  assert.equal(ui.el('connect-card').hidden, true);
});

test('card placeholder sits in My Compute and the public policy still passes', async () => {
  const html = await readFile(path.join(PUBLIC, 'app', 'index.html'), 'utf8');
  const compute = html.slice(html.indexOf('<section id="tab-compute"'), html.indexOf('<section id="tab-shared"'));
  assert.match(compute, /<h1>My Compute<\/h1>\s*<section id="connect-card" class="card connect" aria-label="Connect your computer" hidden><\/section>/);
  const css = await readFile(path.join(PUBLIC, 'app', 'styles.css'), 'utf8');
  assert.match(css, /\.connect pre \{[^}]*overflow-x:auto/, 'long commands scroll inside the card, not the page');
  assert.match(css, /a\.btn \{[^}]*min-height:44px/, 'touch-sized link buttons');
  await checkPublic(PUBLIC);
});

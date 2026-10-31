/* Built with Meta Muse. Exact-client probe for the heartbeat strip copy:
 * loads the checked-in public/app/app.js in a stub DOM (same pattern as
 * ui-session.test.mjs) and asserts renderStatus presents heartbeat-seen
 * resources as reachability-only, usable=false with distinct not-ready
 * attention copy, and never as runnable/ready. DEMO DATA labels stay. */
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const APP_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app', 'app.js');

async function loadClient() {
  const source = await readFile(APP_JS, 'utf8');
  const elements = new Map();
  function el(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id, hidden: false, textContent: '', innerHTML: '', value: '', attrs: {}, listeners: {}, dataset: {},
        addEventListener(type, fn) { this.listeners[type] = fn; },
        setAttribute(name, value) { this.attrs[name] = value; },
        querySelectorAll() { return []; },
      });
    }
    return elements.get(id);
  }
  const names = ['overview', 'compute', 'shared', 'sharing', 'keys', 'usage', 'settings'];
  const tabs = names.map((name) => { const e = el('nav-' + name); e.dataset.tab = name; return e; });
  const context = vm.createContext({
    document: { getElementById: el, querySelectorAll(sel) { return sel === '[data-tab]' ? tabs : sel === '[role="tabpanel"]' ? names.map((n) => el('tab-' + n)) : []; } },
    location: { origin: 'http://localhost:8787', pathname: '/app/', search: '' },
    fetch: async () => ({ ok: true, json: async () => null }),
    setTimeout() { return 0; }, console, URLSearchParams,
    history: { replaceState() {} },
  });
  await new vm.Script(source, { filename: 'exact-client.js' }).runInContext(context);
  await new Promise(setImmediate);
  assert.equal(typeof context.renderStatus, 'function', 'client exposes renderStatus');
  return { context, el };
}

const item = (over = {}) => ({
  id: 'r_1', name: 'lab', kind: 'local', liveness: 'online',
  lastSeenAt: new Date().toISOString(), lastSeenAgeMs: 1000, usable: true, demoFixture: false, ...over,
});
const payload = (items, over = {}) => ({
  schema: 'aipster.status/1', generatedAt: new Date().toISOString(), demo: false,
  source: 'declared-resources', telemetry: 'unavailable',
  summary: { total: items.length, online: items.length, stale: 0, offline: 0, unknown: 0 },
  total: items.length, itemsTruncated: false, sharedWithMe: 0, items, ...over,
});
// "not ready to run" / "nothing here means ready to run" are negations, not a
// ready presentation: strip them before asserting no ready/runnable remains.
const stripNegations = (html) => html.replace(/not ready to run|nothing here means ready to run/gi, '');

test('heartbeat-seen rows show reachability-only copy, never runnable/ready', async () => {
  const { context, el } = await loadClient();
  const host = el('probe');
  context.renderStatus(host, payload([item()]));
  assert.ok(host.innerHTML.includes('heartbeat seen (reachability only'), host.innerHTML);
  assert.ok(!stripNegations(host.innerHTML).match(/ready|runnable/i), 'no ready/runnable presentation');
});

test('usable=false rows get distinct not-ready attention copy', async () => {
  const { context, el } = await loadClient();
  const host = el('probe');
  context.renderStatus(host, payload([item({ usable: false })]));
  assert.ok(host.innerHTML.includes('ATTENTION: reachable but NOT usable for inference'), host.innerHTML);
  assert.ok(!stripNegations(host.innerHTML).match(/ready|runnable/i), 'never rendered as runnable/ready');
});

test('never-seen rows keep the heartbeat-unavailable copy', async () => {
  const { context, el } = await loadClient();
  const host = el('probe');
  context.renderStatus(host, payload([item({ liveness: 'offline', lastSeenAt: null, lastSeenAgeMs: null, usable: false })]));
  assert.ok(host.innerHTML.includes('last seen never'), host.innerHTML);
  assert.ok(!host.innerHTML.includes('heartbeat seen'), 'no heartbeat copy without a heartbeat');
  assert.ok(!host.innerHTML.includes('ATTENTION'), 'no attention copy without a heartbeat');
  assert.ok(host.innerHTML.includes('no worker heartbeats seen'), 'global unavailable copy kept');
  assert.ok(!host.innerHTML.includes('live telemetry is unavailable'), 'bare telemetry wording is gone');
});

test('demo labels are unchanged by heartbeat presence', async () => {
  const { context, el } = await loadClient();
  const host = el('probe');
  context.renderStatus(host, payload([item({ demoFixture: true })], { demo: true, source: 'demo-fixture' }));
  assert.ok(host.innerHTML.includes('DEMO DATA: simulated fixture, not a live node.'), host.innerHTML);
  assert.ok(host.innerHTML.includes('· DEMO'), host.innerHTML);
});

test('stale rows never carry present-tense reachability wording', async () => {
  // Muse W4 round 13: lastSeenAt survives after a worker goes stale,
  // so a timestamp-presence check kept ATTENTION: reachable forever.
  const { context, el } = await loadClient();
  const host = el('probe');
  context.renderStatus(host, payload([item({ liveness: 'stale', lastSeenAt: new Date(Date.now() - 3600 * 1000).toISOString(), lastSeenAgeMs: 3600000, usable: false })]));
  assert.ok(!host.innerHTML.includes('ATTENTION: reachable'), host.innerHTML);
  assert.ok(host.innerHTML.includes('not currently reachable'), host.innerHTML);
});

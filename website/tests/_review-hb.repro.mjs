// Review reproductions for PR #20 @ 2e2859d, ADAPTED as regression tests.
// Defect assertions from the review handoff are INVERTED here: this file
// asserts the FIXED behavior. Server + exact client: the checked-in
// public/app/app.js runs in a stub DOM whose fetch is routed into the real
// worker over the D1 shim, signed in as alice.
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTestEnv, readJson, TEST_URL } from './d1-shim.mjs';

const APP_JS = new URL('../public/app/app.js', import.meta.url);

async function register(t, user, name) {
  const res = await readJson(await t.call('/api/inventory', { method: 'POST', headers: { ...t.as(user), ...t.csrf }, body: { name, kind: 'local', origin: 'lab', cpu: 'x', gpu: 'y' } }));
  assert.equal(res.status, 201, res.text);
  return res.json;
}
async function mintHeartbeat(t, user, resourceId) {
  const out = await readJson(await t.call('/api/keys', { method: 'POST', headers: { ...t.as(user), ...t.csrf }, body: { name: 'hb', scope: 'heartbeat', resourceId } }));
  assert.equal(out.status, 201, out.text);
  return out.json;
}
const beat = (t, secret, id, usable = true) => t.call(`/api/resources/${id}/heartbeat`, { method: 'POST', headers: { Authorization: 'Bearer ' + secret }, body: JSON.stringify({ usable }) });
const get = async (t, path) => (await readJson(await t.call(path, { headers: t.as(t.alice) }))).json;

async function client(t) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, { id, hidden: false, textContent: '', innerHTML: '', value: '', attrs: {}, listeners: {}, dataset: {},
      addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute(n, v) { this.attrs[n] = v; }, querySelectorAll() { return []; } });
    return elements.get(id);
  };
  const names = ['overview', 'compute', 'shared', 'sharing', 'keys', 'usage', 'settings'];
  const tabs = names.map((n) => { const e = el('nav-' + n); e.dataset.tab = n; return e; });
  const context = vm.createContext({
    document: { getElementById: el, querySelectorAll(sel) { return sel === '[data-tab]' ? tabs : sel === '[role="tabpanel"]' ? names.map((n) => el('tab-' + n)) : []; } },
    location: { origin: TEST_URL, pathname: '/app/', search: '' },
    fetch: (path, init = {}) => t.call(path, { method: init.method || 'GET', headers: { ...t.as(t.alice), ...(init.headers || {}) }, body: init.body }),
    setTimeout() { return 0; }, console, URLSearchParams, history: { replaceState() {} },
  });
  await new vm.Script(await readFile(APP_JS, 'utf8'), { filename: 'exact-client.js' }).runInContext(context);
  await new Promise(setImmediate);
  return { context, el };
}

test('FIXED P2-a: inventory and Compute follow heartbeat freshness like /api/status', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'lab-box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  assert.equal((await beat(t, key.secret, r.id, true)).status, 200);
  // Fresh heartbeat renders online everywhere.
  const fresh = await get(t, '/api/inventory?limit=50');
  assert.equal(fresh.items[0].state.online, true);
  assert.equal(fresh.items[0].state.usable, true);
  const { context, el } = await client(t);
  await context.loadCompute();
  assert.match(el('compute-list').innerHTML, /pill ok">online: yes/);
  assert.match(el('compute-list').innerHTML, /pill ok">usable: yes/);
  // Heartbeats stop: age the only heartbeat past the 5-minute stale window.
  await t.DB.prepare('UPDATE resources SET heartbeat_at = ? WHERE id = ?').bind(new Date(Date.now() - 10 * 60e3).toISOString(), r.id).run();
  const status = await get(t, '/api/status');
  assert.equal(status.items[0].liveness, 'stale');
  assert.equal(status.summary.online, 0);
  // Fixed: inventory derives the displayed state from freshness, not the
  // persisted flag, and the Compute panel agrees with /api/status.
  const inv = await get(t, '/api/inventory?limit=50');
  assert.equal(inv.items[0].state.online, false);
  assert.equal(inv.items[0].state.usable, false);
  await context.loadCompute();
  assert.match(el('compute-list').innerHTML, /pill bad">online: no/);
  assert.match(el('compute-list').innerHTML, /pill bad">usable: no/);
  assert.match(el('compute-list').innerHTML, /status: unauthenticated/, 'status is never ready: authenticated=0');
});

test('FIXED P2-b: heartbeat-key selector lists all 60 owned resources', async () => {
  const t = await createTestEnv();
  const ids = [];
  for (let i = 0; i < 60; i++) {
    ids.push((await register(t, t.alice, 'box-' + i)).id);
    await new Promise((r) => setTimeout(r, 2)); // distinct created_at ordering
  }
  const { context, el } = await client(t);
  await context.loadKeys();
  const options = [...el('key-resource').innerHTML.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(options.length, 60);
  assert.ok(options.includes(ids[0]), 'oldest resource is reachable from the UI');
  assert.equal((await mintHeartbeat(t, t.alice, ids[0])).resourceId, ids[0]);
});

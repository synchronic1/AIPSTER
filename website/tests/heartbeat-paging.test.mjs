/* Handoff fix 2 (P2): the heartbeat-key selector pages the full inventory
 * via allInventory() instead of rendering only the first 50-item page.
 * Exact-client tests: the checked-in public/app/app.js runs in a stub DOM
 * whose fetch is routed into the real worker over the D1 shim. */
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTestEnv, readJson, TEST_URL } from './d1-shim.mjs';

const APP_JS = new URL('../public/app/app.js', import.meta.url);

async function seedResources(t, user, n) {
  const base = Date.now();
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = `r_page_${i}`;
    await t.DB.prepare(`INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated, online, usable, heartbeat_at, limits_json, scope, verification_json, credits_json, created_at)
      VALUES (?, ?, ?, 'local', 'seed', 'x', 'y', '[]', 1, 0, 0, 0, NULL, '{}', 'owner only', '{}', NULL, ?)`)
      .bind(id, user.id, `box-${i}`, new Date(base + i * 1000).toISOString()).run();
    ids.push(id);
  }
  return ids; // index 0 is the oldest
}

async function client(t, onFetch, fail) {
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
    fetch: (path, init = {}) => {
      if (onFetch) onFetch(String(path), el);
      if (fail && fail(String(path))) return Promise.resolve(new Response('{"error":"injected failure"}', { status: 500 }));
      return t.call(path, { method: init.method || 'GET', headers: { ...t.as(t.alice), ...(init.headers || {}) }, body: init.body });
    },
    setTimeout() { return 0; }, console, URLSearchParams, history: { replaceState() {} },
  });
  await new vm.Script(await readFile(APP_JS, 'utf8'), { filename: 'exact-client.js' }).runInContext(context);
  await new Promise(setImmediate);
  return { context, el };
}

const optionsOf = (el) => [...el('key-resource').innerHTML.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);

for (const n of [60, 100]) {
  test(`key-resource selector lists all ${n} resources including the oldest`, async () => {
    const t = await createTestEnv();
    const ids = await seedResources(t, t.alice, n);
    // Count the paged walk only (allInventory always sends offset=...);
    // the background Overview load from client startup is not counted.
    let pages = 0;
    const { context, el } = await client(t, (path) => { if (path.includes('/api/inventory?') && path.includes('offset=')) pages++; });
    await context.loadKeys();
    const options = optionsOf(el);
    assert.equal(options.length, n);
    assert.deepEqual(new Set(options), new Set(ids), 'every owned resource is offered');
    assert.ok(options.includes(ids[0]), 'oldest resource is reachable from the UI');
    assert.equal(pages, 2, 'two pages under the 100-resource cap');
  });
}

test('small inventories still fetch a single page', async () => {
  const t = await createTestEnv();
  const ids = await seedResources(t, t.alice, 3);
  let pages = 0;
  const { context, el } = await client(t, (path) => { if (path.includes('/api/inventory?') && path.includes('offset=')) pages++; });
  await context.loadKeys();
  assert.deepEqual(new Set(optionsOf(el)), new Set(ids));
  assert.equal(pages, 1);
});

test('a stale generation mid-pagination drops the walk without rendering', async () => {
  const t = await createTestEnv();
  await seedResources(t, t.alice, 60);
  let sawPage2 = false;
  const { context, el } = await client(t, (path, el) => {
    // Tab switch between page 1 and page 2: bumps the client generation
    // synchronously before the second page responds.
    if (path.includes('/api/inventory?') && path.includes('offset=50')) {
      sawPage2 = true;
      el('nav-compute').listeners.click();
    }
  });
  await context.loadKeys(); // stale walks resolve quietly; nothing renders
  assert.equal(el('key-resource').innerHTML, '', 'stale paged options are never rendered');
  assert.ok(sawPage2, 'pagination was interrupted mid-walk');
});

test('key management renders when the inventory walk fails', async () => {
  // Codex P2 round 13: a 50-resource inventory page exceeded D1's
  // 50-query cap, and loadKeys' Promise.all discarded the keys response
  // with it — hiding the key list and Revoke. Keys must render
  // independently; only the resource dropdown may degrade.
  const t = await createTestEnv();
  const now = new Date().toISOString();
  await t.DB.prepare(`INSERT INTO key_verifiers (id, owner_id, name, scope, resource_id, salt, verifier, prefix, expires_at, metadata, created_at, last_used_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind('k_ui1', 'u_alice', 'my-read-key', 'read', null, 's', 'v', 'aip_live_k_ui1_x', null, '', now, null, null).run();
  const { context, el } = await client(t, null, (path) => path.startsWith('/api/inventory'));
  await context.loadKeys();
  const html = el('key-list').innerHTML;
  assert.ok(html.includes('my-read-key'), 'key card renders despite inventory failure: ' + html);
  assert.ok(html.includes('data-revkey'), 'Revoke control stays available');
  assert.ok(el('key-resource').innerHTML.includes('unavailable'), 'dropdown degrades honestly');
});

/* Built with Meta Muse. */
// Admin milestone 1 UI tests: the Overview/Resources shell renders only the
// server-reported states (vm harness mirrors advisor-ui), escapes untrusted
// row content, announces status/result regions, and pages through keyboard-
// operable native buttons. Fixture payloads are disposable.
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFragment } from 'parse5';

const source = await readFile(new URL('../public/admin/admin.js', import.meta.url), 'utf8');
const shell = await readFile(new URL('../public/admin/index.html', import.meta.url), 'utf8');
const styles = await readFile(new URL('../public/admin/styles.css', import.meta.url), 'utf8');

function makeEl(tag, id) {
  return {
    tag, id: id || null, dataset: {}, kids: {},
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false,
    listeners: {}, attrs: {}, hostSection: null,
    addEventListener(k, v) { this.listeners[k] = v; },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    querySelector(sel) { return this.kids[sel] || null; },
    closest(sel) { return sel === 'section' ? this.hostSection : null; },
    click() { if (this.listeners.click) this.listeners.click(); },
    focus() { this.focused = true; },
  };
}

function harness(routes) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl('div', id));
    return elements.get(id);
  };
  const sections = {};
  for (const id of ['overview', 'resources']) {
    const section = makeEl('section', id);
    const state = makeEl('p', null);
    section.kids['.state'] = state;
    sections[id] = { section, state };
    elements.set(id, section);
  }
  const buttons = [];
  for (const id of ['overview', 'resources']) {
    const b = makeEl('button', null);
    b.attrs['data-endpoint'] = '/api/admin/v1/' + id;
    b.hostSection = sections[id].section;
    buttons.push(b);
  }
  const calls = [];
  const fetcher = async (path) => {
    calls.push(String(path));
    const url = new URL(String(path), 'https://admin.local');
    const route = routes[url.pathname];
    if (!route) return Response.json({ error: 'No route', code: 'UNKNOWN' }, { status: 404 });
    const out = route(url);
    if (out instanceof Error) throw out;
    return Response.json(out.body, { status: out.status });
  };
  const context = vm.createContext({
    document: {
      getElementById: el,
      querySelectorAll(sel) { return sel === 'button[data-endpoint]' ? buttons : []; },
      createElement(tag) { return makeEl(tag, null); },
    },
    fetch: fetcher,
    encodeURIComponent: globalThis.encodeURIComponent,
    console,
  });
  vm.runInContext(source, context, { filename: 'admin.js' });
  el('resources-pages').hidden = true;
  return { el, sections, buttons, calls };
}

async function settled(pred, what) {
  for (let i = 0; i < 500; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('never settled: ' + what);
}

const AVAILABLE_OVERVIEW = {
  status: 200,
  body: {
    schema_version: 'admin.overview.v1', state: 'available', observed_at: '2026-10-31T18:00:00.000Z',
    resources: { total: 3, online: 1, stale: 1, offline: 0, unknown: 1 },
    fabrics: null, fabrics_state: 'unavailable', fabrics_reason_code: 'fabric_model_pending',
    usable_capacity: null, usable_capacity_state: 'not_instrumented',
    coverage: null, coverage_state: 'unavailable', coverage_reason_code: 'coverage_pending',
  },
};

function pageBody(items, total) {
  return {
    status: 200,
    body: {
      schema_version: 'admin.resources.v1', state: 'available', observed_at: '2026-10-31T18:00:00.000Z',
      items, total, limit: 20, offset: 0,
    },
  };
}

test('admin ui: overview renders server counts and names every gap', async () => {
  const h = harness({ '/api/admin/v1/status': () => ({ status: 401, body: { error: 'x', code: 'AUTH_REQUIRED' } }), '/api/admin/v1/overview': () => AVAILABLE_OVERVIEW });
  h.buttons[0].click();
  await settled(() => h.sections.overview.state.textContent !== 'Loading…', 'overview render');
  assert.match(h.sections.overview.state.textContent, /Loaded 2026-10-31T18:00:00\.000Z/);
  const html = h.el('overview-result').innerHTML;
  for (const want of ['>3</td>', '>1</td>', 'fabric_model_pending', 'not_instrumented', 'coverage_pending']) {
    assert.ok(html.includes(want), 'overview table names ' + want);
  }
  assert.ok(html.includes('<tr><th>fabrics</th><td>unavailable (fabric_model_pending)</td></tr>'), 'fabrics gap stays a reason code');
  assert.ok(html.includes('<tr><th>usable capacity</th><td>not_instrumented</td></tr>'), 'capacity gap stays a reason code');
  assert.ok(html.includes('<tr><th>coverage</th><td>unavailable (coverage_pending)</td></tr>'), 'coverage gap stays a reason code');
});

test('admin ui: overview denial and transport failure stay explicit', async () => {
  const denied = harness({ '/api/admin/v1/overview': () => ({ status: 403, body: { error: 'no', code: 'ADMIN_FORBIDDEN' } }) });
  denied.buttons[0].click();
  await settled(() => denied.sections.overview.state.textContent !== 'Loading…', 'denial render');
  assert.match(denied.sections.overview.state.textContent, /ADMIN_FORBIDDEN.*HTTP 403/);
  assert.equal(denied.el('overview-result').innerHTML, '', 'denied render leaves no stale table');
  const broken = harness({ '/api/admin/v1/overview': () => new Error('boom') });
  broken.buttons[0].click();
  await settled(() => broken.sections.overview.state.textContent !== 'Loading…', 'failure render');
  assert.equal(broken.sections.overview.state.textContent, 'Unavailable: request failed.');
});

test('admin ui: resources escape untrusted content and label the page', async () => {
  const xss = { id: 'r_"1', name: '<img src=x onerror=alert(1)>', kind: 'local', liveness: 'online', lastSeenAt: '2026-10-31T17:59:00.000Z', lastSeenAgeMs: 1, usable: true, configured: true, authenticated: true };
  const unseen = { id: 'r_2', name: 'quiet', kind: 'cluster', liveness: 'unknown', lastSeenAt: null, lastSeenAgeMs: null, usable: null, configured: false, authenticated: false };
  const h = harness({ '/api/admin/v1/resources': () => pageBody([xss, unseen], 5) });
  h.buttons[1].click();
  await settled(() => h.sections.resources.state.textContent !== 'Loading…', 'resources render');
  const html = h.el('resources-result').innerHTML;
  assert.ok(!html.includes('<img src=x'), 'row markup is escaped');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'escaped name still readable');
  assert.ok(html.includes('r_&quot;1'), 'id quotes escaped');
  assert.ok(html.includes('never seen'), 'missing last-seen reads as never seen, not epoch');
  assert.equal(h.el('resources-page-label').textContent, 'Rows 1–2 of 5.');
  assert.equal(h.el('resources-pages').hidden, false);
  assert.equal(h.el('resources-prev').disabled, true, 'first page disables Previous');
  assert.equal(h.el('resources-next').disabled, false);
  assert.ok(h.calls.find((c) => c.includes('/api/admin/v1/resources?limit=20&offset=0')), 'first load requests the first window');
});

test('admin ui: empty inventory and unknown totals keep the pager honest', async () => {
  const empty = harness({ '/api/admin/v1/resources': () => pageBody([], 0) });
  empty.buttons[1].click();
  await settled(() => empty.sections.resources.state.textContent !== 'Loading…', 'empty render');
  assert.equal(empty.el('resources-result').textContent, 'No resources registered (empty).');
  assert.equal(empty.el('resources-pages').hidden, true, 'no rows, no pager');
  const unknownTotal = harness({ '/api/admin/v1/resources': () => pageBody([{ id: 'r_1', name: 'n', kind: 'local', liveness: 'online', lastSeenAt: null, lastSeenAgeMs: null, usable: true, configured: true, authenticated: true }], null) });
  unknownTotal.buttons[1].click();
  await settled(() => unknownTotal.sections.resources.state.textContent !== 'Loading…', 'unknown-total render');
  assert.equal(unknownTotal.el('resources-pages').hidden, true, 'missing total hides the pager, never guesses');
});

test('admin ui: pager buttons page through windows and clamp at the ends', async () => {
  const seen = [];
  const h = harness({
    '/api/admin/v1/resources': (url) => {
      const offset = Number(url.searchParams.get('offset'));
      seen.push(offset);
      return { status: 200, body: { schema_version: 'admin.resources.v1', state: 'available', observed_at: 't', items: [], total: 45, limit: 20, offset } };
    },
  });
  const rendered = (n) => seen.length >= n && h.sections.resources.state.textContent !== 'Loading…';
  h.buttons[1].click();
  await settled(() => rendered(1), 'first window');
  assert.equal(h.el('resources-result').textContent, 'No rows on this page.');
  h.el('resources-next').click();
  await settled(() => rendered(2), 'second window');
  assert.deepEqual(seen, [0, 20]);
  h.el('resources-prev').click();
  await settled(() => rendered(3), 'back to first');
  assert.deepEqual(seen, [0, 20, 0]);
  h.el('resources-prev').click();
  await settled(() => rendered(4), 'clamped');
  assert.deepEqual(seen, [0, 20, 0, 0], 'Previous at offset 0 re-requests 0, never negative');
});

test('admin ui: hidden pager stays hidden under the flex layout', () => {
  assert.ok(styles.includes('.pager[hidden]{display:none}'), 'flex .pager must not override the hidden attribute');
});

test('admin ui: shell keeps milestone controls keyboard-operable and announced', () => {
  const frag = parseFragment(shell);
  const found = {};
  const walk = (node) => {
    if (node.attrs) {
      const byName = Object.fromEntries(node.attrs.map((a) => [a.name, a.value]));
      if (byName.id === 'overview-result' || byName.id === 'resources-result' || byName.id === 'resources-page-label' || byName.id === 'resources-prev' || byName.id === 'resources-next' || byName.id === 'resources-pages') {
        found[byName.id] = { tag: node.tagName, attrs: byName };
      }
    }
    for (const kid of node.childNodes || []) walk(kid);
  };
  walk(frag);
  for (const id of ['overview-result', 'resources-result']) {
    assert.ok(found[id], id + ' present');
    assert.equal(found[id].attrs['aria-live'], 'polite', id + ' announced');
  }
  for (const id of ['resources-prev', 'resources-next']) {
    assert.equal(found[id].tag, 'button', id + ' is a native button');
    assert.equal(found[id].attrs.type, 'button', id + ' never submits a form');
  }
  assert.ok('hidden' in found['resources-pages'].attrs, 'pager starts hidden until a measured total arrives');
  const states = [];
  const walkSections = (node, sectionId) => {
    const attrs = node.attrs ? Object.fromEntries(node.attrs.map((a) => [a.name, a.value])) : {};
    const current = node.tagName === 'section' && attrs.id ? attrs.id : sectionId;
    if ((current === 'overview' || current === 'resources') && node.tagName === 'p' && attrs.class === 'state') {
      states.push({ section: current, live: attrs['aria-live'] || null });
    }
    for (const kid of node.childNodes || []) walkSections(kid, current);
  };
  walkSections(frag, null);
  assert.deepEqual(states, [{ section: 'overview', live: 'polite' }, { section: 'resources', live: 'polite' }], 'status lines announced');
});

/* Built with Meta Muse. */
// Audit UI tests: the section renders only server-reported states, escapes
// every untrusted field, distinguishes empty from unavailable, sizes its
// window from offset+limit rather than rows.length, and never lets a stale
// success or a stale failure repaint a newer page. Fixture payloads are
// disposable and carry deliberately hostile strings.
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFragment } from 'parse5';

const source = await readFile(new URL('../public/admin/admin.js', import.meta.url), 'utf8');
const shell = await readFile(new URL('../public/admin/index.html', import.meta.url), 'utf8');
const styles = await readFile(new URL('../public/admin/styles.css', import.meta.url), 'utf8');

const AUDIT = '/api/admin/v1/audit';

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

// Mirrors the shipped shell closely enough to exercise the real module-level
// wiring: one Load button per section, one state node, one result box, one pager.
function harness(routes) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl('div', id));
    return elements.get(id);
  };
  const sections = {};
  for (const id of ['overview', 'resources', 'audit']) {
    const section = makeEl('section', id);
    const state = makeEl('p', null);
    section.kids['.state'] = state;
    sections[id] = { section, state };
    elements.set(id, section);
  }
  const buttons = [];
  for (const id of ['overview', 'resources', 'audit']) {
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
    const out = await route(url);
    if (out instanceof Error) throw out;
    if (out instanceof Response) return out;
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
  el('audit-pages').hidden = true;
  return { el, sections, buttons, calls };
}

async function settled(pred, what) {
  for (let i = 0; i < 500; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('never settled: ' + what);
}

const auditButton = (h) => h.buttons.find((b) => b.attrs['data-endpoint'] === AUDIT);

const STATUS_401 = () => ({ status: 401, body: { error: 'x', code: 'AUTH_REQUIRED' } });

function page({ items, total, limit = 20, offset = 0, state = 'available', reason_code }) {
  return {
    status: 200,
    body: {
      schema_version: 'admin.audit.v1',
      state,
      ...(reason_code ? { reason_code } : { observed_at: '2026-11-01T12:00:00.000Z' }),
      items, total, limit, offset,
      projection: {
        fields: ['id', 'action', 'category', 'at', 'action_known', 'at_known'],
        omitted: ['actor_id', 'target', 'detail'],
      },
    },
  };
}

const ROW = { id: 'a_ab12', action: 'resource.register', action_known: true, category: 'resource', at: '2026-11-01T11:59:00.000Z', at_known: true };

test('audit ui: shell ships the contracted ids and native pager buttons', () => {
  const frag = parseFragment(shell);
  const byId = new Map();
  (function walk(n) {
    if (n.attrs) for (const a of n.attrs) if (a.name === 'id') byId.set(a.value, n);
    for (const c of n.childNodes || []) walk(c);
  })(frag);

  const section = byId.get('audit');
  assert.ok(section, 'an #audit section exists');
  assert.equal(section.nodeName, 'section');
  assert.ok(byId.get('audit-result'), '#audit-result exists');
  assert.equal(byId.get('audit-result').attrs.find((a) => a.name === 'aria-live')?.value, 'polite', 'result region is a live region');

  const pages = byId.get('audit-pages');
  assert.ok(pages, '#audit-pages exists');
  assert.ok(pages.attrs.some((a) => a.name === 'hidden'), 'pager starts hidden');
  for (const id of ['audit-prev', 'audit-next', 'audit-page-label']) assert.ok(byId.get(id), id + ' exists');
  assert.equal(byId.get('audit-prev').nodeName, 'button');
  assert.equal(byId.get('audit-next').nodeName, 'button');
  for (const id of ['audit-prev', 'audit-next']) {
    assert.equal(byId.get(id).attrs.find((a) => a.name === 'type')?.value, 'button', id + ' is a native button');
  }

  const load = [];
  (function walk2(n) {
    if (n.attrs) {
      const ep = n.attrs.find((a) => a.name === 'data-endpoint');
      if (ep && ep.value === AUDIT) load.push(n);
    }
    for (const c of n.childNodes || []) walk2(c);
  })(frag);
  assert.equal(load.length, 1, 'exactly one Load control targets the audit endpoint');
  assert.equal(load[0].nodeName, 'button');

  assert.ok(styles.includes('.result:empty'), 'empty result boxes collapse (shared rule)');
  assert.ok(styles.includes('.pager[hidden]'), 'hidden pagers stay hidden (shared rule)');
});

test('audit ui: rows render escaped, with unknown actions and timestamps named', async () => {
  const items = [
    ROW,
    { id: '</td><img src=x onerror=alert(1)>', action: null, action_known: false, category: 'unknown', at: null, at_known: false },
  ];
  const h = harness({ [AUDIT]: () => page({ items, total: 2 }) });
  auditButton(h).click();
  await settled(() => h.sections.audit.state.textContent.startsWith('Loaded'), 'audit render');

  const html = h.el('audit-result').innerHTML;
  assert.ok(html.includes('resource.register'), 'known action is shown');
  assert.ok(html.includes('2026-11-01T11:59:00.000Z'), 'validated timestamp is shown');
  assert.ok(html.includes('unknown'), 'unknown action/timestamp is named, never blank');
  assert.ok(!html.includes('<img'), 'hostile id is escaped into text, not a live tag');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'hostile id survives as inert text');
  assert.ok(html.includes('&lt;/td&gt;'), 'hostile id cannot close the cell');
  const auditCalls = h.calls.filter((c) => c.startsWith(AUDIT));
  assert.equal(auditCalls.length, 1);
  assert.ok(auditCalls[0].includes('limit=20'), 'page size is sent explicitly');
});

test('audit ui: empty is reported as measured, unavailable is reported as a failure', async () => {
  const empty = harness({ [AUDIT]: () => page({ items: [], total: 0 }) });
  auditButton(empty).click();
  await settled(() => empty.el('audit-result').textContent !== '', 'empty render');
  assert.match(empty.el('audit-result').textContent, /No audit events recorded \(empty\)/);
  assert.equal(empty.sections.audit.state.textContent.startsWith('Loaded'), true, 'empty is a successful load');
  assert.equal(empty.el('audit-pages').hidden, true, 'no pager for an empty feed');

  const down = harness({ [AUDIT]: () => page({ items: [], total: null, state: 'unavailable', reason_code: 'audit_unavailable' }) });
  auditButton(down).click();
  await settled(() => down.sections.audit.state.textContent !== 'Loading…', 'unavailable render');
  assert.match(down.sections.audit.state.textContent, /audit_unavailable/);
  assert.match(down.sections.audit.state.textContent, /unavailable/i);
  assert.ok(!down.el('audit-result').textContent.includes('No audit events recorded'), 'a DB failure never reads as an empty feed');
  assert.equal(down.el('audit-pages').hidden, true, 'no pager when nothing was measured');
});

test('audit ui: denial and transport failure stay explicit and paint no rows', async () => {
  const deniedH = harness({ [AUDIT]: () => ({ status: 403, body: { error: 'nope', code: 'ADMIN_FORBIDDEN' } }) });
  auditButton(deniedH).click();
  await settled(() => deniedH.sections.audit.state.textContent !== 'Loading…', 'denied render');
  assert.match(deniedH.sections.audit.state.textContent, /ADMIN_FORBIDDEN/);
  assert.match(deniedH.sections.audit.state.textContent, /403/);
  assert.equal(deniedH.el('audit-result').innerHTML, '');

  const brokeH = harness({ [AUDIT]: () => new Error('offline') });
  auditButton(brokeH).click();
  await settled(() => brokeH.sections.audit.state.textContent !== 'Loading…', 'transport render');
  assert.match(brokeH.sections.audit.state.textContent, /request failed/);
  assert.equal(brokeH.el('audit-result').innerHTML, '');
});

test('audit ui: pager window comes from offset+limit, not from rows.length', async () => {
  // Page 2 of 45: 20 asked, only 3 rendered because malformed rows were skipped.
  const sparse = harness({ [AUDIT]: () => page({ items: [ROW, ROW, ROW], total: 45, offset: 20, limit: 20 }) });
  auditButton(sparse).click();
  await settled(() => !sparse.el('audit-pages').hidden, 'sparse pager');
  const sparseLabel = sparse.el('audit-page-label').textContent;
  assert.match(sparseLabel, /Rows 21–40 of 45/, 'window is offset+limit bounded');
  assert.match(sparseLabel, /3 shown/, 'rendered count is disclosed separately');
  assert.equal(sparse.el('audit-prev').disabled, false);
  assert.equal(sparse.el('audit-next').disabled, false);

  // Beyond the end: offset past total.
  const beyond = harness({ [AUDIT]: () => page({ items: [], total: 45, offset: 60, limit: 20 }) });
  auditButton(beyond).click();
  await settled(() => !beyond.el('audit-pages').hidden, 'beyond-end pager');
  assert.match(beyond.el('audit-page-label').textContent, /Rows 0 of 45 \(0 shown\)/);
  assert.equal(beyond.el('audit-next').disabled, true, 'next is disabled past the end');

  // Last full page: next disabled, prev enabled.
  const last = harness({ [AUDIT]: () => page({ items: [ROW], total: 21, offset: 20, limit: 20 }) });
  auditButton(last).click();
  await settled(() => !last.el('audit-pages').hidden, 'last-page pager');
  assert.match(last.el('audit-page-label').textContent, /Rows 21–21 of 21/);
  assert.equal(last.el('audit-next').disabled, true);
  assert.equal(last.el('audit-prev').disabled, false);
});

test('audit ui: pager buttons request the neighbouring windows', async () => {
  const seen = [];
  const h = harness({ [AUDIT]: (url) => {
    const offset = Number(url.searchParams.get('offset'));
    seen.push(offset);
    return page({ items: [ROW], total: 60, offset, limit: 20 });
  } });
  auditButton(h).click();
  await settled(() => !h.el('audit-pages').hidden, 'first page');
  h.el('audit-next').click();
  await settled(() => h.calls.length >= 3, 'next page');
  await settled(() => h.el('audit-page-label').textContent.includes('Rows 21'), 'next rendered');
  h.el('audit-prev').click();
  await settled(() => h.el('audit-page-label').textContent.includes('Rows 1–20'), 'prev rendered');
  assert.deepEqual(seen, [0, 20, 0], 'pager walks by the negotiated page size');

  h.el('audit-prev').click();
  await settled(() => h.el('audit-prev').disabled === true, 'prev clamps at zero');
  assert.deepEqual(seen, [0, 20, 0, 0]);
});

test('audit ui: a stale success never repaints a newer page', async () => {
  let releaseFirst;
  const first = new Promise((r) => { releaseFirst = r; });
  let call = 0;
  const h = harness({ [AUDIT]: async () => {
    call += 1;
    if (call === 1) {
      await first;
      return page({ items: [{ ...ROW, id: 'a_stale' }], total: 2 });
    }
    return page({ items: [{ ...ROW, id: 'a_fresh' }], total: 2 });
  } });

  auditButton(h).click();          // request 1, held open
  auditButton(h).click();          // request 2, resolves first
  await settled(() => h.el('audit-result').innerHTML.includes('a_fresh'), 'fresh page paints');

  releaseFirst();                  // stale request 1 lands late
  await new Promise((r) => setTimeout(r, 10));
  const html = h.el('audit-result').innerHTML;
  assert.ok(html.includes('a_fresh'), 'newer page survives');
  assert.ok(!html.includes('a_stale'), 'stale success is dropped');
  assert.ok(h.sections.audit.state.textContent.startsWith('Loaded'), 'state reflects the newest page');
});

test('audit ui: a stale failure never clears a newer page', async () => {
  let releaseFirst;
  const first = new Promise((r) => { releaseFirst = r; });
  let call = 0;
  const h = harness({ [AUDIT]: async () => {
    call += 1;
    if (call === 1) {
      await first;
      throw new Error('stale transport failure');
    }
    return page({ items: [{ ...ROW, id: 'a_fresh' }], total: 1 });
  } });

  auditButton(h).click();
  auditButton(h).click();
  await settled(() => h.el('audit-result').innerHTML.includes('a_fresh'), 'fresh page paints');

  releaseFirst();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(h.el('audit-result').innerHTML.includes('a_fresh'), 'stale failure does not clear the box');
  assert.ok(!/request failed/.test(h.sections.audit.state.textContent), 'stale failure does not overwrite the state');
});

test('audit ui: loading clears the previous page and hides its pager', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let call = 0;
  const h = harness({ [AUDIT]: async () => {
    call += 1;
    if (call === 1) return page({ items: [ROW], total: 40 });
    await gate;
    return page({ items: [ROW], total: 40, offset: 20 });
  } });

  auditButton(h).click();
  await settled(() => !h.el('audit-pages').hidden, 'first page');
  h.el('audit-next').click();
  await settled(() => h.sections.audit.state.textContent === 'Loading…', 'second load starts');
  assert.equal(h.el('audit-result').textContent, '', 'stale rows are not left visible while loading');
  assert.equal(h.el('audit-pages').hidden, true, 'stale pager is hidden while loading');
  release();
  await settled(() => !h.el('audit-pages').hidden, 'second page');
});

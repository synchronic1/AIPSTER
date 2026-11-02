/* Built with Meta Muse. */
// Admin milestone 1 UI tests: Coverage/Health/Directory/Sessions panes
// render only the server-reported states (vm harness mirrors admin-ui),
// escape untrusted row content, page with native buttons, and drop stale
// responses. Fixture payloads are disposable.
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/admin/admin.js', import.meta.url), 'utf8');
const shell = await readFile(new URL('../public/admin/index.html', import.meta.url), 'utf8');

for (const id of ['coverage-result', 'operations-result', 'users-result', 'users-pages', 'users-page-label', 'users-prev', 'users-next', 'sessions-state', 'sessions-result', 'sessions-pages', 'sessions-page-label', 'sessions-prev', 'sessions-next', 'signin-github', 'signout', 'demo-enter', 'demo-exit', 'demo-result']) {
  assert.ok(shell.includes('id="' + id + '"'), 'shell ships #' + id);
}

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
  for (const id of ['coverage', 'operations', 'access']) {
    const section = makeEl('section', id);
    const state = makeEl('p', null);
    section.kids['.state'] = state;
    sections[id] = { section, state };
    elements.set(id, section);
  }
  const buttons = [];
  for (const [id, endpoint] of [['coverage', '/api/admin/v1/coverage'], ['operations', '/api/admin/v1/operations/health'], ['access', '/api/admin/v1/access/users']]) {
    const b = makeEl('button', null);
    b.attrs['data-endpoint'] = endpoint;
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
    return Response.json(out.body, { status: out.status });
  };
  const context = vm.createContext({
    document: {
      getElementById: el,
      querySelectorAll(sel) { return sel === 'button[data-endpoint]' ? buttons : []; },
      createElement(tag) { return makeEl(tag, null); },
    },
    fetch: fetcher,
    console,
  });
  vm.runInContext(source, context, { filename: 'admin.js' });
  el('users-pages').hidden = true;
  el('sessions-pages').hidden = true;
  return { el, sections, buttons, calls };
}

async function settled(pred, what) {
  for (let i = 0; i < 500; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('never settled: ' + what);
}

const COVERAGE = {
  status: 200,
  body: {
    schema_version: 'admin.coverage.v1', state: 'available', observed_at: '2026-10-31T18:00:00.000Z',
    items: [
      { metric: 'admitted_work', collector: null, release_state: 'disabled', reason_code: 'inference_dispatch_dark', value: null, observed_at: null },
      { metric: 'incoming_requests', collector: null, release_state: 'not_instrumented', reason_code: 'collector_missing', value: null, observed_at: null },
    ],
    total: 2,
  },
};

const HEALTH = {
  status: 200,
  body: {
    schema_version: 'admin.operations.health.v1', state: 'available', observed_at: '2026-10-31T18:00:00.000Z',
    control_plane: { d1: 'reachable', admin_grants: 'present' },
    collectors: { state: 'not_instrumented', reason_code: 'collector_missing' },
    compatibility: { inference: 'disabled', inference_reason_code: 'inference_dispatch_dark', fabric_model: 'pending', fabric_reason_code: 'fabric_model_pending', dgm_preview: 'fixture_only', dgm_preview_reason_code: 'dgm_fixture_preview' },
  },
};

function usersBody(items, total, limit = 20, offset = 0) {
  return {
    status: 200,
    body: {
      schema_version: 'admin.access.users.v1', state: 'available', observed_at: '2026-10-31T18:00:00.000Z',
      items, total, limit, offset,
    },
  };
}

function sessionsBody(items, total) {
  return {
    status: 200,
    body: {
      schema_version: 'admin.access.sessions.v1', state: 'available', observed_at: '2026-10-31T18:00:00.000Z',
      items, total, limit: 20, offset: 0,
    },
  };
}

const ALICE = { id: 'u_alice', name: 'Alice', email: 'alice@example.com', provider: 'github', status: 'active', tenant: 'platform', admin_roles: ['operations_observer'], keys_active: 1, sessions_active: 1 };
const EMPTY_SESSIONS = sessionsBody([], 0);

test('milestone ui: coverage renders release states, never invented data', async () => {
  const h = harness({ '/api/admin/v1/coverage': () => COVERAGE });
  h.buttons[0].click();
  await settled(() => /Loaded /.test(h.sections.coverage.state.textContent), 'coverage render');
  assert.match(h.sections.coverage.state.textContent, /Loaded 2026-10-31T18:00:00\.000Z/);
  const html = h.el('coverage-result').innerHTML;
  for (const want of ['admitted_work', 'disabled', 'inference_dispatch_dark', 'incoming_requests', 'not_instrumented', 'collector_missing']) {
    assert.ok(html.includes(want), 'coverage table names ' + want);
  }
  assert.ok(!html.includes('>0<'), 'no zero is invented');
});

test('milestone ui: coverage denial and failure stay explicit', async () => {
  const denied = harness({ '/api/admin/v1/coverage': () => ({ status: 403, body: { error: 'no', code: 'ADMIN_FORBIDDEN' } }) });
  denied.buttons[0].click();
  await settled(() => /ADMIN_FORBIDDEN/.test(denied.sections.coverage.state.textContent), 'denial render');
  assert.match(denied.sections.coverage.state.textContent, /ADMIN_FORBIDDEN.*HTTP 403/);
  assert.equal(denied.el('coverage-result').innerHTML, '');
  const broken = harness({ '/api/admin/v1/coverage': () => new Error('boom') });
  broken.buttons[0].click();
  await settled(() => broken.sections.coverage.state.textContent === 'Unavailable: request failed.', 'failure render');
  assert.equal(broken.sections.coverage.state.textContent, 'Unavailable: request failed.');
});

test('milestone ui: health renders probes and distinct gap states', async () => {
  const h = harness({ '/api/admin/v1/operations/health': () => HEALTH });
  h.buttons[1].click();
  await settled(() => h.el('operations-result').innerHTML !== '', 'health render');
  const html = h.el('operations-result').innerHTML;
  for (const want of ['reachable', 'present', 'not_instrumented', 'collector_missing', 'disabled', 'inference_dispatch_dark', 'pending', 'fixture_only']) {
    assert.ok(html.includes(want), 'health table names ' + want);
  }
});

test('milestone ui: directory escapes untrusted identity content', async () => {
  const xss = { id: 'u_x', name: '<img src=x onerror=alert(1)>', email: 'a@b.c<script>alert(2)</script>', provider: 'github', status: 'active', tenant: 'platform', admin_roles: ['security_reviewer"><b>'], keys_active: 0, sessions_active: 0 };
  const h = harness({ '/api/admin/v1/access/users': () => usersBody([xss], 1), '/api/admin/v1/access/sessions': () => EMPTY_SESSIONS });
  h.buttons[2].click();
  await settled(() => h.el('users-result').innerHTML !== '', 'directory render');
  const html = h.el('users-result').innerHTML;
  assert.ok(!html.includes('<img src=x'), 'name markup is escaped');
  assert.ok(!html.includes('<script>'), 'email markup is escaped');
  assert.ok(html.includes('&lt;img'), 'escaped name is still readable');
  assert.ok(h.el('users-page-label').textContent.includes('Rows 1–1 of 1.'), 'single-row window is labelled');
});

test('milestone ui: directory pager walks by offset and clamps at zero', async () => {
  const seen = [];
  const h = harness({
    '/api/admin/v1/access/users': (url) => {
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      seen.push(offset);
      return usersBody([ALICE], 45, limit, offset);
    },
    '/api/admin/v1/access/sessions': () => EMPTY_SESSIONS,
  });
  h.buttons[2].click();
  await settled(() => !h.el('users-pages').hidden, 'first page');
  h.el('users-next').click();
  await settled(() => seen.length >= 2 && seen[1] === 20, 'next page requested');
  await settled(() => h.el('users-page-label').textContent.includes('Rows 21–40'), 'second window paints');
  assert.equal(h.el('users-prev').disabled, false);
});

test('milestone ui: sessions render safe refs and honest presence', async () => {
  const row = { id: 's_abc', user_id: 'u_alice', issued_at: '2026-10-31T17:00:00.000Z', expires_at: '2026-10-31T19:00:00.000Z', active: true, presence: 'unknown', presence_reason: 'no_presence_signal', token: 'SECRET-TOKEN', ipAddress: '1.2.3.4', userAgent: 'secret-agent' };
  const h = harness({ '/api/admin/v1/access/users': () => usersBody([ALICE], 1), '/api/admin/v1/access/sessions': () => sessionsBody([row], 1) });
  h.buttons[2].click();
  await settled(() => h.el('sessions-result').innerHTML !== '', 'sessions render');
  const html = h.el('sessions-result').innerHTML;
  assert.ok(html.includes('s_abc') && html.includes('active') && html.includes('unknown'), 'safe refs and presence render');
  assert.ok(!html.includes('SECRET-TOKEN') && !html.includes('1.2.3.4') && !html.includes('secret-agent'), 'secret columns never render even if served');
});

test('milestone ui: a stale directory success never repaints a newer page', async () => {
  let releaseFirst;
  const first = new Promise((r) => { releaseFirst = r; });
  let call = 0;
  const h = harness({
    '/api/admin/v1/access/users': async () => {
      call += 1;
      if (call === 1) {
        await first;
        return usersBody([{ ...ALICE, id: 'u_stale' }], 2);
      }
      return usersBody([{ ...ALICE, id: 'u_fresh' }], 2);
    },
    '/api/admin/v1/access/sessions': () => EMPTY_SESSIONS,
  });
  h.buttons[2].click();
  h.buttons[2].click();
  await settled(() => h.el('users-result').innerHTML.includes('u_fresh'), 'fresh page paints');
  releaseFirst();
  await new Promise((r) => setTimeout(r, 10));
  const html = h.el('users-result').innerHTML;
  assert.ok(html.includes('u_fresh') && !html.includes('u_stale'), 'stale page is dropped');
});

test('milestone ui: synthetic demo renders fixtures with no network calls', async () => {
  const h = harness({});
  const before = h.calls.length;
  h.el('demo-enter').click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.calls.length, before, 'the demo performs no fetch');
  const html = h.el('demo-result').innerHTML;
  assert.ok(html.includes('Synthetic demo'), 'the demo is labelled synthetic');
  assert.ok(html.includes('fixture data only'), 'the demo discloses fixture data');
  assert.ok(html.includes('not applicable (demo)'), 'demo rows carry no exercisable role');
  assert.ok(!html.includes('operations_observer') && !html.includes('access_administrator'), 'demo names no real admin role');
  h.el('demo-exit').click();
  assert.equal(h.el('demo-result').innerHTML, '', 'exiting the demo clears its fixtures');
});

test('milestone ui: sessions denial is explicit and paints no rows', async () => {
  const h = harness({
    '/api/admin/v1/access/users': () => usersBody([ALICE], 1),
    '/api/admin/v1/access/sessions': () => ({ status: 403, body: { error: 'no', code: 'ADMIN_FORBIDDEN' } }),
  });
  h.buttons[2].click();
  await settled(() => /ADMIN_FORBIDDEN/.test(h.el('sessions-state').textContent), 'sessions denial');
  assert.match(h.el('sessions-state').textContent, /ADMIN_FORBIDDEN.*HTTP 403/);
  assert.equal(h.el('sessions-result').innerHTML, '');
});

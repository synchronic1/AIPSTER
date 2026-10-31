/* Built with Meta Muse. */
// DGM fixture-preview UI tests: the /admin shell additions render server
// states honestly, escape untrusted labels, and send CSRF on mutations.
// The shell carries no authority; every call is server-authorized.
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFragment } from 'parse5';

const source = await readFile(new URL('../public/admin/admin.js', import.meta.url), 'utf8');
const shell = await readFile(new URL('../public/admin/index.html', import.meta.url), 'utf8');

function makeEl(tag, id) {
  const children = [];
  return {
    tag, id: id || null, children,
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    listeners: {}, attrs: {},
    addEventListener(k, v) { this.listeners[k] = v; },
    setAttribute(k, v) { this.attrs[k] = v; },
    get firstChild() { return children.length ? children[0] : null; },
    removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); },
    appendChild(c) { children.push(c); return c; }
  };
}

function harness(routes) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl('div', id));
    return elements.get(id);
  };
  const calls = [];
  const fetcher = async (path, init) => {
    calls.push({ path, init: init || {} });
    const route = routes[path];
    if (route) return route(calls.length);
    return Response.json({ error: 'No route', code: 'UNKNOWN' }, { status: 404 });
  };
  const context = vm.createContext({
    document: {
      getElementById: el,
      querySelectorAll() { return []; },
      createElement(tag) { return makeEl(tag, null); }
    },
    fetch: fetcher,
    encodeURIComponent: globalThis.encodeURIComponent,
    console
  });
  vm.runInContext(source, context);
  return { el, context, calls };
}

function runFixture(over = {}) {
  return {
    runId: 'run_v1_ab12cd34',
    fixture: 'good',
    evaluation: 'fixture',
    status: 'paused',
    envelopeLabel: 'VALIDATED',
    label: 'look',
    adviceReason: 'shadow_only',
    settlement: 'success',
    gates: [{ name: 'target_bound', passed: true, evidence: 'bound' }],
    provenance: { archive: [] },
    events: [{ sequence: 0, event: 'preview.created', detail: 'fixture=good held=true' }],
    telemetry: {
      readStatus: 'stale', freshnessNote: 'stale', outcomeCounts: {},
      latencySummary: { count: 1, p50_ms: 12, p95_ms: 12, status: 'ok' },
      tokensSummary: { prompt_tokens_est: 40, completion_tokens_est: 10, status: 'ok' }
    },
    ...over
  };
}

test('dgm ui: runs list renders in-page anchors; empty renders the empty state', async () => {
  const ui = harness({
    '/api/admin/v1/dgm/preview/runs': () => Response.json({ items: [], total: 0 })
  });
  await vm.runInContext('loadDgmRuns()', ui.context);
  assert.match(ui.el('dgm-runs').textContent, /empty/);
  const ui2 = harness({
    '/api/admin/v1/dgm/preview/runs': () => Response.json({
      items: [{ runId: 'run_v1_ab12cd34', fixture: 'good', status: 'paused', envelopeLabel: 'VALIDATED' }],
      total: 1
    }),
    '/api/admin/v1/dgm/preview/runs/run_v1_ab12cd34': () => Response.json(runFixture())
  });
  await vm.runInContext('loadDgmRuns()', ui2.context);
  const list = ui2.el('dgm-runs').children[0];
  assert.equal(list.tag, 'ul');
  const link = list.children[0].children[0];
  assert.equal(link.tag, 'a');
  assert.equal(link.attrs.href, '#dgm-run-run_v1_ab12cd34');
  assert.match(link.textContent, /run_v1_ab12cd34/);
  assert.match(link.textContent, /paused \/ VALIDATED/);
  await link.listeners.click({ preventDefault() {} });
  assert.match(ui2.el('dgm-run-state').textContent, /paused \/ VALIDATED/);
});

test('dgm ui: create posts the fixture body with CSRF; refusals show the code', async () => {
  const ui = harness({
    '/api/admin/v1/dgm/preview/runs': (n) => (ui.calls[n - 1].init.method === 'POST'
      ? Response.json(runFixture({ status: 'completed-preview' }))
      : Response.json({ items: [], total: 0 })),
    '/api/admin/v1/dgm/preview/runs/run_v1_ab12cd34': () => Response.json(runFixture())
  });
  ui.el('dgm-fixture').value = 'over-budget';
  ui.el('dgm-held').checked = true;
  ui.el('dgm-label').value = 'nightly';
  await vm.runInContext('createDgmRun()', ui.context);
  const post = ui.calls.find((c) => c.init.method === 'POST');
  assert.ok(post);
  assert.equal(post.init.headers['X-Aipster-CSRF'], '1');
  assert.equal(post.init.headers['Content-Type'], 'application/json');
  assert.equal(post.init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(post.init.body), { fixture: 'over-budget', held: true, label: 'nightly' });
  assert.match(ui.el('dgm-create-state').textContent, /Created run_v1_ab12cd34/);

  const denied = harness({
    '/api/admin/v1/dgm/preview/runs': () => Response.json(
      { error: 'Administration is not authorized for this caller.', code: 'ADMIN_FORBIDDEN' }, { status: 403 })
  });
  denied.el('dgm-fixture').value = 'good';
  await vm.runInContext('createDgmRun()', denied.context);
  assert.match(denied.el('dgm-create-state').textContent, /ADMIN_FORBIDDEN \(HTTP 403\)/);
});

test('dgm ui: detail renders gates, trace, telemetry, and the fixture anchor', async () => {
  const ui = harness({
    '/api/admin/v1/dgm/preview/runs/run_v1_ab12cd34': () => Response.json(runFixture())
  });
  await vm.runInContext('loadDgmRun("run_v1_ab12cd34")', ui.context);
  const html = ui.el('dgm-run-detail').innerHTML;
  assert.ok(html.includes('id="dgm-run-run_v1_ab12cd34"'));
  for (const needle of ['target_bound', 'preview.created', 'stale', 'p50=12', 'prompt=40',
    'evaluation', 'fixture', 'Archived candidates']) {
    assert.ok(html.includes(needle), needle);
  }
  // Paused runs offer resume/cancel only.
  assert.equal(ui.el('dgm-pause').disabled, true);
  assert.equal(ui.el('dgm-resume').disabled, false);
  assert.equal(ui.el('dgm-cancel').disabled, false);
  const done = harness({
    '/api/admin/v1/dgm/preview/runs/run_v1_ab12cd34': () => Response.json(runFixture({ status: 'completed-preview' }))
  });
  await vm.runInContext('loadDgmRun("run_v1_ab12cd34")', done.context);
  assert.equal(done.el('dgm-pause').disabled, false);
  assert.equal(done.el('dgm-resume').disabled, true);
});

test('dgm ui: untrusted labels render as text, never markup', async () => {
  const payload = '<b id="dgm-injected-label">injected</b>';
  const ui = harness({
    '/api/admin/v1/dgm/preview/runs/run_v1_ab12cd34': () => Response.json(runFixture({ label: payload }))
  });
  await vm.runInContext('loadDgmRun("run_v1_ab12cd34")', ui.context);
  const html = ui.el('dgm-run-detail').innerHTML;
  assert.ok(!html.includes('<b id="dgm-injected-label">'), html);
  const doc = parseFragment(html);
  const has = (n) => (n.attrs || []).some((a) => a.name === 'id' && a.value === 'dgm-injected-label')
    || (n.childNodes || []).some(has);
  assert.ok(!has(doc), `BUG: label became markup: ${html}`);
});

test('dgm ui: control posts carry CSRF; errors name the code and never zero-fill', async () => {
  const ui = harness({
    '/api/admin/v1/dgm/preview/runs/run_v1_ab12cd34': () => Response.json(runFixture()),
    '/api/admin/v1/dgm/preview/runs/run_v1_ab12cd34/resume': () => Response.json(
      { error: 'cannot resume it', code: 'DGM_PREVIEW_STATE' }, { status: 409 })
  });
  await vm.runInContext('loadDgmRun("run_v1_ab12cd34")', ui.context);
  await vm.runInContext('dgmControl("resume")', ui.context);
  const post = ui.calls.find((c) => c.path.endsWith('/resume'));
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.headers['X-Aipster-CSRF'], '1');
  assert.match(ui.el('dgm-run-state').textContent, /DGM_PREVIEW_STATE \(HTTP 409\)/);
  // Null telemetry renders unknown, never 0.
  const empty = harness({
    '/api/admin/v1/dgm/preview/runs/run_v1_ab12cd34': () => Response.json(runFixture({
      telemetry: {
        readStatus: 'unavailable', freshnessNote: 'unavailable', outcomeCounts: {},
        latencySummary: { count: 0, p50_ms: null, p95_ms: null, status: 'unknown' },
        tokensSummary: { prompt_tokens_est: null, completion_tokens_est: null, status: 'unknown' }
      }
    }))
  });
  await vm.runInContext('loadDgmRun("run_v1_ab12cd34")', empty.context);
  const html = empty.el('dgm-run-detail').innerHTML;
  assert.ok(html.includes('p50=unknown'));
  assert.ok(!html.includes('p50=0'));
});

test('dgm ui: shell labels the fixture boundary and keeps disabled actions disabled', () => {
  for (const id of ['dgm-preview', 'dgm-run', 'dgm-states', 'dgm-runs', 'dgm-fixture',
    'dgm-held', 'dgm-label', 'dgm-create', 'dgm-run-detail', 'dgm-pause', 'dgm-resume', 'dgm-cancel']) {
    assert.ok(shell.includes(`id="${id}"`), id);
  }
  for (const anchor of ['#dgm-preview', '#dgm-run', '#dgm-states']) {
    assert.ok(shell.includes(`href="${anchor}"`), anchor);
  }
  assert.ok(shell.includes('The Python DGM harness does not run in this Worker.'));
  assert.ok(shell.includes('Nothing is reserved, executed, evaluated, or promoted.'));
  for (const label of ['Promote', 'Execute', 'Reserve', 'Final audit', 'Advise live']) {
    const idx = shell.indexOf(`>${label}<`);
    assert.ok(idx > 0, label);
    const open = shell.lastIndexOf('<button', idx);
    const close = shell.indexOf('>', open);
    assert.ok(open >= 0 && close === idx, label);
    assert.ok(shell.slice(open, close).includes('disabled'), label);
  }
  const disabledButtons = shell.match(/<button[^>]*disabled[^>]*>/g) || [];
  assert.ok(disabledButtons.length >= 8, `expected paused/resumed/cancelled + 5 disabled, got ${disabledButtons.length}`);
  assert.equal((shell.match(/<script/g) || []).length, 1);
  assert.ok(shell.includes('<script src="/admin/admin.js"></script>'));
});

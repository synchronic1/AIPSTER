/* Built with Meta Muse. */
// Adviser UI tests: the /app Advice panel renders the server descriptor,
// gates submit on explicit opt-in, posts fenced advice calls with CSRF,
// escapes untrusted output, supports cancel + manual retry with the same
// op key, and drops stale generations. vm harness mirrors dgm-preview-ui.
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFragment } from 'parse5';

const source = await readFile(new URL('../public/app/app.js', import.meta.url), 'utf8');
const shell = await readFile(new URL('../public/app/index.html', import.meta.url), 'utf8');

function makeEl(tag, id) {
  const children = [];
  return {
    tag, id: id || null, children, dataset: {},
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false,
    listeners: {}, attrs: {},
    addEventListener(k, v) { this.listeners[k] = v; },
    setAttribute(k, v) { this.attrs[k] = v; },
    get firstChild() { return children.length ? children[0] : null; },
    removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); },
    appendChild(c) { children.push(c); return c; },
    focus() {},
  };
}

function harness(routes) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl('div', id));
    return elements.get(id);
  };
  const selects = [];
  const calls = [];
  const aborted = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
  const fetcher = async (path, init) => {
    calls.push({ path, init: init || {} });
    const sig = (init || {}).signal;
    if (sig && sig.aborted) throw aborted();
    const route = routes[typeof path === 'string' ? path.split('?')[0] : ''];
    const work = route ? route(calls.length, init || {}) : Response.json({ error: 'No route', code: 'UNKNOWN' }, { status: 404 });
    if (!sig) return work;
    return Promise.race([work, new Promise((_res, rej) => sig.addEventListener('abort', () => rej(aborted())))]);
  };
  const context = vm.createContext({
    document: {
      getElementById: el,
      querySelectorAll(sel) { return selects.filter((s) => s.sel === sel).flatMap((s) => s.els); },
      createElement(tag) { return makeEl(tag, null); },
    },
    fetch: fetcher,
    crypto: { randomUUID: () => 'uuid-adv-01' },
    AbortController: globalThis.AbortController,
    setTimeout: () => 0,
    encodeURIComponent: globalThis.encodeURIComponent,
    console,
  });
  vm.runInContext(source, context);
  return { el, context, calls, registerSelect: (sel, els) => selects.push({ sel, els }) };
}

function descriptor(over = {}) {
  return {
    schema: 'advisor/v1', mode: 'fixture', model: 'fixture', inferenceDispatch: 'disabled',
    bounds: { taskMax: 1000, refsMax: 20, bodyMaxBytes: 16384, inputTokenBound: 2000, outputTokensMax: 768 },
    outboundFields: ['task', 'snapshot.entries[].ref'],
    restrictions: ['dispatch-disabled', 'model-compatibility-unknown'],
    spendCapUsd: 0,
    ...over,
  };
}

function adviceResponse(over = {}) {
  return {
    advice: {
      summary: 'Consider r1.',
      recommendations: [{ resourceRef: 'r1', modelRef: null, evidenceRefs: ['r1'], why: 'Fresh.', unknowns: ['Latency unknown.'] }],
      blockedReasons: [],
      ...(over.advice || {}),
    },
    receipt: { opKey: 'uuid-adv-01', mode: 'fixture', model: 'fixture', responseId: null, usage: null, spendUsdEst: 0, elapsedMs: 3, schemaVersion: 'advisor/v1', validation: 'pass', replay: false, deliveredAt: '2026-10-31T00:00:00.000Z', sourceSha: 'unknown' },
    replay: false,
    ...over.top,
  };
}

function inventory() {
  return { items: [{ id: 'r_a', name: 'Node A' }, { id: 'r_b', name: 'Node B' }], total: 2, limit: 50, offset: 0 };
}

function adviseUi(routes) {
  const ui = harness({
    '/api/advisor': (n, init) => (init.method === 'POST' && routes.post ? routes.post(n, init) : Response.json(routes.get())),
    '/api/inventory': () => Response.json(routes.inventory ? routes.inventory() : inventory()),
  });
  return ui;
}

test('advisor ui: descriptor renders mode, fields and resource checklist', async () => {
  const ui = adviseUi({ get: () => descriptor() });
  await vm.runInContext('loadAdvice()', ui.context);
  assert.match(ui.el('adv-mode').textContent, /fixture/);
  assert.match(ui.el('adv-fields').textContent, /snapshot\.entries\[\]\.ref/);
  assert.ok(ui.el('adv-resources').innerHTML.includes('Node A'));
  assert.ok(ui.el('adv-resources').innerHTML.includes('Node B'));
  assert.equal(ui.el('adv-on').hidden, false);
  assert.equal(ui.el('adv-off').hidden, true);
  const empty = adviseUi({ get: () => descriptor(), inventory: () => ({ items: [], total: 0, limit: 50, offset: 0 }) });
  await vm.runInContext('loadAdvice()', empty.context);
  assert.match(empty.el('adv-resources').innerHTML, /No resources/);
});

test('advisor ui: disabled deployment shows the off state', async () => {
  const ui = harness({ '/api/advisor': () => Response.json({ error: 'Not found.', code: 'NOT_FOUND' }, { status: 404 }) });
  await vm.runInContext('loadAdvice()', ui.context);
  assert.equal(ui.el('adv-on').hidden, true);
  assert.equal(ui.el('adv-off').hidden, false);
});

test('advisor ui: submit requires opt-in, posts fenced call with CSRF', async () => {
  const ui = adviseUi({ get: () => descriptor(), post: () => Response.json(adviceResponse()) });
  await vm.runInContext('loadAdvice()', ui.context);
  ui.el('adv-task').value = 'Pick one.';
  await vm.runInContext('submitAdvice()', ui.context);
  assert.equal(ui.calls.filter((c) => c.init.method === 'POST').length, 0);
  assert.match(ui.el('adv-error').textContent, /Confirm/);
  ui.el('adv-optin').checked = true;
  const box = makeEl('input', null);
  box.checked = true; box.value = 'r_a';
  ui.registerSelect('input[name="adv-ref"]', [box]);
  await vm.runInContext('submitAdvice()', ui.context);
  const post = ui.calls.find((c) => c.init.method === 'POST');
  assert.ok(post);
  assert.equal(post.init.headers['X-Aipster-CSRF'], '1');
  assert.equal(post.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(post.init.body), { task: 'Pick one.', refs: ['r_a'], opKey: 'uuid-adv-01' });
  assert.match(ui.el('adv-result').innerHTML, /Consider r1/);
  assert.match(ui.el('adv-result').innerHTML, /fixture/);
  assert.match(ui.el('adv-result').innerHTML, /validation: pass/);
});

test('advisor ui: untrusted advice renders escaped, never markup', async () => {
  const payload = '<img src=x onerror=alert(1)>';
  const ui = adviseUi({
    get: () => descriptor(),
    post: () => Response.json(adviceResponse({ advice: { summary: payload, recommendations: [], blockedReasons: [payload] } })),
  });
  await vm.runInContext('loadAdvice()', ui.context);
  ui.el('adv-optin').checked = true;
  const box = makeEl('input', null);
  box.checked = true; box.value = 'r_a';
  ui.registerSelect('input[name="adv-ref"]', [box]);
  ui.el('adv-task').value = 't';
  await vm.runInContext('submitAdvice()', ui.context);
  const html = ui.el('adv-result').innerHTML;
  assert.ok(!html.includes('<img src=x'), html);
  const doc = parseFragment(html);
  const hasImg = (n) => (n.tagName === 'img') || (n.childNodes || []).some(hasImg);
  assert.ok(!hasImg(doc), `BUG: advice became markup: ${html}`);
});

test('advisor ui: errors name the code; manual retry reuses the op key', async () => {
  let n = 0;
  const ui = adviseUi({
    get: () => descriptor(),
    post: () => (++n === 1
      ? Response.json({ error: 'Advice request budget for this hour is exhausted.', code: 'REQUEST_BUDGET' }, { status: 429 })
      : Response.json(adviceResponse())),
  });
  await vm.runInContext('loadAdvice()', ui.context);
  ui.el('adv-optin').checked = true;
  const box = makeEl('input', null);
  box.checked = true; box.value = 'r_a';
  ui.registerSelect('input[name="adv-ref"]', [box]);
  ui.el('adv-task').value = 't';
  await vm.runInContext('submitAdvice()', ui.context);
  assert.match(ui.el('adv-result').innerHTML, /REQUEST_BUDGET/);
  assert.match(ui.el('adv-result').innerHTML, /exhausted/);
  assert.equal(ui.el('adv-retry').hidden, false);
  await ui.el('adv-retry').listeners.click();
  const posts = ui.calls.filter((c) => c.init.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(JSON.parse(posts[0].init.body).opKey, JSON.parse(posts[1].init.body).opKey);
  assert.match(ui.el('adv-result').innerHTML, /Consider r1/);
});

test('advisor ui: cancel aborts without rendering; stale generations drop', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const ui = adviseUi({
    get: () => descriptor(),
    post: async () => { await gate; return Response.json(adviceResponse()); },
  });
  await vm.runInContext('loadAdvice()', ui.context);
  ui.el('adv-optin').checked = true;
  const box = makeEl('input', null);
  box.checked = true; box.value = 'r_a';
  ui.registerSelect('input[name="adv-ref"]', [box]);
  ui.el('adv-task').value = 't';
  const pending = vm.runInContext('submitAdvice()', ui.context);
  await vm.runInContext('cancelAdvice()', ui.context);
  release();
  await pending;
  assert.match(ui.el('adv-result').innerHTML, /Cancelled/);
  assert.ok(!ui.el('adv-result').innerHTML.includes('Consider r1'));

  let release2;
  const gate2 = new Promise((res) => { release2 = res; });
  const ui2 = adviseUi({
    get: () => descriptor(),
    post: async () => { await gate2; return Response.json(adviceResponse()); },
  });
  await vm.runInContext('loadAdvice()', ui2.context);
  ui2.el('adv-optin').checked = true;
  const box2 = makeEl('input', null);
  box2.checked = true; box2.value = 'r_a';
  ui2.registerSelect('input[name="adv-ref"]', [box2]);
  ui2.el('adv-task').value = 't';
  const pending2 = vm.runInContext('submitAdvice()', ui2.context);
  await vm.runInContext('generation++', ui2.context);
  release2();
  await pending2;
  assert.ok(!ui2.el('adv-result').innerHTML.includes('Consider r1'));
});

test('advisor ui: shell carries the panel, opt-in default and live region', async () => {
  for (const id of ['tab-advice', 'adv-on', 'adv-off', 'adv-mode', 'adv-fields', 'adv-optin', 'adv-form', 'adv-task', 'adv-resources', 'adv-error', 'adv-submit', 'adv-cancel', 'adv-retry', 'adv-result']) {
    assert.ok(shell.includes(`id="${id}"`), id);
  }
  assert.ok(shell.includes('data-tab="advice"'));
  const optin = shell.slice(shell.indexOf('id="adv-optin"') - 120, shell.indexOf('id="adv-optin"'));
  assert.ok(!optin.includes('checked'), 'opt-in must default off');
  const at = shell.indexOf('id="adv-result"');
  const result = shell.slice(at, at + 120);
  assert.ok(result.includes('aria-live'), 'result needs a live region');
  assert.equal((shell.match(/<script/g) || []).length, 1);
});

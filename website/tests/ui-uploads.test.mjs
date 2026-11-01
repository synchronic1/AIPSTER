/* Built with Meta Muse. */
// Upload + My assets UI (Phase 2): exact client, real handlers, fixture
// memory store. Covers the full browser upload flow with fake File doubles,
// rejection rendering, private detail + compat, revalidate, and demo hiding.
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as deadline, clearTimeout as cancelDeadline } from 'node:timers';
import { hashPassword } from 'better-auth/crypto';
import { createTestEnv, readJson } from './d1-shim.mjs';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

async function makeUi({ asDemo = false } = {}) {
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
  if (asDemo) {
    const now = new Date().toISOString();
    await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, username, displayUsername, demo, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('u_demo_up', 'Demo', 'demoup@example.com', 0, null, 'demoup', 'demoup', 1, now, now).run();

    const hash = await hashPassword('demo-upload-password-01');
    await t.DB.prepare('INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('acc_demo_up', 'u_demo_up', 'credential', 'u_demo_up', hash, now, now).run();
    const res = await t.call('/api/auth/sign-in/username', { method: 'POST', body: { username: 'demoup', password: 'demo-upload-password-01' } });
    assert.equal(res.status, 200, (await readJson(res)).text);
    cookie = res.headers.getSetCookie().find((c) => c.startsWith('better-auth.session_token=')).split(';')[0];
  }
  const fetchImpl = async (fetchPath, opts = {}) => {
    const isBytes = opts.body instanceof ArrayBuffer || ArrayBuffer.isView(opts.body);
    return t.call(fetchPath, {
      method: opts.method ?? 'GET',
      headers: { Cookie: cookie, Origin: 'http://localhost:8787', ...opts.headers },
      body: opts.body && !isBytes ? JSON.parse(opts.body) : undefined,
      rawBody: isBytes ? opts.body : undefined,
    });
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
  // textContent/property changes emit no mutation: poll them directly.
  const pollProp = async (read, message) => {
    for (let i = 0; i < 400; i++) {
      const v = read();
      if (v) return v;
      await new Promise(setImmediate);
    }
    assert.fail(message);
  };
  return { t, el, logs, clickTab, flush, waitForDOM, pollProp };
}

const fakeFile = (name, bytes) => ({
  name, size: bytes.length, webkitRelativePath: '',
  slice: (a, b) => ({ arrayBuffer: async () => bytes.slice(a, b).buffer }),
});
const gguf = (n = 64) => new Uint8Array(n).fill(0x47);

async function uploadViaUi(ui, { name, kind = 'model', files, task = 'text-generation', format = 'gguf', license = 'apache-2.0' }) {
  ui.el('up-name').value = name;
  ui.el('up-kind').value = kind;
  ui.el('up-task').value = task;
  ui.el('up-format').value = format;
  ui.el('up-license').value = license;
  ui.el('up-files').files = files;
  ui.el('upload-form').listeners.submit({ preventDefault() {} });
}

test('empty My assets, then a full browser upload validates and lists', async () => {
  const ui = await makeUi();
  await ui.clickTab('models');
  await ui.waitForDOM(() => ui.el('my-assets').innerHTML.includes('No private assets yet'), 'empty state never rendered');
  await uploadViaUi(ui, { name: 'browser-gguf', files: [fakeFile('model.gguf', gguf())] });
  await ui.waitForDOM(() => ui.el('my-assets').innerHTML.includes('browser-gguf'), 'validated asset never listed');
  const html = ui.el('my-assets').innerHTML;
  assert.ok(html.includes('validated'), 'validation pill shows validated');
  assert.ok(html.includes('Revalidate'), 'revalidate action offered');
  assert.ok(ui.el('upload-progress').textContent.includes('Validated: browser-gguf'), 'progress announces the outcome');
});

test('rejected bytes render a safe error and list nothing', async () => {
  const ui = await makeUi();
  await ui.clickTab('models');
  await ui.waitForDOM(() => ui.el('my-assets').innerHTML.includes('No private assets yet'), 'empty state never rendered');
  const elf = new Uint8Array(32);
  elf.set([0x7f, 0x45, 0x4c, 0x46], 0);
  await uploadViaUi(ui, { name: 'evil', files: [fakeFile('model.gguf', elf)] });
  await ui.pollProp(() => ui.el('upload-error').hidden === false && ui.el('upload-error').textContent, 'rejection never surfaced');
  assert.ok(ui.el('upload-error').textContent.includes('ASSET_REJECTED'), 'safe rejection code shown');
  assert.ok(!ui.el('my-assets').innerHTML.includes('evil'), 'rejected bytes never list');
});

test('private detail opens from My assets and evaluates with the asset ref', async () => {
  const ui = await makeUi();
  const reg = await readJson(await ui.t.call('/api/inventory', { method: 'POST', headers: { ...ui.t.as(ui.t.alice), ...ui.t.csrf }, body: { name: 'n' } }));
  await ui.clickTab('models');
  await ui.waitForDOM(() => ui.el('my-assets').innerHTML.includes('No private assets yet'), 'empty state never rendered');
  await uploadViaUi(ui, { name: 'eval-me', files: [fakeFile('m.gguf', gguf(128))] });
  await ui.waitForDOM(() => ui.el('my-assets').innerHTML.includes('eval-me'), 'asset never listed');
  const id = /data-myasset="(priv:[^"]+)"/.exec(ui.el('my-assets').innerHTML)[1];
  ui.el('my-assets').onclick({ target: { dataset: { myasset: id } } });
  await ui.waitForDOM(() => ui.el('asset-detail').innerHTML.includes('Model card'), 'private detail never rendered');
  assert.ok(ui.el('asset-detail').innerHTML.includes('digest pending pinned resolve') || ui.el('asset-detail').innerHTML.includes('m.gguf'), 'manifest shown');
  for (let i = 0; i < 200; i++) {
    if (ui.el('compat-form').listeners.submit) break;
    await new Promise(setImmediate);
  }
  ui.el('compat-node').value = reg.json.id;
  ui.el('compat-runtime').value = 'fixture-llama';
  ui.el('compat-context').value = '512';
  ui.el('compat-concurrency').value = '1';
  ui.el('compat-form').listeners.submit({ preventDefault() {} });
  await ui.waitForDOM(() => ui.el('compat-out').innerHTML.includes('Decision:'), 'compat never rendered');
  assert.ok(ui.el('compat-out').innerHTML.includes('TELEMETRY_MISSING'), 'private asset follows the same unknown rule');
});

test('revalidate re-renders state; adapter fields toggle; demo hides upload', async () => {
  const ui = await makeUi();
  await ui.clickTab('models');
  await ui.waitForDOM(() => ui.el('my-assets').innerHTML.includes('No private assets yet'), 'empty state never rendered');
  await uploadViaUi(ui, { name: 'reval', files: [fakeFile('m.gguf', gguf())] });
  await ui.waitForDOM(() => ui.el('my-assets').innerHTML.includes('reval'), 'asset never listed');
  const id = /data-revalidate="(priv:[^"]+)"/.exec(ui.el('my-assets').innerHTML)[1];
  ui.el('my-assets').onclick({ target: { dataset: { revalidate: id } } });
  await ui.pollProp(() => ui.el('my-assets').innerHTML.includes('reval'), 'revalidate never re-rendered');
  ui.el('up-kind').value = 'adapter';
  ui.el('up-kind').listeners.change();
  assert.equal(ui.el('up-adapter-fields').hidden, false, 'adapter fields appear for adapter kind');
  ui.el('up-kind').value = 'model';
  ui.el('up-kind').listeners.change();
  assert.equal(ui.el('up-adapter-fields').hidden, true, 'adapter fields hide for model kind');
  const demo = await makeUi({ asDemo: true });
  await demo.clickTab('models');
  await demo.waitForDOM(() => demo.el('catalog-list').innerHTML.includes('fixture-org/'), 'demo search never rendered');
  assert.equal(demo.el('upload-form').hidden, true, 'demo gets no upload form');
});

/* Built with Meta Muse. Fixture pattern adapted from the F77 QA UI probes
 * (minimal DOM + exact checked-in client + real local handlers); assertions
 * below are the repaired denial/clearing behavior, not the reproductions. */
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { createTestEnv } from './d1-shim.mjs';

const APP_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app', 'app.js');
const DEMO_PASSWORD = 'ui-fixture-password-01';

async function makeUi({ holdKey = false, logoutFails = false, holdError = false, holdLogout = false, search = '', anonymous = false } = {}) {
  const source = await readFile(APP_JS, 'utf8');
  const t = await createTestEnv();
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, username, displayUsername, demo, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('u_demo', 'Synthetic Demo', 'demo@aipster.invalid', 0, null, 'demo', 'demo', 1, now, now).run();
  await t.DB.prepare('INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('acc_demo', 'u_demo', 'credential', 'u_demo', await hashPassword(DEMO_PASSWORD), now, now).run();

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
  // Initial document state mirrors public/app/index.html (signed-out shell).
  const names = ['overview', 'compute', 'shared', 'sharing', 'keys', 'usage', 'settings'];
  const tabs = names.map((name) => { const e = el('nav-' + name); e.dataset.tab = name; e.attrs['aria-selected'] = name === 'overview' ? 'true' : 'false'; return e; });
  names.forEach((name) => { el('tab-' + name).hidden = name !== 'overview'; });
  for (const id of ['view-app', 'sessionbar', 'key-reveal', 'banner', 'demo-banner', 'demo-grants-note', 'demo-keys-note',
    'login-error', 'demo-error', 'resource-error', 'grant-error', 'key-error', 'settings-error']) el(id).hidden = true;
  el('view-login').hidden = false;

  let cookie = anonymous ? '' : t.as(t.alice).Cookie;
  let keySecret = null, releaseKey, releaseError = null;
  let keySeenResolve;
  const keySeen = new Promise((resolve) => { keySeenResolve = resolve; });
  const keyHold = new Promise((resolve, reject) => { releaseKey = resolve; releaseError = reject; });
  let logoutSeenResolve, releaseLogout;
  const logoutSeen = new Promise((resolve) => { logoutSeenResolve = resolve; });
  const logoutHold = new Promise((resolve) => { releaseLogout = resolve; });
  const fetchImpl = async (fetchPath, opts = {}) => {
    if (fetchPath === '/api/auth/sign-out' && logoutFails) return Response.json({ error: 'Synthetic unavailable' }, { status: 503 });
    const res = await t.call(fetchPath, { method: opts.method ?? 'GET', headers: { Cookie: cookie, Origin: 'http://localhost:8787', ...opts.headers }, body: opts.body });
    if (fetchPath === '/api/auth/sign-out' && res.ok) {
      cookie = '';
      logoutSeenResolve();
      if (holdLogout) await logoutHold;
    }
    if (fetchPath === '/api/auth/sign-in/username' && res.ok) {
      cookie = res.headers.getSetCookie().find((c) => c.startsWith('better-auth.session_token=')).split(';', 1)[0];
    }
    if (fetchPath === '/api/keys' && opts.method === 'POST') {
      keySecret = (await res.clone().json()).secret;
      keySeenResolve();
      if (holdKey || holdError) await keyHold;
    }
    return res;
  };
  let replacedUrl = null;
  const context = vm.createContext({
    document: { getElementById: el, querySelectorAll(sel) { return sel === '[data-tab]' ? tabs : sel === '[role="tabpanel"]' ? names.map((n) => el('tab-' + n)) : []; } },
    location: { origin: 'http://localhost:8787', pathname: '/app/', search }, fetch: fetchImpl, setTimeout() { return 0; }, console,
    URLSearchParams,
    history: { replaceState(_a, _b, url) { replacedUrl = url; } }
  });
  await new vm.Script(source, { filename: 'exact-client.js' }).runInContext(context);
  const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
  await flush();
  const clickTab = async (name) => { tabs.find((e) => e.dataset.tab === name).listeners.click(); await flush(); };
  await clickTab('keys');
  const domText = () => [...elements.values()].map((e) => `${e.textContent}\n${e.innerHTML}\n${e.value}`).join('\n');
  return {
    el, tabs, t,
    secret: () => keySecret,
    keySeen, releaseKey, releaseError,
    logoutSeen, releaseLogout,
    clickTab,
    flush,
    createKey: () => el('key-form').listeners.submit({ preventDefault() {} }),
    logout: () => el('logout').listeners.click(),
    demoLogin: async () => {
      el('demo-username').value = 'demo';
      el('demo-password').value = DEMO_PASSWORD;
      await el('demo-form').listeners.submit({ preventDefault() {} });
      await flush();
    },
    replacedUrl: () => replacedUrl,
    sessionActive: async () => !!(await (await t.call('/api/auth/get-session', { headers: { Cookie: cookie } })).json())?.user,
    leaked: () => !!keySecret && domText().includes(keySecret),
    overviewSelected: () => tabs.find((e) => e.dataset.tab === 'overview').attrs['aria-selected'] === 'true'
  };
}

test('logout clears owner state before demo renders (no leak across switch)', async () => {
  const ui = await makeUi();
  ui.el('key-name').value = 'Synthetic owner key';
  ui.el('key-scope').value = 'inference';
  ui.el('grant-jobs').value = '7';
  await ui.createKey();
  assert.equal(ui.el('key-reveal').hidden, false, 'positive control: owner reveal visible');
  assert.ok(ui.leaked(), 'positive control: secret in DOM before logout');
  await ui.logout();
  assert.equal(ui.el('view-login').hidden, false, 'login view after logout');
  await ui.demoLogin();
  assert.equal(ui.el('view-app').hidden, false, 'demo app visible');
  assert.equal(ui.el('demo-banner').hidden, false, 'demo banner visible');
  assert.ok(ui.el('whoami').textContent.includes('demo'), 'identity switched');
  assert.equal(ui.el('key-reveal').hidden, true, 'reveal cleared');
  assert.equal(ui.el('key-secret').textContent, '', 'secret cleared');
  assert.ok(!ui.leaked(), 'no owner secret anywhere in DOM');
  assert.ok(ui.overviewSelected(), 'tab selection reset');
  assert.equal(ui.el('tab-overview').hidden, false);
  assert.equal(ui.el('tab-keys').hidden, true);
  assert.equal(ui.el('key-name').value, '', 'forms cleared');
  assert.equal(ui.el('key-scope').value, 'read', 'selects restored to defaults');
  assert.equal(ui.el('grant-jobs').value, '50');
  assert.equal(ui.el('demo-username').value, '', 'login fields cleared after use');
  assert.equal(ui.el('demo-password').value, '');
});

test('late owner key responses cannot repopulate demo UI', async () => {
  const ui = await makeUi({ holdKey: true });
  ui.el('key-name').value = 'Synthetic owner key';
  ui.el('key-scope').value = 'read';
  ui.el('key-expires').value = '';
  const pending = ui.createKey();
  await ui.keySeen;
  await ui.logout();
  await ui.demoLogin();
  ui.releaseKey();
  await pending;
  await ui.flush();
  assert.equal(ui.el('view-app').hidden, false, 'demo app visible');
  assert.equal(ui.el('key-reveal').hidden, true, 'stale reveal suppressed');
  assert.equal(ui.el('key-secret').textContent, '', 'stale secret suppressed');
  assert.ok(!ui.leaked(), 'no owner secret anywhere in DOM');
});

test('late owner failures render nothing after the switch', async () => {
  const ui = await makeUi({ holdError: true });
  ui.el('key-name').value = 'Synthetic owner key';
  ui.el('key-scope').value = 'read';
  ui.el('key-expires').value = '';
  const pending = ui.createKey();
  await ui.keySeen;
  await ui.logout();
  await ui.demoLogin();
  ui.releaseError(new Error('late owner failure'));
  await pending;
  await ui.flush();
  assert.equal(ui.el('key-error').hidden, true, 'stale error suppressed');
  assert.equal(ui.el('key-reveal').hidden, true);
  assert.equal(ui.el('banner').hidden, true, 'no stale banner');
});

// 4B edge 2: tab clicks during a successful logout cannot strand owner
// state: the server session is already gone when cleanup runs.
test('tab navigation during logout cannot strand owner state', async () => {
  const ui = await makeUi({ holdLogout: true });
  ui.el('key-name').value = 'Synthetic owner key';
  ui.el('key-scope').value = 'read';
  ui.el('key-expires').value = '';
  await ui.createKey();
  assert.equal(ui.el('key-reveal').hidden, false, 'positive control: owner reveal visible');
  const pending = ui.logout();
  await ui.logoutSeen;
  await ui.clickTab('compute');
  ui.releaseLogout();
  await pending;
  await ui.clickTab('keys');
  await ui.flush();
  const sessions = await ui.t.DB.prepare('SELECT COUNT(*) AS n FROM session WHERE userId = ?').bind(ui.t.alice.id).first();
  assert.equal(sessions.n, 0, 'server session ended');
  assert.equal(ui.el('view-login').hidden, false, 'login view shown');
  assert.equal(ui.el('view-app').hidden, true);
  assert.equal(ui.el('key-reveal').hidden, true, 'reveal cleared despite tab clicks');
  assert.equal(ui.el('key-secret').textContent, '');
  assert.ok(!ui.leaked(), 'no owner secret in DOM');
});

test('failed logout keeps the session and reports visibly', async () => {
  const ui = await makeUi({ logoutFails: true });
  await ui.logout();
  assert.equal(ui.el('view-login').hidden, true, 'stays signed in');
  assert.ok(ui.el('banner').textContent.startsWith('Sign-out failed:'), 'failure visible');
  assert.equal(await ui.sessionActive(), true, 'session intact');
});

test('OAuth callback errors surface on the login view with mapped copy', async () => {
  const ui = await makeUi({ anonymous: true, search: '?error=account_not_linked' });
  assert.equal(ui.el('view-login').hidden, false, 'stays on login');
  assert.equal(ui.el('login-error').hidden, false, 'error shown');
  assert.ok(ui.el('login-error').textContent.includes('different sign-in method'), ui.el('login-error').textContent);
  assert.ok(!ui.el('login-error').textContent.includes('account_not_linked'), 'mapped copy, not the raw code');
  assert.equal(ui.replacedUrl(), '/app/', 'error param cleared from the URL');
});

test('unverified-email callback error explains the requirement', async () => {
  const ui = await makeUi({ anonymous: true, search: '?error=NOT_VERIFIED&error_description=A+provider-verified+email+is+required.' });
  assert.equal(ui.el('login-error').hidden, false);
  assert.ok(ui.el('login-error').textContent.includes('verified email'), ui.el('login-error').textContent);
});

test('unknown callback errors fall back to a generic message', async () => {
  const ui = await makeUi({ anonymous: true, search: '?error=weird_provider_thing' });
  assert.equal(ui.el('login-error').textContent, 'GitHub sign-in failed. Please try again.');
});


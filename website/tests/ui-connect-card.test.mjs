// Installer-first "Connect your computer" onboarding: runs the exact
// checked-in client against real local handlers (same minimal-DOM pattern as
// ui-session). Asserts the friendly default view (primary installer action
// with honest per-platform unavailability, secondary agent-assisted setup),
// OS suggestion with manual correction, secret-free clipboard instructions
// with a selectable fallback, a progress stepper that never claims an
// unverified state, and no API/credential surface.
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'parse5';
import { createTestEnv } from './d1-shim.mjs';
import { checkPublic } from '../scripts/check.mjs';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
// Reviewed #17 head: worker requires a local token and validates Host/Origin.
const WORKER_COMMIT = '242c5300e0379d25bcb1624c67abc9806271d1df';
// Immutable docs revision; kept independent so docs can be corrected without moving the code pin.
const DOCS_COMMIT = '5c7fd1e326275b60946807cd6b083856e8448e9e';
const TREE = `https://github.com/synchronic1/AIPSTER/blob/${DOCS_COMMIT}/local-worker/`;
const EXPECTED_LINKS = [
  `${TREE}README.md`,
  `${TREE}README.md#tested-installation`,
  `${TREE}README.md#optional-real-engine-preparation-not-needed-for-the-mock-check`,
  `${TREE}README.md#stop-uninstall-and-troubleshoot`,
  `${TREE}VERIFICATION.md`,
  `${TREE}EXECUTION-GAPS.md`,
  'https://github.com/synchronic1/AIPSTER/pull/17',
  'https://github.com/synchronic1/AIPSTER/pull/20'
].sort();
const VULNERABLE_PIN = '7b38ba071d6a6f1520140486835f9d6a01adafab';
const COPIED_MESSAGE = 'Instructions copied. Paste them into ChatGPT, Claude, or your preferred local agent.';
const SECRET_SHAPED = /aip_[a-z0-9_]{8,}|gh[pousr]_|sk-[\w]{8,}|token=|secret=|key=|[?&](?:code|auth)=/i;

async function makeUi({ anonymous = false, platform, touchPoints = 0, clipboard = 'absent' } = {}) {
  const source = await readFile(path.join(PUBLIC, 'app', 'app.js'), 'utf8');
  const t = await createTestEnv();
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
  const names = ['overview', 'compute', 'shared', 'sharing', 'keys', 'usage', 'settings'];
  const tabs = names.map((name) => { const e = el('nav-' + name); e.dataset.tab = name; return e; });
  names.forEach((name) => { el('tab-' + name).hidden = name !== 'overview'; });
  for (const id of ['view-app', 'sessionbar', 'connect-card']) el(id).hidden = true;
  let cookie = anonymous ? '' : t.as(t.alice).Cookie;
  const calls = [];
  const fetchImpl = async (fetchPath, opts = {}) => {
    calls.push(`${opts.method ?? 'GET'} ${fetchPath}`);
    const res = await t.call(fetchPath, { method: opts.method ?? 'GET', headers: { Cookie: cookie, Origin: 'http://localhost:8787', ...opts.headers }, body: opts.body });
    if (fetchPath === '/api/auth/sign-out' && res.ok) cookie = '';
    return res;
  };
  const logs = [];
  const captured = [];
  let deferred = null;
  const clipboards = {
    absent: undefined,
    ok: { writeText: async (text) => { captured.push(text); } },
    fail: { writeText: async () => { throw new Error('denied'); } },
    deferred: { writeText: (text) => new Promise((resolve) => { deferred = () => { captured.push(text); resolve(); }; }) }
  };
  const globals = {
    document: { getElementById: el, querySelectorAll(sel) { return sel === '[data-tab]' ? tabs : sel === '[role="tabpanel"]' ? names.map((n) => el('tab-' + n)) : []; } },
    location: { origin: 'http://localhost:8787', pathname: '/app/', search: '' }, fetch: fetchImpl, setTimeout() { return 0; },
    console: { log: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a), info: (...a) => logs.push(a) },
    URLSearchParams, history: { replaceState() {} }
  };
  if (platform !== undefined || clipboard !== 'absent') {
    globals.navigator = { platform: platform ?? '', userAgentData: undefined, maxTouchPoints: touchPoints };
    if (clipboards[clipboard]) globals.navigator.clipboard = clipboards[clipboard];
  }
  const context = vm.createContext(globals);
  await new vm.Script(source, { filename: 'exact-client.js' }).runInContext(context);
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
  await flush();
  const clickTab = async (name) => { tabs.find((e) => e.dataset.tab === name).listeners.click(); await flush(); };
  const card = () => el('connect-card');
  const press = async (action) => { card().onclick({ target: { dataset: { action } } }); await flush(); };
  const chooseOs = async (value) => { card().onchange({ target: { dataset: { action: 'os' }, value } }); await flush(); };
  return {
    el, calls, logs, clickTab, flush, press, chooseOs, captured,
    resolveDeferred: async () => { deferred(); deferred = null; await flush(); },
    setClipboard: (mode) => { context.navigator.clipboard = clipboards[mode]; },
    logout: async () => { await el('logout').listeners.click(); await flush(); }
  };
}

function nodesOf(html) {
  const out = [];
  (function visit(n) { out.push(n); for (const c of n.childNodes || []) visit(c); })(parse(`<!doctype html><body>${html}</body>`));
  return out;
}
const textOf = (html) => nodesOf(html).filter((n) => n.nodeName === '#text').map((n) => n.value).join('').replace(/\s+/g, ' ');
const nodeText = (n) => (n.childNodes || []).map((c) => c.nodeName === '#text' ? c.value : nodeText(c)).join('').replace(/\s+/g, ' ').trim();
const attr = (n, name) => (n.attrs.find((x) => x.name === name) || {}).value;
const cardLinks = (html) => [...new Set(nodesOf(html).filter((n) => n.tagName === 'a').map((a) => attr(a, 'href')))].sort();

test('anonymous visitors never get the card', async () => {
  const ui = await makeUi({ anonymous: true });
  assert.equal(ui.el('view-app').hidden, true, 'signed-out shell stays on login');
  assert.equal(ui.el('connect-card').hidden, true);
  assert.equal(ui.el('connect-card').innerHTML, '', 'no onboarding markup without a session');
  assert.deepEqual(ui.calls, ['GET /api/auth/get-session']);
});

test('signed-in owner gets the installer-first default view, not a runbook', async () => {
  const ui = await makeUi({ platform: 'Win32', clipboard: 'ok' });
  assert.equal(ui.el('view-app').hidden, false, 'positive control: session restored');
  const before = ui.calls.length;
  await ui.clickTab('compute');
  const card = ui.el('connect-card');
  assert.equal(card.hidden, false);
  const nodes = nodesOf(card.innerHTML);
  const buttons = nodes.filter((n) => n.tagName === 'button');
  const actioned = buttons.filter((b) => attr(b, 'data-action'));
  assert.deepEqual(actioned.map((b) => attr(b, 'data-action')), ['copy-agent']);
  const copyBtn = actioned[0];
  assert.equal(attr(copyBtn, 'type'), 'button');
  assert.equal(nodeText(copyBtn), 'Set up with my agent');
  assert.ok(attr(copyBtn, 'class').split(' ').includes('secondary'));
  const primaryBtn = buttons.find((b) => !attr(b, 'data-action'));
  assert.ok(primaryBtn, 'primary action is present');
  assert.ok(primaryBtn.attrs.some((x) => x.name === 'disabled'), 'unavailable installer is a disabled action, not a fake download');
  assert.equal(nodeText(primaryBtn), 'Installer coming soon for Windows x64');
  const selects = nodes.filter((n) => n.tagName === 'select');
  assert.equal(selects.length, 1, 'one OS picker');
  assert.equal(attr(selects[0], 'data-action'), 'os');
  assert.equal(attr(selects[0], 'aria-describedby'), 'connect-os-note');
  assert.ok(nodes.some((n) => n.attrs && n.attrs.some((x) => x.name === 'id' && x.value === 'connect-os-note')), 'detection note is associated');
  const options = nodes.filter((n) => n.tagName === 'option');
  assert.deepEqual(options.map((o) => attr(o, 'value')), ['windows', 'macos', 'linux']);
  assert.equal(options.filter((o) => o.attrs.some((x) => x.name === 'selected')).map((o) => attr(o, 'value')).join(','), 'windows');
  assert.deepEqual(cardLinks(card.innerHTML), EXPECTED_LINKS, 'every destination is the public repo at the pinned commit');
  for (const a of nodes.filter((n) => n.tagName === 'a')) {
    assert.deepEqual(a.attrs.map((x) => x.name === 'class' ? 'class' : x.name).filter((n) => n !== 'class'), ['href'], 'plain links: no target/onclick/download attributes');
    assert.ok((a.childNodes.map((c) => c.value || '').join('').trim().length) > 3, 'links have descriptive visible text');
  }
  assert.ok(!card.innerHTML.includes('/archive/') && !/\.zip/i.test(card.innerHTML), 'no repository archive is offered or referenced');
  // The default view is a friendly action, not a developer manual: no command
  // runbook outside Advanced.
  const head = card.innerHTML.slice(0, card.innerHTML.indexOf('<details'));
  assert.ok(!head.includes('<pre') && !head.includes('git clone') && !head.includes('DENDRITE_API_TOKEN'), 'no runbook above Advanced');
  const text = textOf(card.innerHTML);
  for (const phrase of ['Connect your computer', 'Installer coming soon for Windows x64', 'Set up with my agent',
    'Installer for Windows x64:', 'not available', 'nothing to download', 'published as source only',
    'Setup needed', 'Installing', 'Pairing', 'Connected', 'You are here. Not connected.',
    'AIPSTER dispatch stays disabled, and nothing is shared unless you create a grant',
    'Advanced: manual install, source and troubleshooting', 'ganglion-dendrite 0.1.0', WORKER_COMMIT]) {
    assert.ok(text.includes(phrase), `missing: ${phrase}`);
  }
  // Only the existing inventory read happens; the card adds no API call.
  assert.deepEqual(ui.calls.slice(before), ['GET /api/inventory?limit=50']);
});

test('OS is suggested but correctable; wrong OS changes instructions honestly', async () => {
  const win = await makeUi({ platform: 'Win32', clipboard: 'ok' });
  await win.clickTab('compute');
  assert.ok(textOf(win.el('connect-card').innerHTML).includes('Detected: Windows. Change it if that is wrong.'));
  await win.press('copy-agent');
  assert.match(win.captured[0], /\.venv\\Scripts\\python\.exe test_installation\.py/);
  assert.ok(win.captured[0].includes('Windows x64 is the only tested platform'));

  // Unqualified platforms get "View supported platforms", never agent setup.
  const mac = await makeUi({ platform: 'MacIntel', clipboard: 'ok' });
  await mac.clickTab('compute');
  const macHtml = mac.el('connect-card').innerHTML;
  assert.ok(textOf(macHtml).includes('Detected: macOS. Change it if that is wrong.'));
  assert.ok(textOf(macHtml).includes('Installer for macOS: not available'));
  const macActions = nodesOf(macHtml).filter((n) => n.tagName === 'button').map((b) => attr(b, 'data-action')).filter(Boolean);
  assert.deepEqual(macActions, ['platforms'], 'no copy action on an unqualified platform');
  await mac.press('platforms');
  const platText = textOf(mac.el('connect-card').innerHTML);
  assert.ok(platText.includes('Supported platforms:'), 'platforms notice');
  assert.ok(platText.includes('agent setup is offered for Windows only'));
  assert.deepEqual(mac.captured, [], 'viewing platforms writes nothing to the clipboard');

  // Manual correction overrides detection everywhere (status, Advanced).
  await mac.chooseOs('linux');
  const linuxHtml = mac.el('connect-card').innerHTML;
  assert.ok(textOf(linuxHtml).includes('Installer for Linux: not available'));
  assert.ok(textOf(linuxHtml).includes('macOS / Linux: not qualified'));
  const linuxPre = nodesOf(linuxHtml.slice(linuxHtml.indexOf('<pre'), linuxHtml.indexOf('</pre>'))).filter((n) => n.nodeName === '#text').map((n) => n.value).join('');
  assert.ok(linuxPre.includes('.venv/bin/python test_installation.py'), 'Advanced follows the picked OS');
  assert.ok(linuxPre.includes('git sparse-checkout set --no-cone /local-worker/ /LICENSE'));
  await mac.chooseOs('windows');
  assert.deepEqual(nodesOf(mac.el('connect-card').innerHTML).filter((n) => n.tagName === 'button').map((b) => attr(b, 'data-action')).filter(Boolean), ['copy-agent'], 'agent setup returns on the qualified platform');

  // Detection unavailable: the tested platform is preselected and labelled.
  const unknown = await makeUi({ clipboard: 'ok' });
  await unknown.clickTab('compute');
  assert.ok(textOf(unknown.el('connect-card').innerHTML).includes('Detection unavailable in this browser'));
  const cros = await makeUi({ platform: 'CrOS x86_64', clipboard: 'ok' });
  await cros.clickTab('compute');
  assert.ok(textOf(cros.el('connect-card').innerHTML).includes('Detection unavailable in this browser'));

  // A bogus picker value changes nothing.
  await win.chooseOs('bogus');
  assert.ok(textOf(win.el('connect-card').innerHTML).includes('Installer for Windows x64: not available'));

  // Phones and tablets are directed to the computer they want to connect.
  for (const opts of [{ platform: 'Android' }, { platform: 'iPhone' }, { platform: 'MacIntel', touchPoints: 5 }]) {
    const mob = await makeUi({ ...opts, clipboard: 'ok' });
    await mob.clickTab('compute');
    const mobText = textOf(mob.el('connect-card').innerHTML);
    assert.ok(mobText.includes('Open AIPSTER on the computer you want to connect'), JSON.stringify(opts));
    assert.ok(nodesOf(mob.el('connect-card').innerHTML).some((n) => n.tagName === 'select'), 'picker stays available');
  }
});

test('agent setup copies pinned, secret-free instructions and confirms once', async () => {
  const ui = await makeUi({ platform: 'Win32', clipboard: 'ok' });
  await ui.clickTab('compute');
  const before = ui.calls.length;
  await ui.press('copy-agent');
  const text = textOf(ui.el('connect-card').innerHTML);
  assert.ok(text.includes(COPIED_MESSAGE), 'exact confirmation wording');
  assert.ok(text.includes('needs authorized access to this computer'), 'agent-access limit is stated');
  assert.equal(ui.captured.length, 1, 'one clipboard write per click');
  const instructions = ui.captured[0];
  const flat = instructions.replace(/\s+/g, ' ');
  for (const phrase of ['AIPSTER agent setup packet v1.', 'THIS computer', WORKER_COMMIT, 'ganglion-dendrite 0.1.0',
    'uv 0.12.12', '3.12.14', 'git sparse-checkout set --no-cone /local-worker/ /LICENSE',
    'the root LICENSE only', 'required by local-worker/LICENSING.md', 'install.py', 'test_installation.py',
    'DENDRITE_API_TOKEN', 'worker-LOCAL token', 'NOT an AIPSTER key',
    'these steps cover x64 only', 'no qualified instructions exist',
    'does NOT share this computer', 'does NOT enable inference', 'does NOT contact AIPSTER',
    'no pairing code or worker credential yet', 'A running worker is NOT proof of inference readiness',
    'delete local-worker/.venv', 'There is no automatic update']) {
    assert.ok(flat.includes(phrase), `missing: ${phrase}`);
  }
  assert.ok(!SECRET_SHAPED.test(instructions), 'no credential-shaped material in copied instructions');
  assert.ok(!/127\.0\.0\.1|localhost|C:\\Users/.test(instructions), 'no loopback literal or user path baked in');
  assert.deepEqual(ui.calls.slice(before), [], 'copying adds no API call');
  assert.equal(ui.el('connect-card').hidden, false, 'card stays visible after copying');
});

test('clipboard failure shows selectable instructions; retry recovers', async () => {
  const ui = await makeUi({ platform: 'Win32', clipboard: 'fail' });
  await ui.clickTab('compute');
  await ui.press('copy-agent');
  let html = ui.el('connect-card').innerHTML;
  let text = textOf(html);
  assert.ok(!text.includes(COPIED_MESSAGE), 'no false success claim');
  assert.ok(text.includes('would not let the page copy automatically'), 'honest failure reason');
  const areas = nodesOf(html).filter((n) => n.tagName === 'textarea');
  assert.equal(areas.length, 1, 'one selectable fallback');
  assert.ok(areas[0].attrs.some((x) => x.name === 'readonly'), 'fallback is read-only');
  const fallback = areas[0].childNodes.map((c) => c.value || '').join('');
  assert.ok(fallback.includes(WORKER_COMMIT) && fallback.includes('THIS computer'), 'fallback carries the complete instructions');
  assert.ok(!SECRET_SHAPED.test(fallback), 'fallback carries no credential-shaped material');
  assert.ok(text.includes('download them as a file'), 'file-download fallback is offered');
  const saveBtns = nodesOf(html).filter((n) => n.tagName === 'button' && attr(n, 'data-action') === 'save-instructions');
  assert.equal(saveBtns.length, 1, 'one Download instructions action');
  assert.equal(nodeText(saveBtns[0]), 'Download instructions');
  // The file download degrades silently where no DOM download exists.
  await ui.press('save-instructions');
  assert.equal(nodesOf(ui.el('connect-card').innerHTML).filter((n) => n.tagName === 'textarea').length, 1, 'fallback survives a download attempt');
  // Retry after the browser allows copying again.
  ui.setClipboard('ok');
  await ui.press('copy-agent');
  html = ui.el('connect-card').innerHTML;
  assert.ok(textOf(html).includes(COPIED_MESSAGE), 'retry succeeds');
  assert.equal(nodesOf(html).filter((n) => n.tagName === 'textarea').length, 0, 'fallback clears on success');

  // A missing clipboard API takes the same honest path.
  const bare = await makeUi({ platform: 'Win32' });
  await bare.clickTab('compute');
  await bare.press('copy-agent');
  assert.equal(nodesOf(bare.el('connect-card').innerHTML).filter((n) => n.tagName === 'textarea').length, 1);
});

test('unavailable installer is a disabled action with an explanation, never a download', async () => {
  const ui = await makeUi({ platform: 'Win32', clipboard: 'ok' });
  await ui.clickTab('compute');
  const before = ui.calls.length;
  const html = ui.el('connect-card').innerHTML;
  const text = textOf(html);
  assert.ok(text.includes('Installer coming soon for Windows x64'), 'disabled per-platform action');
  assert.ok(text.includes('not available') && text.includes('nothing to download'), 'visible explanation');
  assert.ok(!/Download installer/.test(text), 'no live download label while nothing exists');
  const linksBefore = cardLinks(html);
  await ui.press('download');
  assert.deepEqual(cardLinks(ui.el('connect-card').innerHTML), linksBefore, 'stale download action starts nothing');
  assert.deepEqual(ui.calls.slice(before), [], 'no API call');
});

test('progress never claims an unverified installed, paired or connected state', async () => {
  const ui = await makeUi({ platform: 'Win32', clipboard: 'ok' });
  await ui.clickTab('compute');
  await ui.press('copy-agent');
  const html = ui.el('connect-card').innerHTML;
  const text = textOf(html);
  for (const stage of ['Setup needed', 'Installing', 'Pairing', 'Connected']) {
    assert.ok(text.includes(stage), `missing stage: ${stage}`);
  }
  const progressHtml = html.match(/<ol class="progress"[\s\S]*?<\/ol>/)[0];
  const current = nodesOf(progressHtml).filter((n) => n.tagName === 'li' && n.attrs.some((x) => x.name === 'aria-current' && x.value === 'step'));
  assert.equal(current.length, 1, 'exactly one current stage');
  assert.ok(nodeText(current[0]).startsWith('Setup needed'), 'Setup needed is the current stage');
  const progressText = textOf(progressHtml);
  assert.ok(progressText.includes('Blocked: no verified installer is packaged yet.'));
  assert.ok(progressText.includes('Blocked:') && progressText.includes('heartbeat intake') && progressText.includes('not merged or deployed'));
  assert.ok(progressText.includes('Pairing is a separate contract and is not implemented.'));
  assert.ok(!/pairing support/i.test(progressText), 'heartbeat intake is never called pairing support');
  assert.ok(progressText.includes('Needs verified worker evidence. A download or a running worker is not proof.'));
  const rest = textOf(html.replace(progressHtml, ''));
  assert.ok(!/\bconnected\b/i.test(rest.replace(/not connected/gi, '')), 'never claims a connected state');
  assert.ok(!/\bready\b|\bonline\b/i.test(rest.replace(/offline/gi, '')), 'never claims readiness or liveness');
  assert.ok(!/in (a few|\d+) (minutes?|seconds?)/i.test(text), 'no unmeasured setup-time claim');
  assert.ok(html.includes('<span class="pill warn">Setup needed</span>'));
});

test('interrupted setup restarts cleanly and never paints after sign-out', async () => {
  const ui = await makeUi({ platform: 'Win32', clipboard: 'ok' });
  await ui.clickTab('compute');
  await ui.press('copy-agent');
  assert.ok(textOf(ui.el('connect-card').innerHTML).includes(COPIED_MESSAGE), 'positive control');
  await ui.clickTab('compute');
  const idle = textOf(ui.el('connect-card').innerHTML);
  assert.ok(!idle.includes(COPIED_MESSAGE), 'returning to the tab resets to the idle view');
  assert.ok(!ui.el('connect-card').innerHTML.includes('<textarea'), 'no stale fallback survives');
  // Changing OS also resets any in-progress notice.
  await ui.chooseOs('macos');
  await ui.press('platforms');
  assert.ok(textOf(ui.el('connect-card').innerHTML).includes('Supported platforms:'), 'positive control');
  await ui.chooseOs('windows');
  assert.ok(!textOf(ui.el('connect-card').innerHTML).includes('Supported platforms:'), 'OS change resets the notice');

  // A copy still in flight when the session ends paints nothing.
  const slow = await makeUi({ platform: 'Win32', clipboard: 'deferred' });
  await slow.clickTab('compute');
  slow.el('connect-card').onclick({ target: { dataset: { action: 'copy-agent' } } });
  await slow.logout();
  await slow.resolveDeferred();
  assert.equal(slow.el('connect-card').innerHTML, '', 'late clipboard result never repopulates a signed-out card');
  assert.equal(slow.el('connect-card').hidden, true);

  // A copy still in flight when the OS changes never reports for the new OS.
  const race = await makeUi({ platform: 'Win32', clipboard: 'deferred' });
  await race.clickTab('compute');
  race.el('connect-card').onclick({ target: { dataset: { action: 'copy-agent' } } });
  await race.chooseOs('linux');
  await race.resolveDeferred();
  const raced = textOf(race.el('connect-card').innerHTML);
  assert.ok(!raced.includes(COPIED_MESSAGE), 'stale clipboard result claims nothing');
  assert.ok(raced.includes('Installer for Linux: not available'), 'card stays on the newly picked OS');

  // Double-clicking copies once per settled write; the older write wins nothing.
  const twice = await makeUi({ platform: 'Win32', clipboard: 'deferred' });
  await twice.clickTab('compute');
  twice.el('connect-card').onclick({ target: { dataset: { action: 'copy-agent' } } });
  twice.el('connect-card').onclick({ target: { dataset: { action: 'copy-agent' } } });
  await twice.resolveDeferred();
  assert.equal(twice.captured.length, 1, 'only the latest write settles');
  assert.ok(textOf(twice.el('connect-card').innerHTML).includes(COPIED_MESSAGE));
});

test('logout removes the card and disarms its actions', async () => {
  const ui = await makeUi({ platform: 'Win32', clipboard: 'ok' });
  await ui.clickTab('compute');
  assert.notEqual(ui.el('connect-card').innerHTML, '', 'positive control');
  const staleClick = ui.el('connect-card').onclick;
  const staleChange = ui.el('connect-card').onchange;
  await ui.logout();
  assert.equal(ui.el('view-login').hidden, false);
  assert.equal(ui.el('connect-card').innerHTML, '');
  assert.equal(ui.el('connect-card').hidden, true);
  // Stale handlers from the previous session are inert: no cross-account paint.
  staleClick({ target: { dataset: { action: 'copy-agent' } } });
  staleChange({ target: { dataset: { action: 'os' }, value: 'linux' } });
  await ui.flush();
  assert.equal(ui.el('connect-card').innerHTML, '', 'post-logout actions paint nothing');
  assert.deepEqual(ui.captured, [], 'post-logout actions copy nothing');
});

test('card carries no credentials and nothing is logged', async () => {
  const ui = await makeUi({ platform: 'Win32', clipboard: 'fail' });
  await ui.clickTab('compute');
  await ui.press('copy-agent');
  const html = ui.el('connect-card').innerHTML;
  assert.ok(!SECRET_SHAPED.test(html), 'no credential-shaped material or query secrets, including the fallback');
  assert.ok(!/href="[^"]*\?/.test(html), 'no query strings in any destination');
  assert.ok(!html.includes(VULNERABLE_PIN) && !html.includes(VULNERABLE_PIN.slice(0, 7)), 'never points at the pre-#17 worker without local auth');
  assert.deepEqual(ui.logs, [], 'client logs nothing');
});

test('Advanced keeps the pinned manual commands, warnings and platform labels', async () => {
  const ui = await makeUi({ platform: 'Win32', clipboard: 'ok' });
  await ui.clickTab('compute');
  const html = ui.el('connect-card').innerHTML;
  const text = textOf(html);
  for (const phrase of ['refuses to start without DENDRITE_API_TOKEN', 'worker-local token',
    'It is not an AIPSTER API key or heartbeat key', 'never paste it into AIPSTER, a URL or a shared config',
    'security-fixed revision', 'Windows x64: tested', 'mock check only', 'macOS / Linux: not qualified',
    'untested', 'separate prerequisites', 'There is no pairing code or worker credential yet',
    'Disconnect and uninstall', 'Troubleshooting', 'not connected', 'worker and its root LICENSE only']) {
    assert.ok(text.includes(phrase), `missing: ${phrase}`);
  }
  const commands = nodesOf(html.slice(html.indexOf('<pre'), html.indexOf('</pre>'))).filter((n) => n.nodeName === '#text').map((n) => n.value).join('');
  const lines = commands.split('\n').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(lines, [
    'git clone --filter=blob:none --no-checkout https://github.com/synchronic1/AIPSTER.git',
    'cd AIPSTER',
    'git sparse-checkout set --no-cone /local-worker/ /LICENSE',
    `git fetch origin ${WORKER_COMMIT}`,
    `git checkout --detach ${WORKER_COMMIT}`,
    'cd local-worker',
    'uv run --no-project --python 3.12.14 python install.py',
    '.\\.venv\\Scripts\\python.exe test_installation.py',
    '$env:DENDRITE_API_TOKEN = .\\.venv\\Scripts\\python.exe -c "import secrets; print(secrets.token_urlsafe(32))"',
    '.\\.venv\\Scripts\\dendrite.exe serve --config configs/mock.toml'
  ]);
  assert.ok(!/aip_|AIPSTER_(?:API_)?KEY|X-Aipster|\/api\//.test(commands), 'no AIPSTER credential or endpoint in worker commands');
});

test('pinned Quick Start README matches the worker-only checkout and includes its required license', async () => {
  assert.notEqual(DOCS_COMMIT, WORKER_COMMIT, 'documentation and worker source have independent immutable pins');
  const readme = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../local-worker/README.md'), 'utf8');
  const block = readme.match(/From PowerShell[\s\S]*?```powershell([\s\S]*?)```/);
  assert.ok(block, 'README has a tested PowerShell installation block');
  assert.ok(block[1].includes('git sparse-checkout set --no-cone /local-worker/ /LICENSE'));
  assert.ok(block[1].includes(`git fetch origin ${WORKER_COMMIT}`));
  assert.ok(block[1].includes(`git checkout --detach ${WORKER_COMMIT}`));
  assert.match(readme, /sparse checkout contains the worker and the root `LICENSE` only/);
  assert.match(readme, /required by \[the licensing record\]\(LICENSING\.md\)/);
  assert.doesNotMatch(block[1], /git clone https:\/\/github\.com\/synchronic1\/AIPSTER\.git\s+cd AIPSTER\/local-worker/);
});

test('card placeholder sits in My Compute and the public policy still passes', async () => {
  const html = await readFile(path.join(PUBLIC, 'app', 'index.html'), 'utf8');
  const compute = html.slice(html.indexOf('<section id="tab-compute"'), html.indexOf('<section id="tab-shared"'));
  assert.match(compute, /<h1>My Compute<\/h1>\s*<section id="connect-card" class="card connect" aria-label="Connect your computer" hidden><\/section>/);
  const css = await readFile(path.join(PUBLIC, 'app', 'styles.css'), 'utf8');
  assert.match(css, /\.connect pre \{[^}]*overflow-x:auto/, 'long commands scroll inside the card, not the page');
  assert.match(css, /button\.btn \{[^}]*min-height:44px/, 'touch-sized card buttons');
  assert.match(css, /button\.btn\[disabled\] \{[^}]*cursor:not-allowed/, 'disabled installer action is visibly inert');
  assert.match(css, /\.connect \.progress/, 'progress stepper is styled');
  await checkPublic(PUBLIC);
});

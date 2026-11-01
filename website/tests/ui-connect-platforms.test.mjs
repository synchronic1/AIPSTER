// One-action platform setup: execute the shipped onboarding code without the
// application's API/session harness. All three OS targets expose the
// generate-and-copy prompt independently of installer availability; minting
// uses an injected deterministic fake (default: any API contact throws, so
// load/select paths prove they never call or copy).
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment } from 'parse5';

const client = await readFile(new URL('../public/app/app.js', import.meta.url), 'utf8');
const component = client.slice(client.indexOf('const WORKER_COMMIT ='), client.indexOf('async function loadCompute()'));

const FAKE_CODE = 'pair-SYNTHETIC-SETUP-001';
const FAKE_ID = 'p_synthetic001';
const FAKE_EXPIRY = '2100-01-01T00:00:00.000Z';
const fakeMintBody = (over = {}) => ({ id: FAKE_ID, code: FAKE_CODE, expiresAt: FAKE_EXPIRY, ...over });
const mintResponse = (body, status = 201) => new Response(JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } });
const SECRET_SHAPED = /aip_[a-z0-9_]{8,}|gh[pousr]_|sk-[\w]{8,}|token=|secret=|key=|[?&](?:code|auth)=/i;

function fixture(navigator, { clickFails = false, mint = null } = {}) {
  const card = { hidden: true, innerHTML: '', focused: [] };
  card.querySelector = (sel) => (sel.includes('textarea')
    ? { focus() { card.focused.push(sel); } }
    : { open: false });
  const downloaded = [];
  const revoked = [];
  const timers = [];
  const clipboard = [];
  const apiCalls = [];
  let blob;
  const context = vm.createContext({
    navigator, Blob, generation: 0, me: { id: 'synthetic-platform-owner', name: 'Synthetic Owner', email: 'synthetic@example.invalid', demo: false },
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    $: (id) => { assert.equal(id, 'connect-card'); return card; },
    fetch: async (fetchPath, init = {}) => {
      apiCalls.push({ path: fetchPath, method: init.method || 'GET', csrf: (init.headers || {})['X-Aipster-CSRF'], body: init.body });
      if (mint && fetchPath === '/api/pairing/codes' && (init.method || 'GET') === 'POST') return mint(fetchPath, init);
      throw new Error('Onboarding must not contact an API');
    },
    // The shipped api() lives outside the sliced component; this harness twin
    // keeps its wire contract (JSON body, code-suffixed errors) without its
    // CSRF injection, which the full-app card suite covers instead.
    api: async (apiPath, opts = {}) => {
      const res = await context.fetch(apiPath, opts);
      let data = null;
      try { data = await res.json(); } catch { /* non-JSON */ }
      if (!res.ok) {
        const code = data && data.code ? ` (${data.code})` : '';
        throw new Error((data && data.error ? data.error : `Request failed: ${res.status}`) + code);
      }
      return data;
    },
    setTimeout: (fn) => { timers.push(fn); },
    URL: {
      createObjectURL(value) { blob = value; return 'blob:synthetic-instructions'; },
      revokeObjectURL(value) { revoked.push(value); }
    },
    document: {
      body: { appendChild(anchor) { downloaded.push(anchor); } },
      createElement(tag) {
        assert.equal(tag, 'a');
        return { click() { if (clickFails) throw new Error('Fixture download denied'); this.clicked = true; }, remove() { this.removed = true; } };
      }
    }
  });
  new vm.Script(component).runInContext(context);
  const run = (code) => vm.runInContext(code, context);
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
  run('renderConnectCard()');
  return {
    card, context, clipboard, downloaded, revoked, timers, run, flush, apiCalls,
    pick: (os) => { run(`onConnectChange({ target: { dataset: { action: 'os' }, value: ${JSON.stringify(os)} } })`); return flush(); },
    press: async (action) => { run(`onConnectClick({ target: { dataset: { action: ${JSON.stringify(action)} } } })`); await flush(); },
    save: () => run('saveInstructions()'),
    blob: () => blob
  };
}

function controls(html) {
  const nodes = [];
  const visit = (node) => { nodes.push(node); for (const child of node.childNodes || []) visit(child); };
  visit(parseFragment(html));
  return nodes;
}
const buttons = (html) => controls(html).filter((n) => n.tagName === 'button');
const buttonWith = (html, action) => buttons(html).find((n) => (n.attrs || []).some((a) => a.name === 'data-action' && a.value === action));
const buttonText = (n) => (n.childNodes || []).map((c) => c.value || '').join('').replace(/\s+/g, ' ').trim();
const textOf = (html) => controls(html).filter((n) => n.nodeName === '#text').map((n) => n.value).join(' ').replace(/\s+/g, ' ');

test('all three OS targets expose the one-action prompt with no installer', async () => {
  for (const os of ['windows', 'macos', 'linux']) {
    const ui = fixture({ platform: 'Win32' });
    await ui.pick(os);
    const html = ui.card.innerHTML;
    const gen = buttonWith(html, 'gen-setup');
    assert.ok(gen, `${os}: generate action present`);
    assert.ok(!(gen.attrs || []).some((a) => a.name === 'disabled'), `${os}: generate action enabled`);
    assert.equal(buttonText(gen), 'Generate and copy setup prompt', `${os}: exact label`);
    assert.match(html, /Includes a temporary pairing code/, `${os}: pre-action disclosure`);
    assert.match(html, /Share only with your trusted installation agent/, `${os}: sharing boundary`);
    assert.match(html, /Synthetic Owner/, `${os}: account context shown`);
    assert.doesNotMatch(html, /View supported platforms/, `${os}: prompt never hides behind platforms`);
    assert.equal(ui.apiCalls.length, 0, `${os}: selecting never mints`);
  }
});

test('unpicked and mobile targets choose before acting', async () => {
  const ui = fixture({ userAgentData: { platform: 'Android', mobile: true }, platform: 'Linux armv8l' });
  assert.match(ui.card.innerHTML, /Choose a computer/, 'mobile asks for the target computer');
  assert.ok(!buttonWith(ui.card.innerHTML, 'gen-setup'), 'no action before a target');
  assert.doesNotMatch(ui.card.innerHTML, /data-action="gen-setup"|DENDRITE_API_TOKEN|PowerShell/);
  await ui.pick('macos');
  assert.ok(buttonWith(ui.card.innerHTML, 'gen-setup'), 'picked target enables the action');
  assert.match(ui.card.innerHTML, /You picked macOS as the target computer/, 'override is stated');
  assert.equal(ui.apiCalls.length, 0, 'choosing never mints');
});

test('installer status never hides the prompt', async () => {
  for (const [os, line] of [['windows', /nothing to download yet/], ['macos', /nothing to download/], ['linux', /nothing to download/]]) {
    const ui = fixture({ platform: 'Win32' });
    await ui.pick(os);
    assert.match(ui.card.innerHTML, line, `${os}: honest installer line`);
    assert.ok(buttonWith(ui.card.innerHTML, 'gen-setup'), `${os}: prompt available anyway`);
  }
});

test('packet carries the synthetic code in a delimited field with the selected shell only', async () => {
  const mint = async () => mintResponse(fakeMintBody());
  for (const [os, shell, posix] of [['windows', 'PowerShell', false], ['macos', 'Terminal', true], ['linux', 'a shell', true]]) {
    const captured = [];
    const ui = fixture({ platform: 'Win32', clipboard: { writeText: async (text) => captured.push(text) } }, { mint });
    await ui.pick(os);
    await ui.press('gen-setup');
    assert.equal(captured.length, 1, `${os}: one clipboard write`);
    assert.equal(ui.apiCalls.length, 1, `${os}: one mint`);
    assert.equal(ui.apiCalls[0].method, 'POST', `${os}: mint posts`);
    // CSRF injection belongs to the shipped api(); the card suite asserts it.
    assert.equal(JSON.parse(ui.apiCalls[0].body).ttlMinutes, 10, `${os}: default TTL`);
    const packet = captured[0];
    assert.match(packet, new RegExp(`PAIRING CODE: ${FAKE_CODE}`), `${os}: delimited code field`);
    assert.ok(!new RegExp(`--code\\s+${FAKE_CODE}`).test(packet), `${os}: code never interpolated into a command`);
    assert.match(packet, new RegExp(FAKE_EXPIRY), `${os}: expiry in packet`);
    assert.match(packet, /3fa309cb08461ea046ee23e801404911c1f3bcc2/, `${os}: worker pin`);
    assert.match(packet, new RegExp(shell.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${os}: shell label`);
    if (posix) {
      assert.match(packet, /\.venv\/bin\/python/, `${os}: posix interpreter`);
      assert.doesNotMatch(packet, /Scripts|\\\.venv\\|\$env:/, `${os}: no PowerShell paths`);
    } else {
      assert.match(packet, /\.venv\\Scripts\\python\.exe/, `${os}: windows interpreter`);
      assert.doesNotMatch(packet, /\.venv\/bin/, `${os}: no posix paths`);
    }
    // The worker-local token assignment is the documented local pattern (a fresh
    // random value, never an AIPSTER key); scrub only that known-safe line.
    const scrubbed = packet.replaceAll('DENDRITE_API_TOKEN=', 'LOCAL_TOKEN_ASSIGN=');
    assert.ok(!SECRET_SHAPED.test(scrubbed), `${os}: no long-lived credential shapes`);
    assert.match(packet, /x64 only|ARM64/, `${os}: architecture stop rule`);
    assert.match(packet, /usable=false/, `${os}: mock honesty`);
  }
});

test('qualification labels stay separate from prompt availability', async () => {
  const ui = fixture({ platform: 'Win32' });
  await ui.pick('macos');
  assert.match(ui.card.innerHTML, /not qualified|untested/i, 'macos adaptation labelled untested');
  await ui.pick('windows');
  assert.match(ui.card.innerHTML, /tested/, 'windows tested label kept');
  assert.ok(buttonWith(ui.card.innerHTML, 'gen-setup'), 'windows prompt available');
});

test('copy denial reports generated-not-copied; retry reuses the same packet', async () => {
  let mints = 0;
  const mint = async () => { mints++; return mintResponse(fakeMintBody()); };
  const ui = fixture({ platform: 'Win32', get clipboard() { throw new Error('Clipboard denied'); } }, { mint });
  await ui.pick('linux');
  await ui.press('gen-setup');
  let html = ui.card.innerHTML;
  assert.match(textOf(html), /Generated, not copied/, 'honest denial state');
  assert.doesNotMatch(textOf(html), /Setup prompt copied/, 'no false success');
  assert.equal(mints, 1, 'one mint');
  assert.match(html, /textarea/, 'selectable fallback shown');
  assert.match(html, new RegExp(FAKE_CODE), 'fallback carries the packet');
  Object.defineProperty(ui.context.navigator, 'clipboard', { configurable: true, writable: true, value: { writeText: async (text) => ui.clipboard.push(text) } });
  await ui.press('setup-copy');
  assert.equal(mints, 1, 'retry never remints');
  assert.equal(ui.clipboard.length, 1, 'retry writes once');
  assert.match(ui.clipboard[0], new RegExp(FAKE_CODE), 'retry writes the same packet');
  assert.match(textOf(ui.card.innerHTML), /Setup prompt copied/, 'retry success reported');
});

test('double generate coalesces into one mint', async () => {
  let mints = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const mint = async () => { mints++; await gate; return mintResponse(fakeMintBody()); };
  const captured = [];
  const ui = fixture({ platform: 'Win32', clipboard: { writeText: async (text) => captured.push(text) } }, { mint });
  await ui.pick('windows');
  const first = ui.press('gen-setup');
  const second = ui.press('gen-setup');
  await Promise.all([first, second]);
  release();
  await ui.flush();
  assert.equal(mints, 1, 'one mint for two clicks');
  assert.equal(captured.length, 1, 'one clipboard write');
});

test('stale mint after a target change is dropped, never written', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const mint = async () => { await gate; return mintResponse(fakeMintBody()); };
  const captured = [];
  const ui = fixture({ platform: 'Win32', clipboard: { writeText: async (text) => captured.push(text) } }, { mint });
  await ui.pick('windows');
  const gen = ui.press('gen-setup');
  await ui.pick('macos');
  release();
  await Promise.all([gen]);
  await ui.flush();
  assert.equal(ui.apiCalls.length, 1, 'mint was attempted, then dropped as stale');
  assert.equal(captured.length, 0, 'no clipboard write for the stale OS');
  assert.doesNotMatch(ui.card.innerHTML, new RegExp(FAKE_CODE), 'stale code never rendered');
  assert.doesNotMatch(textOf(ui.card.innerHTML), /Setup prompt copied/, 'no stale success claim');
});

test('malformed mint is an honest error with no clipboard write', async () => {
  for (const [name, body] of [['empty', {}], ['blank code', { id: 'p_x', code: '', expiresAt: FAKE_EXPIRY }],
    ['missing code', { id: 'p_x', expiresAt: FAKE_EXPIRY }], ['bad expiry', { id: 'p_x', code: FAKE_CODE, expiresAt: 'not-a-date' }],
    ['missing expiry', { id: 'p_x', code: FAKE_CODE }], ['missing id', { code: FAKE_CODE, expiresAt: FAKE_EXPIRY }]]) {
    const captured = [];
    const ui = fixture({ platform: 'Win32', clipboard: { writeText: async (text) => captured.push(text) } },
      { mint: async () => mintResponse(body) });
    await ui.pick('windows');
    await ui.press('gen-setup');
    assert.equal(captured.length, 0, `${name}: nothing written`);
    assert.match(textOf(ui.card.innerHTML), /failed|unusable/i, `${name}: honest error`);
    assert.doesNotMatch(textOf(ui.card.innerHTML), /Setup prompt copied/, `${name}: no success claim`);
  }
});

test('mint failures map honestly and never auto-retry', async () => {
  const cases = [
    ['active codes', 409, { error: 'Too many unused pairing codes (5 per user). Let one expire first.', code: 'PAIRING_LIMIT' }, /already|expire/i],
    ['rate limited', 429, { error: 'Too many changes in the last hour. Try again later.', code: 'WRITE_RATE_LIMITED' }, /wait|later|many/i],
    ['signed out', 401, { error: 'Sign-in required.', code: 'AUTH_REQUIRED' }, /sign.?in/i],
    ['restricted', 403, { error: 'Demo accounts cannot mint pairing codes.', code: 'DEMO_RESTRICTED' }, /demo|restricted|unavailable/i]
  ];
  for (const [name, status, body, message] of cases) {
    let mints = 0;
    const mint = async () => { mints++; return mintResponse(body, status); };
    const captured = [];
    const ui = fixture({ platform: 'Win32', clipboard: { writeText: async (text) => captured.push(text) } }, { mint });
    await ui.pick('windows');
    await ui.press('gen-setup');
    assert.equal(mints, 1, `${name}: single attempt`);
    assert.equal(captured.length, 0, `${name}: nothing written`);
    assert.match(textOf(ui.card.innerHTML), message, `${name}: mapped message`);
  }
  const throwing = fixture({ platform: 'Win32' }, {
    mint: async () => { throw new TypeError('network down'); }
  });
  await throwing.pick('windows');
  await throwing.press('gen-setup');
  assert.match(textOf(throwing.card.innerHTML), /may or may not|uncertain|try again/i, 'uncertain outcome is honest');
  assert.equal(throwing.apiCalls.length, 1, 'no automatic retry');
});

test('expired packet stops retry and offers explicit regeneration', async () => {
  let n = 0;
  const mint = async () => { n++; return mintResponse(fakeMintBody({ id: `p_${n}`, code: `pair-SYNTHETIC-${n}` })); };
  const captured = [];
  const ui = fixture({ platform: 'Win32', get clipboard() { throw new Error('denied'); } }, { mint });
  await ui.pick('windows');
  await ui.press('gen-setup');
  ui.run(`connect.setup.expiresAt = '2000-01-01T00:00:00.000Z'`);
  Object.defineProperty(ui.context.navigator, 'clipboard', { configurable: true, writable: true, value: { writeText: async (text) => captured.push(text) } });
  await ui.press('setup-copy');
  assert.equal(captured.length, 0, 'expired packet never written');
  assert.match(textOf(ui.card.innerHTML), /expired/i, 'expiry stated');
  assert.ok(buttonWith(ui.card.innerHTML, 'setup-again'), 'regeneration offered');
  await ui.press('setup-again');
  assert.equal(n, 2, 'explicit regeneration mints again');
  assert.equal(captured.length, 1, 'fresh packet written');
  assert.match(captured[0], /pair-SYNTHETIC-2/, 'fresh code in the new packet');
});

test('download fallback exports a redacted template, never the code', async () => {
  const ui = fixture({ platform: 'Win32', get clipboard() { throw new Error('Clipboard denied'); } },
    { mint: async () => mintResponse(fakeMintBody()) });
  await ui.pick('windows');
  await ui.press('gen-setup');
  ui.save();
  assert.equal(ui.downloaded.length, 1, 'one download');
  assert.equal(ui.downloaded[0].download, 'aipster-worker-setup.txt');
  const text = await ui.blob().text();
  assert.doesNotMatch(text, new RegExp(FAKE_CODE), 'downloaded template carries no code');
  assert.match(text, /redacted/i, 'redaction is labelled');
  assert.match(text, /git sparse-checkout set --no-cone \/local-worker\/ \/LICENSE/, 'template keeps the packet shape');
  assert.match(text, /ARM64 or any other\n  architecture, stop/, 'template keeps the stop rules');
  assert.ok(!SECRET_SHAPED.test(text), 'no credential shapes in the template');
  assert.equal(ui.timers.length, 1, 'revocation scheduled');
  ui.timers[0]();
  assert.deepEqual(ui.revoked, ['blob:synthetic-instructions']);
});

test('download rejection preserves the packet and reports failure without claiming progress', async () => {
  const ui = fixture({ platform: 'Win32', get clipboard() { throw new Error('denied'); } }, {
    clickFails: true, mint: async () => mintResponse(fakeMintBody())
  });
  await ui.pick('windows');
  await ui.press('gen-setup');
  const fallback = ui.run('connect.fallback');
  assert.match(fallback, new RegExp(FAKE_CODE), 'in-memory fallback keeps the packet');
  ui.save();
  assert.equal(ui.run('connect.fallback'), fallback, 'packet preserved');
  assert.match(ui.card.innerHTML, /file download failed in this browser/);
  assert.match(textOf(ui.card.innerHTML), /Authorizing: setup prompt generated/, 'mint progress is honest, nothing more');
  assert.deepEqual(ui.revoked, ['blob:synthetic-instructions']);
});

test('denied copy focuses the read-only fallback for keyboard users', async () => {
  const ui = fixture({ platform: 'Win32', get clipboard() { throw new Error('denied'); } },
    { mint: async () => mintResponse(fakeMintBody()) });
  await ui.pick('linux');
  await ui.press('gen-setup');
  const html = ui.card.innerHTML;
  const areas = controls(html).filter((n) => n.tagName === 'textarea');
  assert.equal(areas.length, 1, 'one selectable fallback');
  assert.ok((areas[0].attrs || []).some((a) => a.name === 'readonly'), 'fallback is read-only');
  assert.deepEqual(ui.card.focused, ['textarea.copy-fallback'], 'fallback takes focus');
  const retry = buttonWith(html, 'setup-copy');
  assert.ok(retry, 'keyboard-focusable retry control');
  assert.equal(buttonText(retry), 'Try copying again');
});

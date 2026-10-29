// Independent component fixture: execute the shipped onboarding code without
// the application's API/session harness. No browser, clipboard or network is used.
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment } from 'parse5';

const client = await readFile(new URL('../public/app/app.js', import.meta.url), 'utf8');
const component = client.slice(client.indexOf('const WORKER_COMMIT ='), client.indexOf('async function loadCompute()'));

function fixture(navigator, { clickFails = false } = {}) {
  const card = { hidden: true, innerHTML: '' };
  const downloaded = [];
  const revoked = [];
  const timers = [];
  const clipboard = [];
  let blob;
  const context = vm.createContext({
    navigator, Blob, generation: 0, me: { id: 'synthetic-platform-owner', demo: false },
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    $: (id) => { assert.equal(id, 'connect-card'); return card; },
    fetch: () => { throw new Error('Onboarding must not contact an API'); },
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
  run('renderConnectCard()');
  return {
    card, context, clipboard, downloaded, revoked, timers, run,
    pick: (os) => run(`onConnectChange({ target: { dataset: { action: 'os' }, value: ${JSON.stringify(os)} } })`),
    copy: () => run('copyAgentInstructions()'),
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

test('held-out platform metadata never exposes Windows commands on an unchosen target', async (t) => {
  const cases = [
    ['ChromeOS client hints', { userAgentData: { platform: 'Chrome OS', mobile: false }, platform: 'Linux x86_64' }, null],
    ['Android client hints', { userAgentData: { platform: 'Android', mobile: true }, platform: 'Linux armv8l' }, 'mobile'],
    ['iPad desktop UA', { platform: 'MacIntel', maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15' }, 'mobile'],
    ['reduced unsupported platform', { platform: '', userAgent: 'Mozilla/5.0' }, null],
    ['client hints unavailable', { get userAgentData() { throw new Error('Denied'); } }, null],
    ['navigator unavailable', undefined, null]
  ];
  for (const [name, nav, expected] of cases) await t.test(name, async () => {
    const ui = fixture(nav);
    assert.equal(ui.run('detectOs()'), expected);
    assert.equal(controls(ui.card.innerHTML).filter((n) => ['pre', 'details', 'textarea'].includes(n.tagName)).length, 0);
    assert.doesNotMatch(ui.card.innerHTML, /data-action="copy-agent"|DENDRITE_API_TOKEN|PowerShell/);
    await ui.copy();
    ui.save();
    assert.equal(ui.downloaded.length, 0);
    assert.doesNotMatch(ui.card.innerHTML, /textarea/);
    ui.pick('windows');
    await ui.copy();
    assert.match(ui.card.innerHTML, /textarea/, 'explicit target enables the selectable packet when clipboard is absent');
    assert.match(ui.card.innerHTML, /32\+ characters/);
    ui.pick('linux');
    await ui.copy();
    assert.doesNotMatch(ui.card.innerHTML, /textarea|data-action="copy-agent"/, 'changing to an unqualified target clears the Windows packet');
    ui.save();
    assert.equal(ui.downloaded.length, 0);
  });
});

test('held-out desktop client hints preserve qualified and unqualified target behavior', async (t) => {
  for (const [platform, expected, qualified] of [['Windows', 'windows', true], ['macOS', 'macos', false], ['Linux', 'linux', false]]) {
    await t.test(platform, async () => {
      const captured = [];
      const ui = fixture({ userAgentData: { platform, mobile: false }, clipboard: { writeText: async (text) => captured.push(text) } });
      assert.equal(ui.run('detectOs()'), expected);
      await ui.copy();
      assert.equal(captured.length, qualified ? 1 : 0);
      assert.match(ui.card.innerHTML, /nothing to download/);
      assert.match(ui.card.innerHTML, /not connected/i);
      assert.doesNotMatch(ui.card.innerHTML, /Download installer/);
    });
  }
});

test('instruction file contains exactly the fallback packet and releases its temporary URL', async () => {
  const ui = fixture({ platform: 'Win32', get clipboard() { throw new Error('Clipboard denied'); } });
  await ui.copy();
  const fallback = ui.run('connect.fallback');
  ui.save();
  assert.equal(ui.downloaded.length, 1);
  assert.equal(ui.downloaded[0].download, 'aipster-worker-setup.txt');
  assert.equal(ui.downloaded[0].clicked, true);
  assert.equal(ui.downloaded[0].removed, true);
  assert.equal(ui.blob().type, 'text/plain');
  assert.equal(await ui.blob().text(), fallback);
  assert.match(fallback, /git sparse-checkout set --no-cone \/local-worker\/ \/LICENSE/);
  assert.match(fallback, /ARM64 or any other\n  architecture, stop/);
  assert.doesNotMatch(fallback, /aip_[a-z0-9_]{8,}|gh[pousr]_|sk-[\w]{8,}/i);
  assert.equal(ui.timers.length, 1);
  ui.timers[0]();
  assert.deepEqual(ui.revoked, ['blob:synthetic-instructions']);
  assert.match(ui.card.innerHTML, /textarea/, 'download preserves the selectable fallback');
});

test('download rejection preserves the packet and reports failure without claiming progress', async () => {
  const ui = fixture({ platform: 'Win32' }, { clickFails: true });
  await ui.copy();
  const fallback = ui.run('connect.fallback');
  ui.save();
  assert.equal(ui.run('connect.fallback'), fallback);
  assert.match(ui.card.innerHTML, /file download failed in this browser/);
  assert.match(ui.card.innerHTML, /You are here\. Not connected\./);
  assert.deepEqual(ui.revoked, ['blob:synthetic-instructions']);
});

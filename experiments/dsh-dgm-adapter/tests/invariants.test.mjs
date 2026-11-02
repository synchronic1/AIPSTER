import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRequest } from '../src/adapter.mjs';
import { evaluate, verifyVerdict } from '../src/evaluate.mjs';
import { select } from '../src/selection.mjs';
import { AUTHORITY, DISABLED_ACTIONS, GATES, LIMITATIONS, VERDICT_STATUSES } from '../src/contract.mjs';
import { WORK_ITEMS } from '../fixtures/work-items.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function allVerdicts() {
  const out = [];
  for (const workItem of WORK_ITEMS) {
    for (const subject of ['baseline', 'candidate']) {
      const built = await buildRequest(workItem, { subject });
      assert.equal(built.ok, true);
      out.push({ workItem, request: built.request, verdict: await evaluate(workItem, built.request) });
    }
  }
  return out;
}

test('no verdict ever claims application or foreign authority', async () => {
  for (const { workItem, verdict } of await allVerdicts()) {
    assert.equal(verdict.applied, false, `${workItem.id} applied`);
    assert.equal(verdict.authority, AUTHORITY, `${workItem.id} authority`);
    assert.equal(verdict.receipt.applied, false, `${workItem.id} receipt applied`);
    assert.ok(VERDICT_STATUSES.includes(verdict.status), `${workItem.id} status ${verdict.status}`);
    assert.deepEqual(verdict.gates.map((entry) => entry.name), GATES);
    assert.equal(verdict.limitations.length, LIMITATIONS.length);
  }
});

test('every permanently disabled action stays disabled in the UI contract', () => {
  for (const action of ['apply', 'promote', 'execute', 'merge', 'open-pull-request']) {
    assert.equal(typeof DISABLED_ACTIONS[action], 'string', `${action} must be declared disabled`);
  }
  assert.equal(Object.isFrozen(DISABLED_ACTIONS), true);
});

test('a selected verdict still cannot be applied through any exported call', async () => {
  const built = await buildRequest(WORK_ITEMS[0]);
  const verdict = await evaluate(WORK_ITEMS[0], built.request);
  assert.equal(verdict.status, 'selected');

  const selection = await select([verdict], { fixtures: WORK_ITEMS });
  assert.equal(selection.ok, true);
  assert.equal(selection.selection.applied, false);
  assert.equal(selection.selection.rollback.applied, false);

  const verified = await verifyVerdict(verdict, WORK_ITEMS[0], built.request);
  assert.equal(verified.ok, true);
  assert.equal(verdict.applied, false);
});

// SPELLING GUARD ONLY. This scans source text for eight literal spellings. It
// does not constrain capability: `globalThis['fetch'](...)`, `new Date()`,
// `crypto.getRandomValues(...)`, `await import('node:fs')`, `(0, eval)(...)`,
// `new Function(...)` and `document.write(...)` all pass it, as the independent
// review of eeda53f demonstrated. The capability claim is tested at runtime, in
// `no-effect.test.mjs`, by denying the globals in a child process and running
// the whole sweep. Do not cite this test as containment.
test('the adapter source spells no obvious network, storage, process or clock call', async () => {
  const files = await readdir(join(root, 'src'));
  const forbidden = [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /localStorage|sessionStorage|indexedDB/,
    /node:child_process|child_process/,
    /writeFile|appendFile|mkdir/,
    /Date\.now\(/,
    /Math\.random\(/,
    /process\.env/
  ];

  for (const file of files.filter((name) => name.endsWith('.mjs'))) {
    const source = await readFile(join(root, 'src', file), 'utf8');
    for (const pattern of forbidden) {
      assert.equal(pattern.test(source), false, `${file} must not match ${pattern}`);
    }
  }
});

test('the fixture corpus is synthetic and free of live endpoints', async () => {
  const source = await readFile(join(root, 'fixtures', 'work-items.mjs'), 'utf8');
  assert.equal(/https?:\/\//.test(source), false, 'fixtures must not contain URLs');
  assert.equal(/github\.com\/[A-Za-z0-9-]+\/(?!dsh-fixture)/.test(source), false);
  assert.match(source, /example-org\/dsh-fixture/);
});

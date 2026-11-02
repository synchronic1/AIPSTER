// Runtime no-effect evidence.
//
// The independent review of eeda53f showed that a source-spelling scan is not a
// sandbox: eight of ten forbidden calls written in a different shape passed it.
// So the capability claim is tested here instead — in a child process whose
// globals are denied before the adapter is imported — and the source scan is
// described for what it is.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runMeasurement } from '../src/measure.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

async function inventory(directory) {
  const out = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const info = await stat(full);
        out.push(`${full.slice(root.length + 1)}:${info.size}`);
      }
    }
  };
  await walk(directory);
  return out.sort();
}

function runProbe() {
  const preload = pathToFileURL(join(here, 'no-effect-preload.mjs')).href;
  const probe = join(here, 'no-effect-probe.mjs');
  const result = spawnSync(process.execPath, ['--import', preload, probe], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000
  });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
    json: result.status === 0 ? JSON.parse(result.stdout.trim().split('\n').at(-1)) : null
  };
}

test('the delivered code path touches no denied capability at runtime', async () => {
  const before = await inventory(root);
  const probe = runProbe();
  assert.equal(probe.status, 0, `probe exited ${probe.status}: ${probe.stderr}`);

  const { json } = probe;
  assert.equal(json.probe_caught, true, 'the trap must catch globalThis["fetch"], which the spelling scan misses');
  assert.deepEqual(
    json.hits.filter((hit) => hit !== 'fetch:called-with-args'),
    [],
    'no clock, randomness, network, storage or environment write was observed'
  );
  assert.equal(json.env_unchanged, true);
  assert.equal(json.verdicts, 14);
  assert.equal(json.selected_status, 'selected');
  assert.equal(json.selection_ok, true);
  assert.equal(json.rollback_executed, false);

  // Denying the globals must not change behaviour: same report digest as the
  // ordinary in-process run.
  const inProcess = await runMeasurement({ replays: 1 });
  assert.equal(json.report_sha256, inProcess.report_sha256, 'traps must not alter the measurement');
  assert.equal(json.distinct_digests, 14);

  const after = await inventory(root);
  assert.deepEqual(after, before, 'the probe must not create, delete or resize any file');

  // The probe writes nothing; this test writes nothing; the fixtures are read-only.
  const fixtures = await readFile(join(root, 'fixtures', 'work-items.mjs'), 'utf8');
  assert.match(fixtures, /example-org\/dsh-fixture/);
});

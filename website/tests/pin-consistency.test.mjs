// R1: docs links must resolve to a README whose install pin equals the
// shipped worker pin, and must never instruct installing the blocked
// f3e115e client. Reads both pins from the exact checked-in app.js, then
// inspects the referenced README blob. Needs full git history
// (fetch-depth: 0 in CI). The update procedure may name f3e115e as the
// upgrade source; only install instructions are forbidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('docs README installs WORKER_COMMIT, never the blocked client', async () => {
  const appJs = await readFile(path.join(ROOT, 'website', 'public', 'app', 'app.js'), 'utf8');
  const worker = /const WORKER_COMMIT = '([0-9a-f]{40})';/.exec(appJs)?.[1];
  const docs = /const DOCS_COMMIT = '([0-9a-f]{40})';/.exec(appJs)?.[1];
  assert.ok(worker, 'WORKER_COMMIT pin found in app.js');
  assert.ok(docs, 'DOCS_COMMIT pin found in app.js');
  let readme;
  try {
    readme = execFileSync('git', ['show', `${docs}:local-worker/README.md`],
      { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  } catch (err) {
    assert.fail(`DOCS_COMMIT ${docs} not reachable for git show (needs fetch-depth: 0): ${err.message}`);
  }
  assert.ok(readme.includes(`checkout --detach ${worker}`),
    'linked README installs WORKER_COMMIT');
  assert.ok(!readme.includes('checkout --detach f3e115e'),
    'linked README never checks out the blocked client');
  assert.ok(!readme.includes('fetch origin f3e115e'),
    'linked README never fetches the blocked client');
});

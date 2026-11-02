/* Export acceptance: receipt parity, labels, no-network, no live claims. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../demo/federation-two-user/export');
const html = readFileSync(path.join(DIR, 'EXPORT_federation-two-user.html'), 'utf8');
const receipt = readFileSync(path.join(DIR, 'EXPORT-RECEIPT.md'), 'utf8');

const ROOT = path.resolve(DIR, '../../../..');
const REVIEWED_SOURCE = [
  'website/demo/federation-two-user/run.mjs',
  'website/demo/federation-two-user/render.mjs'
];
/* Pinned as the reviewed demo-source commit; used when git history is
 * unavailable (shallow clone) so the assertion still catches drift. */
const PINNED_SOURCE_SHA = '5fee28ea307f95fa587048452cd1312fff59e18a';

function reviewedSourceSha() {
  try {
    const sha = execFileSync('git', ['log', '-1', '--format=%H', '--', ...REVIEWED_SOURCE],
      { cwd: ROOT, encoding: 'utf8' }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : PINNED_SOURCE_SHA;
  } catch {
    return PINNED_SOURCE_SHA;
  }
}

test('export receipt matches the exported HTML byte-for-byte', () => {
  const bytes = Buffer.byteLength(html, 'utf8');
  const sha256 = createHash('sha256').update(html, 'utf8').digest('hex');
  assert.match(receipt, new RegExp(`Byte count \\(UTF-8\\): ${bytes}`));
  assert.match(receipt, new RegExp(`SHA-256 of export HTML: ${sha256}`));
  assert.match(receipt, new RegExp(`Source SHA \\(reviewed demo files\\): ${reviewedSourceSha()}`));
  assert.match(receipt, /node website\/demo\/federation-two-user\/render-export\.mjs/);
});

test('export preserves synthetic labeling, reasons and no-live-claims', () => {
  for (const doc of [html, receipt]) {
    assert.match(doc, /SYNTHETIC\/FIXTURE/);
    assert.match(doc, /NOT SHOWN LIVE/);
  }
  assert.match(html, /additionally need/);
  assert.match(receipt, /no fetch, no listen|No-network|no-network/i);
  assert.match(receipt, /Rollback: delete `website\/demo\/federation-two-user\/export\/`/);
  assert.doesNotMatch(html, /production grant|live peer|real user sharing|two-user sharing claim/i);
  assert.doesNotMatch(html, /<script/i);
  // Byte-stability: per-run random ids (fg_/appr_/conn_ + hex) must not reach
  // the export; the audit list is deterministic per-path counts.
  assert.doesNotMatch(html, /(fg|appr|conn)_[0-9a-f]{8,}/);
  assert.match(html, /"POST \/v1\/fabric\/nodes":\d+/);
  assert.match(html, /"POST \/v1\/fabric\/grants\/fg_&lt;id&gt;\/revoke":1/);
  assert.match(receipt, /Reproducibility: the export is byte-stable/);
});

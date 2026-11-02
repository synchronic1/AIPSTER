/* Export acceptance: receipt parity, labels, no-network, no live claims. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../demo/federation-two-user/export');
const html = readFileSync(path.join(DIR, 'EXPORT_federation-two-user.html'), 'utf8');
const receipt = readFileSync(path.join(DIR, 'EXPORT-RECEIPT.md'), 'utf8');

test('export receipt matches the exported HTML byte-for-byte', () => {
  const bytes = Buffer.byteLength(html, 'utf8');
  const sha256 = createHash('sha256').update(html, 'utf8').digest('hex');
  assert.match(receipt, new RegExp(`Byte count \\(UTF-8\\): ${bytes}`));
  assert.match(receipt, new RegExp(`SHA-256 of export HTML: ${sha256}`));
  assert.match(receipt, /Source SHA \(reviewed demo files\): [0-9a-f]{40}/);
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
});

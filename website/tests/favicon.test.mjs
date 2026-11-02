import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// The landing favicon must be the stylized 'Ai' reused from the official
// AIPSTER wordmark — not the previous generic-A glyph and not redrawn
// lettering. These tests pin that requirement against the brand source.
const pub = resolve(import.meta.dirname, '../public');
const favicon = await readFile(resolve(pub, 'favicon.svg'), 'utf8');
const wordmark = await readFile(resolve(pub, 'assets/aipster-wordmark-on-dark.svg'), 'utf8');

const aiPath = wordmark.match(/<path fill="#F2B887" d="([^"]+)"\/>/)?.[1];
assert(aiPath, 'on-dark wordmark must carry the apricot Ai path');

test('favicon reuses the official stylized Ai geometry', () => {
  // Anchor fragments: A counter opening and i-dot opening of the Ai path.
  for (const fragment of ['M50.537109375 45.849609375', 'M105.2734375 6.25']) {
    assert(aiPath.includes(fragment), 'brand source must contain Ai fragment');
    assert(favicon.includes(fragment), 'favicon must reuse Ai fragment');
  }
  // The whole Ai path data must appear verbatim (placement differs, geometry does not).
  assert(favicon.includes(`d="${aiPath}"`), 'favicon must embed the Ai path data unchanged');
});

test('favicon uses the official on-dark Ai colorway', () => {
  assert(favicon.includes('fill="#F2B887"'), 'Ai must use the on-dark apricot fill');
  assert(favicon.includes('<rect width="64" height="64" rx="14" fill="#143b34"/>'),
    'deep-green rounded-square ground must be preserved');
});

test('generic-A glyph is gone', () => {
  assert(!favicon.includes('m16 47 13-31h6l13 31h-7l-3-8H26l-3 8zm12-14h8l-4-11z'),
    'previous generic-A path must not remain');
});

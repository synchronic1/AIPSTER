/* Built with Meta Muse. */
// Minimal JSON canonicalization (RFC 8785 subset) + SHA-256 digests for
// federation approval binding. Single-implementation profile: object keys
// sorted in UTF-16 code-unit order, no whitespace, UTF-8 encoding. Numbers
// pass through JSON.stringify (integers exact). No duplicate keys can arise
// from parsed JSON. Full RFC 8785 number/unicode normalization is deferred
// until a second implementation needs interop (see F0 architecture).
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function digestJson(value) {
  return sha256Hex(canonicalize(value));
}

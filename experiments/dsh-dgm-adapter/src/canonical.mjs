// Canonical JSON and SHA-256 identities.
//
// Dependency-free and identical in Node >= 20 and browsers: both expose
// globalThis.crypto.subtle. Canonical form is the one used for every digest in
// this experiment: JSON-safe values only, object keys sorted, no whitespace.
// Nothing here reads the clock or randomness, so the same input always yields
// the same digest.

const encoder = new TextEncoder();

function fail(message) {
  throw new TypeError(message);
}

function assertJsonSafe(value, path, seen) {
  if (value === null) return;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return;
  if (kind === 'number') {
    if (!Number.isFinite(value)) fail(`${path} must be a finite number`);
    return;
  }
  if (kind !== 'object') fail(`${path} is not JSON-safe (${kind})`);
  if (seen.has(value)) fail(`${path} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === undefined) fail(`${path}[${i}] is undefined`);
      assertJsonSafe(value[i], `${path}[${i}]`, seen);
    }
    seen.delete(value);
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail(`${path} must be a plain object`);
  }
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) fail(`${path}.${key} is undefined`);
    assertJsonSafe(value[key], `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function write(value) {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean' || kind === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(write).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${write(value[key])}`).join(',')}}`;
}

/** Canonical JSON text for a JSON-safe value. Throws on anything JSON cannot represent. */
export function canonicalJson(value) {
  assertJsonSafe(value, 'value', new Set());
  return write(value);
}

/** SHA-256 hex digest of a UTF-8 string. */
export async function sha256Hex(text) {
  if (typeof text !== 'string') fail('sha256Hex expects a string');
  const bytes = encoder.encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Digest over the canonical JSON form of a value. */
export async function digestOf(value) {
  return sha256Hex(canonicalJson(value));
}

/** Deterministic, prefixed identifier derived from a digest. */
export function idFromDigest(prefix, digest, length = 24) {
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    fail('idFromDigest expects a 64-char lowercase hex digest');
  }
  return `${prefix}_${digest.slice(0, length)}`;
}

/** Seal a record: returns a copy with `<field>` set to its own digest. */
export async function seal(record, field = 'sha256') {
  const body = { ...record };
  delete body[field];
  return { ...body, [field]: await digestOf(body) };
}

/** Verify a sealed record without throwing; returns a discriminated result. */
export async function verifySeal(record, field = 'sha256') {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, reason: 'NOT_AN_OBJECT' };
  }
  const claimed = record[field];
  if (typeof claimed !== 'string' || !/^[0-9a-f]{64}$/.test(claimed)) {
    return { ok: false, reason: 'MISSING_DIGEST' };
  }
  const body = { ...record };
  delete body[field];
  const actual = await digestOf(body);
  return actual === claimed
    ? { ok: true, digest: actual }
    : { ok: false, reason: 'DIGEST_MISMATCH', claimed, actual };
}

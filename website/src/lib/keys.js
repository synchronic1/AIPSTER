/* Built with Meta Muse. */
// API-key lifecycle: strong random secrets, one-time reveal, salted
// non-reversible verifiers. WebCrypto port (no node:crypto). Secrets never
// appear in list/detail/logs. Production prefix aip_live_ differs from the
// local demo prefix so demo keys are never valid here.
export const KEY_PREFIX = 'aip_live_';
export const DEMO_KEY_PREFIX = 'aip_demo_';

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

export function mintKey(prefix = KEY_PREFIX) {
  const idBytes = crypto.getRandomValues(new Uint8Array(8));
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  const id = 'k_' + bytesToHex(idBytes);
  const secret = bytesToBase64Url(secretBytes);
  const short = secret.slice(0, 6);
  return { id, secret: `${prefix}${id}_${secret}`, short };
}

export function verifierFor(secret, salt) {
  return sha256Hex(salt + ':' + secret);
}

export function publicKey(row) {
  // Safe projection: never includes verifier, salt, or secret.
  const { verifier, salt, ...rest } = row;
  return rest;
}

export function splitPresented(presented) {
  if (typeof presented !== 'string') return null;
  const prefix = presented.startsWith(KEY_PREFIX) ? KEY_PREFIX
    : presented.startsWith(DEMO_KEY_PREFIX) ? DEMO_KEY_PREFIX : null;
  if (!prefix) return null;
  const m = /^(k_[0-9a-f]{16})_(.+)$/.exec(presented.slice(prefix.length));
  if (!m) return null;
  return { id: m[1], secret: presented, demo: prefix === DEMO_KEY_PREFIX };
}

// Constant-time string compare (no timingSafeEqual in Workers).
export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

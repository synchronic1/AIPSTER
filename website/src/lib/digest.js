/* Built with Meta Muse. */
// Canonical digests: stable-key JSON serialization plus SHA-256 hex, for
// idempotency keys, request/candidate digests and snapshot pins. Moved here
// from the adviser validator so routing and advice share one implementation.

/** Canonical SHA-256 hex of a JSON value (stable key order). */
export async function canonicalDigest(value) {
  const stable = (v) => {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
    return JSON.stringify(v) ?? 'null';
  };
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(value)));
  return Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, '0')).join('');
}

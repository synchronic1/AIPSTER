/* Built with Meta Muse. */
// Shared capability-token discipline: resource capabilities_json is
// free-form owner text, so anything crossing into a model envelope, prompt
// or descriptor must pass this allowlist. One implementation for adviser
// snapshots and routing descriptors so the boundary cannot drift.
export const CAP_TOKEN = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function filterCapTokens(raw, { max = 10, pattern = CAP_TOKEN } = {}) {
  let arr;
  try { arr = JSON.parse(raw || '[]'); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const c of arr) {
    if (typeof c === 'string' && pattern.test(c)) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

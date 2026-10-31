/* Built with Meta Muse. */
// Byte persistence behind one interface. Production uses the bound R2
// bucket (env.CATALOG_STORE). Fixture environments (tests + local fixture
// renders ONLY) use an ephemeral per-isolate memory map that never leaves
// the process. There is no third path: without a bound store,
// writes report STORAGE_UNPROVISIONED instead of pretending to persist.
import { isFixtureEnv } from './hub.mjs';

export const CHUNK_MAX_BYTES = 8 * 1024 * 1024;

const memoryBuckets = new Map();

export function __resetFixtureStore() {
  memoryBuckets.clear();
}

// Fault injection for fail-closed list handling (tests only): the next n
// `asset/`-prefixed lists on the fixture backend reject instead of
// answering. Tests reset with (0) in a finally. Part-prefix lists are
// never affected, so finalize reaches its attempt gate deterministically.
let failAssetLists = 0;
export function __failAssetListsForTest(n) { failAssetLists = n; }

function memoryStore() {
  const bucketId = 'fixture';
  if (!memoryBuckets.has(bucketId)) memoryBuckets.set(bucketId, new Map());
  const files = memoryBuckets.get(bucketId);
  return {
    backend: 'memory-fixture',
    async put(key, bytes) {
      files.set(key, bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes));
    },
    async get(key) {
      const v = files.get(key);
      return v === undefined ? null : v.slice();
    },
    async peek(key, maxBytes) {
      const v = files.get(key);
      return v === undefined ? null : v.slice(0, maxBytes);
    },
    async del(key) {
      files.delete(key);
    },
    async list(prefix, limit = Infinity) {
      // Limit support bounds finalize assembly lists (Codex-sec-P2):
      // callers pass cap + 1 and treat a full page as over-cap. The memory
      // backend still scans its (test-scale) map; R2 stops paginating
      // early, which is where the bound matters.
      if (prefix.startsWith('asset/') && failAssetLists > 0) {
        failAssetLists -= 1;
        throw new Error('injected list fault');
      }
      const out = [];
      for (const [k, v] of files) if (k.startsWith(prefix)) out.push({ key: k, size: v.length });
      out.sort((a, b) => (a.key < b.key ? -1 : 1));
      return out.slice(0, limit);
    },
  };
}

function r2Store(bucket) {
  return {
    backend: 'r2',
    async put(key, bytes) {
      await bucket.put(key, bytes);
    },
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return new Uint8Array(await obj.arrayBuffer());
    },
    async peek(key, maxBytes) {
      const obj = await bucket.get(key, { range: { offset: 0, length: maxBytes } });
      if (!obj) return null;
      return new Uint8Array(await obj.arrayBuffer());
    },
    async del(key) {
      await bucket.delete(key);
    },
    async list(prefix, limit = Infinity) {
      const out = [];
      let cursor;
      do {
        const page = await bucket.list({ prefix, cursor, limit: Math.min(1000, limit - out.length) });
        for (const o of page.objects) out.push({ key: o.key, size: o.size });
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor && out.length < limit);
      return out.sort((a, b) => (a.key < b.key ? -1 : 1)).slice(0, limit);
    },
  };
}

// Returns a store or null (caller reports STORAGE_UNPROVISIONED).
export function byteStore(env) {
  if (env && env.CATALOG_STORE) return r2Store(env.CATALOG_STORE);
  if (isFixtureEnv(env)) return memoryStore();
  return null;
}

export function storeAvailable(env) {
  return !!(env && (env.CATALOG_STORE || isFixtureEnv(env)));
}

// Tenant-scoped asset paths (Codex-sec-P2): pass-2 blobs land BEFORE the
// fenced commit, so a bare asset/<id>/ prefix lets one attempt overwrite
// or reclaim another tenant's live blobs on id collision. Scoping every
// asset blob under a domain-separated owner hash makes cross-tenant prefix
// sharing structurally impossible; the reservation gate (committed-row +
// live-prefix check before any write) and the reclaim fence (committed-row
// check before any delete) handle the same-tenant remainder. The hash keeps
// owner ids (whose alphabet is a better-auth internal) out of bucket keys.
export async function assetScope(ownerId) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`aipster-asset-scope/v1:${ownerId}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export async function assetPrefix(ownerId, assetId) {
  return `asset/${await assetScope(ownerId)}/${assetId}/`;
}

export async function assetKey(ownerId, assetId, relpath) {
  return `${await assetPrefix(ownerId, assetId)}${relpath}`;
}

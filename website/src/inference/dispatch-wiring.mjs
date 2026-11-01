// Lazy wiring for the L1 dispatch store.
//
// The real D1 store (createD1DispatchStore) is built by another lane in
// ./dispatch-store.mjs. This module must not hard-fail when that file is
// absent (it is absent on the routes branch), so it imports it dynamically
// and fails closed: a missing, throwing or malformed module yields null and
// the inference routes answer 503 DISPATCH_UNAVAILABLE without side effects.
//
// Tests inject their own in-memory store through the factory hook. The hook
// is module state, so a test sets it once per case and clears it afterwards.

let testFactory = null;

/** TEST ONLY. Install an in-memory store factory, or null to clear. */
export function __setDispatchStoreFactoryForTest(fn) {
  testFactory = typeof fn === 'function' ? fn : null;
}

/**
 * Resolve the dispatch store for this request.
 * @returns {Promise<object|null>} the L1 store, or null when unavailable.
 */
export async function getDispatchStore(env, db) {
  if (testFactory) return testFactory(env, db);
  if (!db) return null;
  try {
    // Literal specifier so Workers can statically analyse the import. On a
    // branch without the L1 file this rejects with ERR_MODULE_NOT_FOUND.
    const mod = await import('./dispatch-store.mjs');
    if (mod && typeof mod.createD1DispatchStore === 'function') {
      return mod.createD1DispatchStore(db, { now: () => Date.now(), env });
    }
  } catch {
    // Absent or failed to construct: fail closed, never fall back to a fake.
  }
  return null;
}

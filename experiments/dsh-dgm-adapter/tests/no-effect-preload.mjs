// Preload for the runtime no-effect probe.
//
// Installs capability traps *before* the adapter modules are imported, so a
// call that a source-spelling scan would miss (globalThis['fetch'], new Date(),
// crypto.getRandomValues, ...) is still observed at the capability level.
//
// Network, storage and notification surfaces throw once recorded: if the code
// under test really tries to reach outside the process, the probe must fail
// rather than quietly succeed. Clocks and randomness are stubbed
// deterministically and recorded, so their use is visible without breaking the
// Node runtime that hosts the probe.
//
// This is a test harness, never imported by anything under src/.

const hits = [];
globalThis.__dshDgmEffectHits = hits;

function record(name, detail = null) {
  hits.push(detail ? `${name}:${detail}` : name);
}

function deny(object, property, name) {
  if (!object) return;
  try {
    Object.defineProperty(object, property, {
      configurable: true,
      get() {
        record(name);
        throw new Error(`${name} is denied in the no-effect probe`);
      },
      set() {
        record(`${name}.set`);
        return false;
      }
    });
  } catch {
    // A non-configurable surface cannot be trapped here; the static spelling
    // guard still covers its literal form, and the probe reports what it could
    // and could not install.
    record(`${name}.untrapped`);
  }
}

function denyCallable(object, property, name) {
  if (!object || typeof object[property] !== 'function') return;
  try {
    Object.defineProperty(object, property, {
      configurable: true,
      writable: true,
      value: (...args) => {
        record(name, args.length ? 'called-with-args' : 'called');
        throw new Error(`${name} is denied in the no-effect probe`);
      }
    });
  } catch {
    record(`${name}.untrapped`);
  }
}

// Network and notification
denyCallable(globalThis, 'fetch', 'fetch');
deny(globalThis, 'XMLHttpRequest', 'XMLHttpRequest');
deny(globalThis, 'WebSocket', 'WebSocket');
deny(globalThis, 'EventSource', 'EventSource');
if (globalThis.navigator) denyCallable(globalThis.navigator, 'sendBeacon', 'navigator.sendBeacon');

// Browser storage
deny(globalThis, 'localStorage', 'localStorage');
deny(globalThis, 'sessionStorage', 'sessionStorage');
deny(globalThis, 'indexedDB', 'indexedDB');
deny(globalThis, 'caches', 'caches');

// Clock and randomness: recorded, and made deterministic so a use cannot hide
// behind a varying value.
try {
  Math.random = () => {
    record('Math.random');
    return 0.5;
  };
} catch {
  record('Math.random.untrapped');
}

try {
  Date.now = () => {
    record('Date.now');
    return 0;
  };
  const RealDate = Date;
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      if (args.length === 0) record('new Date()');
      return Reflect.construct(target, args, newTarget);
    }
  });
} catch {
  record('Date.untrapped');
}

if (globalThis.performance && typeof globalThis.performance.now === 'function') {
  try {
    globalThis.performance.now = () => {
      record('performance.now');
      return 0;
    };
  } catch {
    record('performance.now.untrapped');
  }
}

if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
  try {
    globalThis.crypto.getRandomValues = (array) => {
      record('crypto.getRandomValues');
      return array.fill(0);
    };
  } catch {
    record('crypto.getRandomValues.untrapped');
  }
}

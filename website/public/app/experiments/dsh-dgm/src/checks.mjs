// Deterministic acceptance predicates over JSON artifacts.
//
// Every check is a pure function of (artifact, criterion). There is no model,
// no clock, no randomness, and no network. A predicate returns a pass/fail plus
// a short redacted detail; it never echoes secret-shaped values.

import { canonicalJson } from './canonical.mjs';
import { containsSecretMaterial, redactText } from './contract.mjs';

const MISSING = Symbol('missing');

/** Resolve a dotted path with optional array indexes: `policy.permissions.a[0]`. */
export function getPath(value, path) {
  if (typeof path !== 'string' || path === '') return MISSING;
  const tokens = [];
  for (const part of path.split('.')) {
    const match = /^([^[\]]+)((?:\[\d+\])*)$/.exec(part);
    if (!match) return MISSING;
    tokens.push(match[1]);
    for (const index of match[2].match(/\d+/g) || []) tokens.push(Number(index));
  }
  let cursor = value;
  for (const token of tokens) {
    if (cursor === null || typeof cursor !== 'object') return MISSING;
    if (typeof token === 'number') {
      if (!Array.isArray(cursor) || token >= cursor.length) return MISSING;
      cursor = cursor[token];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cursor, token)) return MISSING;
      cursor = cursor[token];
    }
  }
  return cursor;
}

function describe(value) {
  if (value === MISSING) return '<missing>';
  if (typeof value === 'string') {
    const text = redactText(value);
    return JSON.stringify(text.length > 120 ? `${text.slice(0, 117)}...` : text);
  }
  if (value === undefined) return '<undefined>';
  const text = redactText(canonicalJson(value));
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function sameJson(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

function asArray(value) {
  return Array.isArray(value) ? value : MISSING;
}

const OPS = {
  equals(criterion, actual) {
    const passed = actual !== MISSING && sameJson(actual, criterion.value);
    return { passed, detail: passed ? 'value matches' : `expected ${describe(criterion.value)}, got ${describe(actual)}` };
  },

  stringEquals(criterion, actual) {
    const passed = typeof actual === 'string' && actual === criterion.value;
    return { passed, detail: passed ? 'string matches' : `expected ${describe(criterion.value)}, got ${describe(actual)}` };
  },

  nonEmpty(criterion, actual) {
    const passed = (typeof actual === 'string' && actual.trim() !== '')
      || (Array.isArray(actual) && actual.length > 0)
      || (actual !== null && typeof actual === 'object' && Object.keys(actual).length > 0);
    return { passed, detail: passed ? 'present and non-empty' : 'missing or empty' };
  },

  listEquals(criterion, actual) {
    const list = asArray(actual);
    if (list === MISSING) return { passed: false, detail: 'expected a list, got <missing>' };
    const expected = [...criterion.values].sort();
    const got = [...list].sort();
    const passed = sameJson(expected, got);
    return { passed, detail: passed ? 'list matches exactly' : `expected ${describe(expected)}, got ${describe(got)}` };
  },

  listIncludesAll(criterion, actual) {
    const list = asArray(actual);
    if (list === MISSING) return { passed: false, detail: 'expected a list, got <missing>' };
    const missing = criterion.values.filter((value) => !list.some((item) => sameJson(item, value)));
    return {
      passed: missing.length === 0,
      detail: missing.length === 0 ? 'all required values present' : `missing ${describe(missing)}`
    };
  },

  listIncludesNone(criterion, actual) {
    const list = asArray(actual);
    if (list === MISSING) return { passed: false, detail: 'expected a list, got <missing>' };
    const present = criterion.values.filter((value) => list.some((item) => sameJson(item, value)));
    return {
      passed: present.length === 0,
      detail: present.length === 0 ? 'no forbidden values present' : `forbidden values present: ${describe(present)}`
    };
  },

  objectEquals(criterion, actual) {
    const passed = actual !== MISSING && sameJson(actual, criterion.value);
    return { passed, detail: passed ? 'object matches exactly' : `expected ${describe(criterion.value)}, got ${describe(actual)}` };
  },

  numberLte(criterion, actual) {
    const passed = Number.isFinite(actual) && actual <= criterion.value;
    return { passed, detail: passed ? `<= ${criterion.value}` : `expected <= ${criterion.value}, got ${describe(actual)}` };
  },

  numberGte(criterion, actual) {
    const passed = Number.isFinite(actual) && actual >= criterion.value;
    return { passed, detail: passed ? `>= ${criterion.value}` : `expected >= ${criterion.value}, got ${describe(actual)}` };
  },

  hasKeys(criterion, actual) {
    if (actual === MISSING || actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return { passed: false, detail: 'expected an object, got <missing>' };
    }
    const missing = criterion.keys.filter((key) => !Object.prototype.hasOwnProperty.call(actual, key));
    return {
      passed: missing.length === 0,
      detail: missing.length === 0 ? 'all keys present' : `missing keys ${describe(missing)}`
    };
  },

  uniqueBy(criterion, actual) {
    const list = asArray(actual);
    if (list === MISSING) return { passed: false, detail: 'expected a list, got <missing>' };
    const seen = new Set();
    for (const item of list) {
      const key = item && typeof item === 'object' ? item[criterion.key] : MISSING;
      const encoded = key === MISSING ? '<missing>' : canonicalJson(key);
      if (seen.has(encoded)) return { passed: false, detail: `duplicate ${criterion.key} ${describe(key)}` };
      seen.add(encoded);
    }
    return { passed: true, detail: `${list.length} unique ${criterion.key} values` };
  },

  sortedBy(criterion, actual) {
    const list = asArray(actual);
    if (list === MISSING) return { passed: false, detail: 'expected a list, got <missing>' };
    const keys = list.map((item) => (item && typeof item === 'object' ? item[criterion.key] : undefined));
    if (keys.some((key) => typeof key !== 'string')) {
      return { passed: false, detail: `every entry needs a string ${criterion.key}` };
    }
    const sorted = [...keys].sort((a, b) => a.localeCompare(b));
    const passed = sameJson(keys, sorted);
    return { passed, detail: passed ? `sorted by ${criterion.key}` : `not sorted by ${criterion.key}: ${describe(keys)}` };
  },

  matches(criterion, actual) {
    if (typeof actual !== 'string') return { passed: false, detail: 'expected a string' };
    let pattern;
    try {
      pattern = new RegExp(criterion.pattern);
    } catch {
      return { passed: false, detail: 'invalid fixture pattern' };
    }
    const passed = pattern.test(actual);
    return { passed, detail: passed ? 'pattern matches' : 'pattern does not match' };
  },

  noSecretMaterial(criterion, actual, artifact) {
    const target = criterion.path ? actual : artifact;
    if (target === MISSING) return { passed: false, detail: 'expected a value, got <missing>' };
    const leaked = containsSecretMaterial(target);
    // Never echo the secret-shaped value; name the location only.
    return {
      passed: !leaked,
      detail: leaked ? 'secret-shaped material detected (value withheld)' : 'no secret-shaped material'
    };
  }
};

export const OPS_SUPPORTED = Object.freeze(Object.keys(OPS));

/**
 * Evaluate one criterion. Returns `{ id, statement, passed, detail, path }`.
 * Unknown operators fail closed: an unevaluable criterion is never a pass.
 */
export function evaluateCriterion(artifact, criterion) {
  if (!criterion || typeof criterion !== 'object' || typeof criterion.op !== 'string') {
    return { id: String(criterion && criterion.id), statement: '', passed: false, detail: 'malformed criterion', path: '' };
  }
  // Own properties only: `OPS[name]` also resolves Object.prototype members.
  // `constructor` would return the criterion itself, so a criterion carrying
  // `passed: true` could certify itself; `__proto__` is not even callable.
  const op = Object.hasOwn(OPS, criterion.op) ? OPS[criterion.op] : undefined;
  if (!op) {
    return {
      id: criterion.id,
      statement: criterion.statement || '',
      passed: false,
      detail: `unsupported criterion op ${JSON.stringify(criterion.op)}`,
      path: criterion.path || ''
    };
  }
  const actual = criterion.path ? getPath(artifact, criterion.path) : artifact;
  if (actual === MISSING && criterion.op !== 'noSecretMaterial') {
    return {
      id: criterion.id,
      statement: criterion.statement || '',
      passed: false,
      detail: `missing path ${JSON.stringify(criterion.path)}`,
      path: criterion.path || ''
    };
  }
  const result = op(criterion, actual, artifact);
  return {
    id: criterion.id,
    statement: criterion.statement || '',
    passed: result.passed === true,
    detail: result.detail,
    path: criterion.path || ''
  };
}

/** Evaluate every criterion. Work units = criteria evaluated (deterministic). */
export function evaluateCriteria(artifact, criteria) {
  if (!Array.isArray(criteria)) throw new TypeError('criteria must be an array');
  const checks = criteria.map((criterion) => evaluateCriterion(artifact, criterion));
  return {
    checks,
    passed: checks.every((check) => check.passed),
    workUnits: checks.length,
    failed: checks.filter((check) => !check.passed)
  };
}

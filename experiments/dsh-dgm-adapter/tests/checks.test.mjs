import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateCriteria, evaluateCriterion, getPath, OPS_SUPPORTED } from '../src/checks.mjs';

const artifact = {
  policy: {
    disabled_actions: ['apply', 'execute'],
    permissions: { reviewer: ['read'] },
    acceptance_mode: 'observe'
  },
  budgets: { max_work_units: 64 },
  public_identifiers: ['aipster.dgm.preview/v1', 'x/y'],
  rollback: { strategy: 'restore', revision: 'r1' },
  entries: [{ name: 'a' }, { name: 'b' }],
  secrets: { token_ref: 'env:SAFE' }
};

test('getPath resolves dots and indexes, and reports absence', () => {
  assert.equal(getPath(artifact, 'policy.acceptance_mode'), 'observe');
  assert.equal(getPath(artifact, 'entries[1].name'), 'b');

  // Absence is a private sentinel: it must never be mistaken for a real value.
  const absent = getPath(artifact, 'policy.nope');
  assert.notEqual(absent, 'observe');
  assert.notEqual(absent, undefined);
  assert.equal(evaluateCriterion(artifact, { id: 'M', op: 'nonEmpty', path: 'policy.nope' }).passed, false);
  assert.equal(evaluateCriterion(artifact, { id: 'M', op: 'nonEmpty', path: 'entries[9]' }).passed, false);
});

test('each supported operator passes and fails on the right input', () => {
  const cases = [
    { op: 'stringEquals', path: 'policy.acceptance_mode', value: 'observe', pass: true },
    { op: 'stringEquals', path: 'policy.acceptance_mode', value: 'auto', pass: false },
    { op: 'listEquals', path: 'policy.disabled_actions', values: ['execute', 'apply'], pass: true },
    { op: 'listEquals', path: 'policy.disabled_actions', values: ['apply'], pass: false },
    { op: 'listIncludesAll', path: 'public_identifiers', values: ['aipster.dgm.preview/v1'], pass: true },
    { op: 'listIncludesAll', path: 'public_identifiers', values: ['aipster.dgm.preview/v2'], pass: false },
    { op: 'listIncludesNone', path: 'public_identifiers', values: ['nope'], pass: true },
    { op: 'listIncludesNone', path: 'public_identifiers', values: ['x/y'], pass: false },
    { op: 'objectEquals', path: 'policy.permissions', value: { reviewer: ['read'] }, pass: true },
    { op: 'objectEquals', path: 'policy.permissions', value: { reviewer: ['read', 'write'] }, pass: false },
    { op: 'numberLte', path: 'budgets.max_work_units', value: 64, pass: true },
    { op: 'numberLte', path: 'budgets.max_work_units', value: 10, pass: false },
    { op: 'numberGte', path: 'budgets.max_work_units', value: 64, pass: true },
    { op: 'numberGte', path: 'budgets.max_work_units', value: 100, pass: false },
    { op: 'nonEmpty', path: 'rollback.strategy', pass: true },
    { op: 'nonEmpty', path: 'rollback.missing', pass: false },
    { op: 'hasKeys', path: 'rollback', keys: ['strategy', 'revision'], pass: true },
    { op: 'hasKeys', path: 'rollback', keys: ['strategy', '__absent'], pass: false },
    { op: 'uniqueBy', path: 'entries', key: 'name', pass: true },
    { op: 'sortedBy', path: 'entries', key: 'name', pass: true },
    { op: 'matches', path: 'rollback.revision', pattern: '^r\\d+$', pass: true },
    { op: 'matches', path: 'rollback.revision', pattern: '^z', pass: false }
  ];

  for (const testCase of cases) {
    const result = evaluateCriterion(artifact, { id: testCase.op, statement: '', ...testCase });
    assert.equal(result.passed, testCase.pass, `${testCase.op} ${JSON.stringify(testCase.path)} should be ${testCase.pass}`);
  }
});

test('uniqueBy catches duplicates', () => {
  const duplicated = { entries: [{ name: 'a' }, { name: 'a' }] };
  const result = evaluateCriterion(duplicated, { id: 'U', op: 'uniqueBy', path: 'entries', key: 'name' });
  assert.equal(result.passed, false);
});

test('sortedBy rejects an out-of-order list', () => {
  const unsorted = { entries: [{ name: 'b' }, { name: 'a' }] };
  const result = evaluateCriterion(unsorted, { id: 'S', op: 'sortedBy', path: 'entries', key: 'name' });
  assert.equal(result.passed, false);
  assert.match(result.detail, /not sorted/);
});

test('unknown operators and malformed criteria fail closed', () => {
  const unknown = evaluateCriterion(artifact, { id: 'X', op: 'vibesMatch', path: 'policy' });
  assert.equal(unknown.passed, false);
  assert.match(unknown.detail, /unsupported criterion op/);

  const malformed = evaluateCriterion(artifact, null);
  assert.equal(malformed.passed, false);
  assert.equal(malformed.detail, 'malformed criterion');

  const missing = evaluateCriterion(artifact, { id: 'M', op: 'stringEquals', path: 'policy.absent', value: 'x' });
  assert.equal(missing.passed, false);
  assert.match(missing.detail, /missing path/);
});

test('secret-shaped material is detected and never echoed', () => {
  const leaky = { secrets: { token_ref: 'Bearer fixture-not-a-real-token-aaaaaaaa' } };
  const result = evaluateCriterion(leaky, { id: 'C7', op: 'noSecretMaterial' });
  assert.equal(result.passed, false);
  assert.match(result.detail, /value withheld/);
  assert.equal(JSON.stringify(result).includes('fixture-not-a-real-token'), false);

  const safe = evaluateCriterion(artifact, { id: 'C7', op: 'noSecretMaterial' });
  assert.equal(safe.passed, true);
});

test('evaluateCriteria counts work units and reports failures', () => {
  const criteria = [
    { id: 'A', op: 'stringEquals', path: 'policy.acceptance_mode', value: 'observe' },
    { id: 'B', op: 'numberLte', path: 'budgets.max_work_units', value: 10 }
  ];
  const run = evaluateCriteria(artifact, criteria);
  assert.equal(run.workUnits, 2);
  assert.equal(run.passed, false);
  assert.deepEqual(run.failed.map((check) => check.id), ['B']);
});

test('the op table is stable and exported', () => {
  assert.ok(OPS_SUPPORTED.includes('noSecretMaterial'));
  assert.equal(new Set(OPS_SUPPORTED).size, OPS_SUPPORTED.length);
});

test('dispatch reaches only operators the module owns', () => {
  // OPS is a plain object, so `OPS[name]` also resolves Object.prototype
  // members. `constructor` returns the criterion itself, whose own
  // `passed: true` would then be read as the result; `__proto__` is not even
  // callable. Only own properties may dispatch, and everything else refuses.
  for (const op of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const result = evaluateCriterion(artifact, { id: 'X', op, passed: true });
    assert.equal(result.passed, false, `${op} must not dispatch`);
    assert.match(result.detail, /unsupported criterion op/);
  }
  const run = evaluateCriteria(artifact, [{ id: 'X', op: 'constructor', passed: true }]);
  assert.equal(run.passed, false);
  assert.deepEqual(run.failed.map((check) => check.id), ['X']);
});

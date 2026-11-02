// Regressions for the independent review of eeda53f (reviewer 88a).
//
// Each test below is written against the *reviewer's* reproduction, not against
// the author's intent: A (a re-sealed request widening its own envelope),
// B (a fabricated verdict whose seal verifies), D (malformed input throwing a
// TypeError instead of refusing). They fail on eeda53f and pass after the
// repair. Nothing here tests authentication: the seals are unkeyed, so the
// defence is re-derivation and internal coherence, not a signature.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRequest, fixtureConstraints } from '../src/adapter.mjs';
import { constraintsBoundToFixture, evaluate, verifyVerdict } from '../src/evaluate.mjs';
import { requestRollback, select, verifySelection } from '../src/selection.mjs';
import { seal, verifySeal } from '../src/canonical.mjs';
import { REFUSAL_CODES } from '../src/contract.mjs';
import { WORK_ITEMS, findWorkItem } from '../fixtures/work-items.mjs';

const FIXTURES = WORK_ITEMS;

async function candidateVerdicts(workItem) {
  const built = await buildRequest(workItem);
  assert.equal(built.ok, true);
  return { request: built.request, verdict: await evaluate(workItem, built.request) };
}

/* ------------------------------------------------------------------ finding A */

test('A: a re-sealed request that widens the envelope is unbound, not selected', async () => {
  // The reviewer's exact shape: a tight-budget fixture, honestly refused, then
  // the same request re-sealed with threshold 9999.
  const tight = { ...findWorkItem('sm-106'), budget: { max_work_units: 4, max_repairs: 3 } };
  const built = await buildRequest(tight);
  assert.equal(built.ok, true);

  const honest = await evaluate(tight, built.request);
  assert.equal(honest.status, 'unavailable');
  assert.equal(honest.code, 'DGM_ENVELOPE_EXCEEDED');

  const loosened = await seal({
    ...built.request,
    constraints: built.request.constraints.map((entry) => ({ ...entry, threshold: 9999 }))
  }, 'request_sha256');
  assert.equal(loosened.snapshot.fixture_sha256, built.request.snapshot.fixture_sha256, 'the fixture digest is unchanged');

  const forged = await evaluate(tight, loosened);
  assert.equal(forged.status, 'unavailable', 'a widened request must not select');
  assert.equal(forged.code, 'DGM_CONSTRAINTS_UNBOUND');
  assert.equal(forged.scores.subject_ppm, null, 'no score is produced for an unbound request');
  assert.equal(forged.receipt, null);
  assert.equal(forged.applied, false);
  assert.equal(forged.verdict_sha256.length, 64);
});

test('A: tightened, reordered, extended or dropped constraints are all unbound', async () => {
  const workItem = findWorkItem('sm-106');
  const built = await buildRequest(workItem);
  const original = built.request.constraints;

  const variants = {
    tightened: original.map((entry) => ({ ...entry, threshold: 0 })),
    reordered: [...original].reverse(),
    extended: [...original, { name: 'wall_clock_ms', definition_version: 'x', unit: 'ms', operator: '<=', threshold: 1 }],
    dropped: original.slice(0, 1),
    renamed: original.map((entry) => ({ ...entry, name: `${entry.name}_v2` }))
  };

  for (const [label, constraints] of Object.entries(variants)) {
    const resealed = await seal({ ...built.request, constraints }, 'request_sha256');
    const verdict = await evaluate(workItem, resealed);
    assert.equal(verdict.status, 'unavailable', `${label} must not select`);
    assert.equal(verdict.code, 'DGM_CONSTRAINTS_UNBOUND', `${label} must report an unbound envelope`);
    assert.equal(verdict.scores.subject_ppm, null, `${label} must produce no score`);
  }

  // An empty constraint list never reaches the binding check: the shape is invalid.
  const empty = await seal({ ...built.request, constraints: [] }, 'request_sha256');
  const refused = await evaluate(workItem, empty);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'DGM_REQUEST_MALFORMED');
});

test('A: the fixture budget is the authority, and a malformed budget is refused', async () => {
  const derived = fixtureConstraints(findWorkItem('sm-101'));
  assert.equal(derived.ok, true);
  assert.deepEqual(derived.constraints.map((entry) => [entry.name, entry.threshold]), [
    ['work_units', 64],
    ['repair_items', 3]
  ]);

  const bad = { ...findWorkItem('sm-106'), budget: { max_work_units: 'many', max_repairs: 3 } };
  const built = await buildRequest(bad);
  assert.equal(built.ok, false);
  assert.equal(built.code, 'DGM_BAD_FIXTURE_BUDGET');

  const negative = { ...findWorkItem('sm-106'), budget: { max_work_units: 8, max_repairs: -1 } };
  assert.equal((await buildRequest(negative)).code, 'DGM_BAD_FIXTURE_BUDGET');

  const missing = { ...findWorkItem('sm-106'), budget: undefined };
  assert.equal((await buildRequest(missing)).code, 'DGM_BAD_FIXTURE_BUDGET');

  // The comparison helper refuses too, rather than silently deriving nothing.
  const request = (await buildRequest(findWorkItem('sm-106'))).request;
  const bound = constraintsBoundToFixture(request, bad);
  assert.equal(bound.ok, false);
  assert.equal(bound.code, 'DGM_BAD_FIXTURE_BUDGET');
});

/* ------------------------------------------------------------------ finding B */

test('B: a re-sealed verdict relabelled "selected" is refused, though its seal verifies', async () => {
  // The reviewer's exact probe: take a genuine rejected verdict, relabel it,
  // re-seal it — no key is involved, so the seal still verifies.
  const workItem = findWorkItem('sm-101');
  const built = await buildRequest(workItem, { subject: 'baseline' });
  const rejected = await evaluate(workItem, built.request);
  assert.equal(rejected.status, 'rejected');

  const fabricated = await seal({
    ...rejected,
    status: 'selected',
    code: 'DGM_SELECTED',
    scores: { ...rejected.scores, subject_ppm: 1_000_000 },
    work_units: 0,
    repair_brief: [],
    gates: rejected.gates.map((entry) => ({ ...entry, passed: true }))
  }, 'verdict_sha256');

  assert.equal((await verifySeal(fabricated, 'verdict_sha256')).ok, true, 'the unkeyed seal cannot be the defence');

  const selection = await select([fabricated], { fixtures: FIXTURES });
  assert.equal(selection.ok, false);
  assert.equal(selection.code, 'DGM_RECEIPT_STATUS_MISMATCH');
  assert.equal(fabricated.receipt.status, 'rejected');

  const verified = await verifyVerdict(fabricated, workItem, built.request);
  assert.equal(verified.ok, false);
});

test('B: a fully coherent forgery is still refused, because selection re-derives it', async () => {
  // Stronger than the reviewer's probe: re-seal the receipt too, so every
  // internal consistency check passes. Only re-derivation catches this.
  const workItem = findWorkItem('sm-101');
  const built = await buildRequest(workItem, { subject: 'baseline' });
  const rejected = await evaluate(workItem, built.request);
  const predicates = rejected.checks.subject.length + rejected.checks.reference.length;

  const receipt = await seal({
    ...rejected.receipt,
    status: 'selected',
    code: 'DGM_SELECTED',
    subject_ppm: 1_000_000,
    repair_items: 0
  }, 'receipt_sha256');

  const forged = await seal({
    ...rejected,
    status: 'selected',
    code: 'DGM_SELECTED',
    detail: 'every gate passed; nothing was applied',
    gates: rejected.gates.map((entry) => ({ ...entry, passed: true })),
    scores: { ...rejected.scores, subject_ppm: 1_000_000 },
    work_units: predicates + 4,
    repair_brief: [],
    receipt
  }, 'verdict_sha256');

  assert.equal((await verifySeal(forged, 'verdict_sha256')).ok, true);
  assert.equal((await verifySeal(forged.receipt, 'receipt_sha256')).ok, true);

  const selection = await select([forged], { fixtures: FIXTURES });
  assert.equal(selection.ok, false);
  assert.equal(selection.code, 'DGM_VERDICT_UNBOUND');
});

test('B: selection requires the fixtures and refuses an unknown one', async () => {
  const { verdict } = await candidateVerdicts(findWorkItem('sm-106'));
  assert.equal((await select([verdict])).code, 'DGM_UNVERIFIED_SELECTION');

  const other = FIXTURES.filter((fixture) => fixture.id !== 'sm-106');
  assert.equal((await select([verdict], { fixtures: other })).code, 'DGM_VERDICT_UNBOUND');
});

test('B: a genuine unavailable or failed verdict is selected over, never refused', async () => {
  // The coherence check must not reject real records. This one is honestly
  // unavailable because its own budget cannot fit the check set.
  const tight = { ...findWorkItem('sm-106'), budget: { max_work_units: 4, max_repairs: 3 } };
  const built = await buildRequest(tight);
  const unavailable = await evaluate(tight, built.request);
  assert.equal(unavailable.status, 'unavailable');

  const withTight = [...FIXTURES.filter((fixture) => fixture.id !== 'sm-106'), tight];
  const result = await select([unavailable], { fixtures: withTight });
  assert.equal(result.ok, true, `a genuine unavailable verdict must not be refused: ${result.code}`);
  assert.equal(result.selection.selected, null);
  assert.equal(result.selection.verification.verified, 1);

  // The same verdict named against a fixture whose budget differs cannot be
  // re-derived, so it is unbound — the refusal is about reproduction, not status.
  assert.equal((await select([unavailable], { fixtures: FIXTURES })).code, 'DGM_VERDICT_UNBOUND');

  // A rejected or unavailable verdict mixed with a selectable one: the
  // selectable one wins and the others are still counted as verified.
  const selectable = (await candidateVerdicts(findWorkItem('sm-101'))).verdict;
  assert.equal(selectable.status, 'selected');
  const mixed = await select([unavailable, selectable], { fixtures: withTight });
  assert.equal(mixed.ok, true);
  assert.equal(mixed.selection.selected.verdict_sha256, selectable.verdict_sha256);
  assert.equal(mixed.selection.verification.verified, 2);
});

test('B: a genuine selection records what it verified', async () => {
  const verdicts = [];
  for (const workItem of WORK_ITEMS) verdicts.push((await candidateVerdicts(workItem)).verdict);

  const result = await select(verdicts, { fixtures: FIXTURES });
  assert.equal(result.ok, true);
  assert.equal(result.selection.verification.verified, verdicts.length);
  assert.match(result.selection.verification.seals, /not authentication/);
  assert.equal(result.selection.applied, false);
  assert.equal((await verifySelection(result.selection)).ok, true);
  assert.equal((await select(verdicts, { fixtures: FIXTURES })).selection.selection_sha256, result.selection.selection_sha256);
});

/* ------------------------------------------------------------------ ordering */

test('C: ordering is stable, and a re-sealed score that contradicts its receipt never ranks', async () => {
  const base = [];
  for (const id of ['sm-101', 'sm-102', 'sm-103']) {
    base.push((await candidateVerdicts(findWorkItem(id))).verdict);
  }

  // Total order: the same pick regardless of input permutation.
  const picks = new Set();
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [0, 2, 1]]) {
    const result = await select(order.map((index) => base[index]), { fixtures: FIXTURES });
    assert.equal(result.ok, true);
    picks.add(result.selection.selected.verdict_sha256);
  }
  assert.equal(picks.size, 1, 'selection must not depend on input order');

  // A re-sealed null score is refused before the comparator sees it: the seal
  // covers the verdict only, so the receipt still carries the original score.
  const resealed = [];
  for (const verdict of base.slice(0, 2)) {
    resealed.push(await seal({
      ...verdict,
      scores: { ...verdict.scores, subject_ppm: null },
      work_units: 5
    }, 'verdict_sha256'));
  }
  assert.equal((await verifySeal(resealed[0], 'verdict_sha256')).ok, true);

  for (const order of [resealed, [...resealed].reverse()]) {
    const result = await select(order, { fixtures: FIXTURES });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DGM_VERDICT_INCOHERENT');
  }
});

/* ------------------------------------------------------------------ finding D */

test('D: malformed requests return typed refusals instead of throwing', async () => {
  const workItem = findWorkItem('sm-106');
  const cases = [
    ['null', null],
    ['undefined', undefined],
    ['string', 'not a request'],
    ['array', []],
    ['empty object', {}],
    ['sealed empty', await seal({}, 'request_sha256')],
    ['sealed snapshot only', await seal({ snapshot: {} }, 'request_sha256')],
    ['sealed without baseline', await seal({ snapshot: {}, target: { kind: 'dsh-ticket', name: 'x' } }, 'request_sha256')],
    ['sealed with a bad subject', await seal({ subject: 'someone-else' }, 'request_sha256')],
    ['missing source on target', await seal({
      subject: 'candidate',
      snapshot: { fixture_id: 'sm-106', fixture_sha256: 'a'.repeat(64), criteria_sha256: 'b'.repeat(64) },
      baseline: { sha256: 'c'.repeat(64) },
      candidate: { sha256: 'd'.repeat(64) },
      target: { kind: 'dsh-ticket', name: 't', issue_number: 1 },
      module: { id: 'm', version: '1' },
      constraints: [{ name: 'work_units', operator: '<=', threshold: 1 }]
    }, 'request_sha256')]
  ];

  for (const [label, request] of cases) {
    const result = await evaluate(workItem, request);
    assert.equal(result.ok, false, `${label} must refuse`);
    assert.equal(typeof result.code, 'string', `${label} must carry a code`);
    assert.ok(REFUSAL_CODES.includes(result.code), `${label} code ${result.code} is not in the contract`);
    assert.equal(result.receipt, undefined, `${label} must not produce a receipt`);
  }

  const noFixture = await evaluate(null, {});
  assert.equal(noFixture.ok, false);
  assert.equal(noFixture.code, 'DGM_BAD_INPUT');
});

test('D: a valid fixture with a malformed budget refuses rather than throwing', async () => {
  const request = (await buildRequest(findWorkItem('sm-106'))).request;
  const badBudget = { ...findWorkItem('sm-106'), budget: { max_work_units: null, max_repairs: 3 } };
  const verdict = await evaluate(badBudget, request);
  // The fixture digest covers the budget, so identity catches this first.
  assert.equal(verdict.status, 'unavailable');
  assert.ok(['DGM_IDENTITY_MISMATCH', 'DGM_BAD_FIXTURE_BUDGET'].includes(verdict.code));
  assert.equal(verdict.applied, false);
});

test('D: requestRollback refuses a selection without a usable rollback plan', async () => {
  const shapes = [
    null,
    'not a selection',
    { applied: false },
    { applied: false, rollback: {} },
    { applied: false, rollback: { action: 'restore-previous-revision', applied: false } },
    { applied: true, rollback: { action: 'a', revision: 'r', from: 'f', to: 't', applied: false } }
  ];

  for (const shape of shapes) {
    const result = requestRollback(shape);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DGM_BAD_SELECTION');
  }

  const { verdict } = await candidateVerdicts(findWorkItem('sm-106'));
  const { selection } = await select([verdict], { fixtures: FIXTURES });
  const requested = requestRollback(selection, { reason: 'regression' });
  assert.equal(requested.ok, true);
  assert.equal(requested.applied, false);
  assert.equal(requested.record.executed, false);
});

test('D: verifySelection answers, rather than throwing, on malformed input', async () => {
  for (const value of [null, 'x', [], {}, { applied: false }]) {
    const result = await verifySelection(value);
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, 'string');
  }
});

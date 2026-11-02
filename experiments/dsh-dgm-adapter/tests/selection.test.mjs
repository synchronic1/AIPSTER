import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRequest } from '../src/adapter.mjs';
import { evaluate } from '../src/evaluate.mjs';
import { MAX_CANDIDATES, requestRollback, select, verifySelection } from '../src/selection.mjs';
import { seal } from '../src/canonical.mjs';
import { AUTHORITY, SELECTION_SCHEMA } from '../src/contract.mjs';
import { WORK_ITEMS, findWorkItem } from '../fixtures/work-items.mjs';

async function candidateVerdicts() {
  const verdicts = [];
  for (const workItem of WORK_ITEMS) {
    const built = await buildRequest(workItem);
    assert.equal(built.ok, true);
    verdicts.push(await evaluate(workItem, built.request));
  }
  return verdicts;
}

const FIXTURES = WORK_ITEMS;

test('selection is bounded, sealed, unapplied and stable across runs', async () => {
  const verdicts = await candidateVerdicts();
  const first = await select(verdicts, { fixtures: FIXTURES });
  const second = await select(verdicts, { fixtures: FIXTURES });

  assert.equal(first.ok, true);
  const selection = first.selection;
  assert.equal(selection.schema, SELECTION_SCHEMA);
  assert.equal(selection.applied, false);
  assert.equal(selection.authority, AUTHORITY);
  assert.equal(selection.considered.length, verdicts.length);
  assert.equal(selection.bound.within_bound, true);
  assert.equal(selection.bound.max_candidates, MAX_CANDIDATES);
  assert.ok(selection.selected, 'seven clean candidates, one is recommended');
  assert.equal(verdicts.some((verdict) => verdict.verdict_sha256 === selection.selected.verdict_sha256), true);
  assert.deepEqual(selection.rejected, []);
  assert.equal(selection.ties, verdicts.length, 'all seven clean candidates tie on score and work units');
  assert.match(selection.tie_break, /verdict digest/);
  assert.equal(selection.selection_id, second.selection.selection_id);
  assert.equal(selection.selection_sha256, second.selection.selection_sha256);
});

test('the rollback plan names a revision and is never executed', async () => {
  const verdicts = await candidateVerdicts();
  const { selection } = await select(verdicts, { fixtures: FIXTURES, baselineRevision: 'rev-test-1' });
  assert.equal(selection.rollback.action, 'restore-previous-revision');
  assert.equal(selection.rollback.revision, 'rev-test-1');
  assert.equal(selection.rollback.applied, false);
  assert.match(selection.rollback.from, /^[0-9a-f]{64}$/);
  assert.match(selection.rollback.to, /^[0-9a-f]{64}$/);
  assert.notEqual(selection.rollback.from, selection.rollback.to);

  const requested = requestRollback(selection, { reason: 'test' });
  assert.equal(requested.ok, true);
  assert.equal(requested.applied, false);
  assert.equal(requested.record.executed, false);
  assert.equal(requested.record.selection_sha256, selection.selection_sha256);
});

test('a rejected-only set selects nothing but still records the outcome', async () => {
  const baselineVerdicts = [];
  for (const workItem of WORK_ITEMS.filter((entry) => entry.defects.length > 0)) {
    const built = await buildRequest(workItem, { subject: 'baseline' });
    baselineVerdicts.push(await evaluate(workItem, built.request));
  }
  const { selection } = await select(baselineVerdicts, { fixtures: FIXTURES });
  assert.equal(selection.selected, null);
  assert.equal(selection.rejected.length, baselineVerdicts.length);
  assert.match(selection.note, /nothing was applied/);
  assert.equal(selection.applied, false);
});

test('selection refuses an empty, oversized or tampered input', async () => {
  assert.equal((await select([])).code, 'DGM_NO_CANDIDATES');
  assert.equal((await select('nope')).code, 'DGM_BAD_INPUT');

  const verdicts = await candidateVerdicts();
  const oversized = await select(verdicts, { fixtures: FIXTURES, maxCandidates: 2 });
  assert.equal(oversized.code, 'DGM_SELECTION_UNBOUNDED');

  const tampered = { ...verdicts[0], work_units: 999 };
  assert.equal((await select([tampered], { fixtures: FIXTURES })).code, 'DGM_VERDICT_TAMPERED');

  // Correctly re-sealed but claiming authority it must never have.
  const elevated = await seal({ ...verdicts[0], applied: true }, 'verdict_sha256');
  assert.equal((await select([elevated], { fixtures: FIXTURES })).code, 'DGM_AUTHORITY_VIOLATION');

  // Correctly re-sealed, but its archive receipt no longer verifies.
  const badReceipt = await seal({
    ...verdicts[0],
    receipt: { ...verdicts[0].receipt, receipt_sha256: 'f'.repeat(64) }
  }, 'verdict_sha256');
  assert.equal((await select([badReceipt], { fixtures: FIXTURES })).code, 'DGM_RECEIPT_TAMPERED');
});

test('a verdict without a receipt cannot be selected', async () => {
  const verdicts = await candidateVerdicts();
  const built = await buildRequest(findWorkItem('sm-101'), { tamper: 'candidate' });
  const refusedVerdict = await evaluate(findWorkItem('sm-101'), built.request);
  assert.equal(refusedVerdict.receipt, null);

  // The refusal is honestly unsealed-free but also receipt-free, so selection
  // must reject it on the receipt rule rather than silently ranking it.
  const refused = await select([refusedVerdict, ...verdicts], { fixtures: FIXTURES });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'DGM_NO_RECEIPT');
});

test('verifySelection detects tampering and elevation', async () => {
  const verdicts = await candidateVerdicts();
  const { selection } = await select(verdicts, { fixtures: FIXTURES });

  assert.equal((await verifySelection(selection)).ok, true);
  assert.equal((await verifySelection({ ...selection, applied: true })).ok, false);
  assert.equal((await verifySelection({ ...selection, selection_sha256: 'f'.repeat(64) })).ok, false);

  const noRollback = { ...selection, rollback: { ...selection.rollback, applied: true } };
  assert.equal((await verifySelection(noRollback)).ok, false);
});

test('rollback is refused for an elevated selection', () => {
  const refused = requestRollback({ applied: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'DGM_BAD_SELECTION');
  assert.equal(requestRollback(null).code, 'DGM_BAD_SELECTION');
});

test('selection re-derives with the identities the verdict was built under', async () => {
  const workItem = WORK_ITEMS[0];
  const built = await buildRequest(workItem, { tenantId: 'tenant-ops', actorId: 'actor-ops' });
  assert.equal(built.ok, true);
  const verdict = await evaluate(workItem, built.request);
  assert.notEqual(verdict.ok, false);

  // Rebuilding with only `subject` resets the identities to the fixture
  // defaults, so the digest cannot match. Selection must be told the request
  // context instead of silently rejecting a genuine verdict.
  const unbound = await select([verdict], { fixtures: FIXTURES });
  assert.equal(unbound.code, 'DGM_VERDICT_UNBOUND');

  const selected = await select([verdict], {
    fixtures: FIXTURES,
    contexts: { [workItem.id]: { tenantId: 'tenant-ops', actorId: 'actor-ops' } }
  });
  assert.equal(selected.ok, true);
  assert.equal(selected.selection.verification.verified, 1);

  const wrongContext = await select([verdict], {
    fixtures: FIXTURES,
    contexts: { [workItem.id]: { tenantId: 'tenant-other', actorId: 'actor-ops' } }
  });
  assert.equal(wrongContext.code, 'DGM_VERDICT_UNBOUND');

  const malformed = await select([verdict], {
    fixtures: FIXTURES,
    contexts: { [workItem.id]: { tenantId: 7 } }
  });
  assert.equal(malformed.code, 'DGM_BAD_INPUT');
});

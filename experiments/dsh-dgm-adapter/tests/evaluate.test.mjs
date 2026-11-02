import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRequest } from '../src/adapter.mjs';
import { baselinePolicy, evaluate, replay, verifyVerdict } from '../src/evaluate.mjs';
import { AUTHORITY, GATES, LIMITATIONS, VERDICT_SCHEMA } from '../src/contract.mjs';
import { WORK_ITEMS, findWorkItem } from '../fixtures/work-items.mjs';

async function verdictFor(workItem, options = {}) {
  const built = await buildRequest(workItem, options);
  assert.equal(built.ok, true, `${workItem.id} ${options.subject || 'candidate'} should build`);
  return { request: built.request, verdict: await evaluate(workItem, built.request) };
}

test('a clean candidate passes every gate and is still not applied', async () => {
  const { verdict } = await verdictFor(findWorkItem('sm-106'));
  assert.equal(verdict.schema, VERDICT_SCHEMA);
  assert.equal(verdict.status, 'selected');
  assert.equal(verdict.code, 'DGM_SELECTED');
  assert.equal(verdict.applied, false);
  assert.equal(verdict.authority, AUTHORITY);
  assert.deepEqual(verdict.gates.map((entry) => entry.name), GATES);
  assert.ok(verdict.gates.every((entry) => entry.passed));
  assert.equal(verdict.scores.subject_ppm, 1_000_000);
  assert.deepEqual(verdict.repair_brief, []);
  assert.equal(verdict.receipt.applied, false);
  assert.equal(verdict.receipt.status, 'selected');
  assert.equal(verdict.limitations.length, LIMITATIONS.length);
});

test('every repaired candidate is selected; every defective baseline is rejected', async () => {
  for (const workItem of WORK_ITEMS) {
    const candidate = await verdictFor(workItem, { subject: 'candidate' });
    assert.equal(candidate.verdict.status, 'selected', `${workItem.id} candidate`);

    const baseline = await verdictFor(workItem, { subject: 'baseline' });
    const failedIds = baseline.verdict.repair_brief.map((entry) => entry.id);
    if (workItem.defects.length === 0) {
      assert.equal(baseline.verdict.status, 'selected', `${workItem.id} is the clean control`);
    } else {
      assert.equal(baseline.verdict.status, 'rejected', `${workItem.id} baseline`);
      assert.equal(baseline.verdict.code, 'DGM_CRITERIA_FAILED');
      assert.deepEqual([...failedIds].sort(), [...workItem.defects].sort(), `${workItem.id} exact labels`);
    }
  }
});

test('the baseline policy admits a defective artifact that the gate rejects', async () => {
  const workItem = findWorkItem('sm-101');
  assert.equal(baselinePolicy(workItem.artifact).status, 'selected');
  assert.equal(baselinePolicy(workItem.artifact).work_units, 1);
  assert.equal(baselinePolicy('not an artifact').status, 'failed');

  const { verdict } = await verdictFor(workItem, { subject: 'baseline' });
  assert.equal(verdict.status, 'rejected');
});

test('a work-unit or repair envelope is unavailable, not a rejection', async () => {
  const tight = { ...findWorkItem('sm-106'), budget: { max_work_units: 4, max_repairs: 3 } };
  const { verdict: tooManyUnits } = await verdictFor(tight);
  assert.equal(tooManyUnits.status, 'unavailable');
  assert.equal(tooManyUnits.code, 'DGM_ENVELOPE_EXCEEDED');
  assert.equal(tooManyUnits.gates.find((entry) => entry.name === 'envelope_fits').passed, false);

  const noRepairs = { ...findWorkItem('sm-101'), budget: { max_work_units: 64, max_repairs: 0 } };
  const { verdict: repairs } = await verdictFor(noRepairs, { subject: 'baseline' });
  assert.equal(repairs.status, 'unavailable');
  assert.equal(repairs.code, 'DGM_ENVELOPE_EXCEEDED');
});

test('a malformed artifact fails without producing a score', async () => {
  const malformed = { ...findWorkItem('sm-106'), candidate: { kind: 'agent-change-bundle/v1' } };
  const { verdict } = await verdictFor(malformed);
  assert.equal(verdict.status, 'failed');
  assert.equal(verdict.code, 'DGM_BAD_ARTIFACT');
  assert.equal(verdict.gates.find((entry) => entry.name === 'artifact_well_formed').passed, false);
  assert.equal(verdict.applied, false);
});

test('a mutated request is refused before any scoring', async () => {
  const { request } = await verdictFor(findWorkItem('sm-106'));
  const mutated = { ...request, subject: 'baseline' };
  const verdict = await evaluate(findWorkItem('sm-106'), mutated);
  assert.equal(verdict.status, 'unavailable');
  assert.equal(verdict.code, 'DGM_REQUEST_TAMPERED');
  assert.equal(verdict.receipt, null);
  assert.deepEqual(verdict.checks.subject, []);
});

test('a post-seal artifact mutation is an identity mismatch, not a score', async () => {
  const workItem = findWorkItem('sm-104');
  const built = await buildRequest(workItem, { tamper: 'candidate' });
  assert.equal(built.ok, true);
  const verdict = await evaluate(workItem, built.request);
  assert.equal(verdict.status, 'unavailable');
  assert.equal(verdict.code, 'DGM_IDENTITY_MISMATCH');
  assert.equal(verdict.scores.subject_ppm, null);
  assert.equal(verdict.receipt, null);
  assert.equal(verdict.applied, false);
});

test('evaluation is deterministic across replays', async () => {
  const workItem = findWorkItem('sm-102');
  const { request } = await verdictFor(workItem, { subject: 'baseline' });
  const result = await replay(workItem, request, 4);
  assert.equal(result.identical, true);
  assert.equal(new Set(result.digests).size, 1);
});

test('verifyVerdict accepts the original and rejects any change', async () => {
  const workItem = findWorkItem('sm-103');
  const { request, verdict } = await verdictFor(workItem);

  const ok = await verifyVerdict(verdict, workItem, request);
  assert.equal(ok.ok, true);

  const tampered = { ...verdict, status: 'rejected' };
  const rejected = await verifyVerdict(tampered, workItem, request);
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /verdict/);

  const otherFixture = await verifyVerdict(verdict, findWorkItem('sm-105'), request);
  assert.equal(otherFixture.ok, false);
});

test('verdicts never carry secret-shaped fixture material', async () => {
  const { verdict } = await verdictFor(findWorkItem('sm-104'), { subject: 'baseline' });
  const serialized = JSON.stringify(verdict);
  assert.equal(serialized.includes('fixture-not-a-real-token'), false);
  assert.equal(verdict.status, 'rejected');
  assert.equal(verdict.repair_brief[0].id, 'C7');
});

test('event sequence is ordered and terminal', async () => {
  const { verdict } = await verdictFor(findWorkItem('sm-107'), { subject: 'baseline' });
  const sequences = verdict.events.map((event) => event.seq);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  assert.equal(new Set(sequences).size, sequences.length);
  assert.equal(verdict.events.at(-1).event, `evaluation.${verdict.status}`);
});

test('evaluate refuses missing arguments instead of throwing', async () => {
  const result = await evaluate(null, null);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DGM_BAD_INPUT');
  assert.equal((await evaluate(findWorkItem('sm-106'), null)).code, 'DGM_BAD_INPUT');
});

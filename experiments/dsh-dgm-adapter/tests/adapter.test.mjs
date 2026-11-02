import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_INPUT_KEYS,
  buildRequest,
  eligibility,
  fixtureIdentity,
  fromHarnessProposal,
  projectTicket,
  validateInput
} from '../src/adapter.mjs';
import { evaluate } from '../src/evaluate.mjs';
import { REQUEST_SCHEMA, WORK_ITEM_SCHEMA, AUTHORITY, EVALUATION_KIND } from '../src/contract.mjs';
import { WORK_ITEMS, findWorkItem } from '../fixtures/work-items.mjs';
import { digestOf, verifySeal } from '../src/canonical.mjs';

const item = findWorkItem('sm-106');

function withTicket(patch) {
  return { ...item, ticket: { ...item.ticket, ...patch } };
}

test('every fixture builds a sealed candidate request', async () => {
  for (const workItem of WORK_ITEMS) {
    const built = await buildRequest(workItem);
    assert.equal(built.ok, true, `${workItem.id} should build`);
    const request = built.request;
    assert.equal(request.schema, REQUEST_SCHEMA);
    assert.equal(request.authority, AUTHORITY);
    assert.equal(request.evaluation, EVALUATION_KIND);
    assert.equal(request.subject, 'candidate');
    assert.equal(request.tenant_id, 'fixture-tenant');
    assert.equal((await verifySeal(request, 'request_sha256')).ok, true);
  }
});

test('the request binds fixture, artifacts and criteria digests', async () => {
  const built = await buildRequest(item);
  const request = built.request;
  assert.equal(request.snapshot.fixture_sha256, await fixtureIdentity(item));
  assert.equal(request.snapshot.criteria_sha256, await digestOf(item.criteria));
  assert.equal(request.baseline.sha256, await digestOf(item.artifact));
  assert.equal(request.candidate.sha256, await digestOf(item.candidate));
  assert.equal(request.snapshot.fixture_id, item.id);
});

test('a baseline-subject request binds the same identities but decides the baseline', async () => {
  const built = await buildRequest(item, { subject: 'baseline' });
  assert.equal(built.ok, true);
  assert.equal(built.request.subject, 'baseline');
  assert.equal(built.request.candidate.sha256, await digestOf(item.candidate));

  const bad = await buildRequest(item, { subject: 'either' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'DGM_BAD_INPUT');
});

test('a post-seal tamper changes the candidate digest in the request', async () => {
  const honest = await buildRequest(item);
  const tampered = await buildRequest(item, { tamper: 'candidate' });
  assert.equal(tampered.ok, true);
  assert.notEqual(tampered.request.candidate.sha256, honest.request.candidate.sha256);
  assert.equal(tampered.request.snapshot.fixture_sha256, honest.request.snapshot.fixture_sha256);
});

test('unknown fixtures, empty criteria and unreadable tickets are refused', async () => {
  const unknown = await buildRequest({ ...item, schema: 'other/v9' });
  assert.equal(unknown.code, 'DGM_UNKNOWN_FIXTURE');

  const noCriteria = await buildRequest({ ...item, criteria: [] });
  assert.equal(noCriteria.code, 'DGM_NO_CRITERIA');

  const ended = await buildRequest(withTicket({ ended: '2026-11-01T00:00:00Z' }));
  assert.equal(ended.code, 'DGM_TICKET_ENDED');

  const noMandate = await buildRequest(withTicket({ mandate: null }));
  assert.equal(noMandate.code, 'DGM_NO_MANDATE');

  const blocked = await buildRequest(item, { reportState: 'blocked' });
  assert.equal(blocked.code, 'DGM_REPORT_NOT_REVIEWABLE');

  const pending = await buildRequest(item, { reportState: 'running' });
  assert.equal(pending.code, 'DGM_NOT_READY');
});

test('an inferred mandate needs auto mode', async () => {
  const inferred = withTicket({ mandate: { ...item.ticket.mandate, strength: 'inferred' }, accept_mode: 'observe' });
  assert.equal((await buildRequest(inferred)).code, 'DGM_MANDATE_WEAK');

  const inferredAuto = withTicket({ mandate: { ...item.ticket.mandate, strength: 'inferred' }, accept_mode: 'auto' });
  const built = await buildRequest(inferredAuto);
  assert.equal(built.ok, true);

  const nonsense = withTicket({ mandate: { ...item.ticket.mandate, strength: 'vibes' } });
  assert.equal((await buildRequest(nonsense)).code, 'DGM_BAD_MANDATE');
});

test('projectTicket truncates and surfaces only the fields the adapter reads', () => {
  const projected = projectTicket({
    id: 'tkt_x',
    title: 't'.repeat(400),
    mandate: { strength: 'explicit', policy_version: 'p', scope: 's' },
    report: { state: 'ready', summary: 'm' },
    accept_mode: 'observe',
    ended: null,
    ignored_field: 'should not surface'
  });
  assert.deepEqual(Object.keys(projected).sort(), [
    'accept_mode', 'ended', 'mandate', 'report_state', 'report_summary', 'ticket_id', 'title'
  ]);
  assert.equal(projected.title.length, 256);
  assert.equal(projectTicket(null), null);
});

test('eligibility is explicit about each refusal code', () => {
  const base = projectTicket(item.ticket);
  assert.equal(eligibility(base).ok, true);
  assert.equal(eligibility(null).code, 'DGM_NO_TICKET');
  assert.equal(eligibility({ ...base, ended: true }).code, 'DGM_TICKET_ENDED');
  assert.equal(eligibility({ ...base, mandate: null }).code, 'DGM_NO_MANDATE');
  assert.equal(eligibility({ ...base, mandate: { strength: 'inferred' }, accept_mode: 'observe' }).code, 'DGM_MANDATE_WEAK');
  assert.equal(eligibility({ ...base, mandate: { strength: 'other' } }).code, 'DGM_BAD_MANDATE');
  assert.equal(eligibility(base, { reportState: 'failed' }).code, 'DGM_REPORT_NOT_REVIEWABLE');
  assert.equal(eligibility(base, { reportState: 'ready' }).ok, true);
});

test('browser input cannot smuggle authority', () => {
  assert.deepEqual(ALLOWED_INPUT_KEYS, ['workItemId', 'reportState', 'tamper']);
  assert.equal(validateInput({}).ok, true);
  assert.equal(validateInput({ workItemId: 'sm-101' }).ok, true);
  assert.equal(validateInput(null).code, 'DGM_BAD_INPUT');
  assert.equal(validateInput([]).code, 'DGM_BAD_INPUT');
  for (const key of ['authority', 'applied', 'status', 'scores', 'verdict', 'request_sha256']) {
    const result = validateInput({ [key]: 'x' });
    assert.equal(result.ok, false, `${key} must be refused`);
    assert.equal(result.code, 'DGM_OVERRIDE');
  }
});

test('the Muse harness proposal shape maps without importing their module', async () => {
  const proposal = {
    problem: 'A thread is idle.',
    change: 'Ask the owner.',
    verification: 'Check the reply.'
  };
  const built = await fromHarnessProposal(proposal, { workItem: item });
  assert.equal(built.ok, true);
  assert.deepEqual(built.request.upstream.proposal, proposal);

  const noFixture = await fromHarnessProposal(proposal, {});
  assert.equal(noFixture.code, 'DGM_NO_FIXTURE');
});

test('fixture schema is the experiment-scoped identifier', () => {
  assert.equal(item.schema, WORK_ITEM_SCHEMA);
  assert.equal(WORK_ITEMS.length, 7);
});

test('the harness wrapper returns the effective fixture it sealed', async () => {
  const proposal = {
    problem: 'A different problem.',
    change: 'A different change.',
    verification: 'A different check.'
  };
  const built = await fromHarnessProposal(proposal, { workItem: item });
  assert.equal(built.ok, true);
  // The request binds a merged fixture, not the object that was passed in.
  // Callers must evaluate and select with the fixture the seal actually names.
  assert.equal(built.fixture.proposal.problem, proposal.problem);
  assert.notEqual(built.fixture, item);

  const againstSupplied = await evaluate(item, built.request);
  assert.equal(againstSupplied.code, 'DGM_IDENTITY_MISMATCH',
    'the supplied item does not reproduce the sealed request');

  const verdict = await evaluate(built.fixture, built.request);
  assert.notEqual(verdict.ok, false);
  assert.equal(verdict.provenance.fixture_sha256, built.request.snapshot.fixture_sha256);
  assert.equal(verdict.provenance.fixture_id, item.id);
});

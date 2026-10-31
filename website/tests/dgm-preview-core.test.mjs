/* Built with Meta Muse. */
// DGM fixture-preview pure-core tests (no D1): verdicts, gates, transitions,
// replay determinism, body validation, redaction, and telemetry summaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXTURES, RUN_STATUSES, TERMINAL_STATUSES, GATES, TERMINAL_OUTCOME,
  DISABLED_ACTIONS, ALLOWED_BODY_KEYS, FORBIDDEN_BODY_KEYS, MAX_LABEL_LEN,
  TARGET_NAME, BASELINE_SCORE_PPM, CANDIDATE_SCORE_PPM,
  transition, creationStatus, evaluateFixture, checkCreateBody, isRefusal,
  redactText, fixtureTelemetryRows, transitionOutcomeRow,
  latencySummary, outcomeCounts, tokensSummary, parseEventBody, buildTelemetryView
} from '../src/dgm/preview.mjs';

test('dgm core: contract tables list every fixture, state, gate, and key', () => {
  assert.deepEqual([...FIXTURES], ['good', 'bad-advice', 'over-budget', 'corrupt-receipt']);
  assert.deepEqual([...RUN_STATUSES],
    ['validation-rejected', 'paused', 'cancelled', 'failed', 'completed-preview']);
  for (const s of ['validation-rejected', 'cancelled', 'failed', 'completed-preview']) {
    assert.ok(TERMINAL_STATUSES.has(s), `${s} is terminal`);
  }
  assert.ok(!TERMINAL_STATUSES.has('paused'), 'paused is held, not terminal');
  assert.deepEqual([...GATES], ['target_bound', 'advice_shadow_only', 'envelope_fits', 'archive_settled']);
  assert.deepEqual(Object.keys(TERMINAL_OUTCOME).sort(), [...TERMINAL_STATUSES].sort());
  assert.deepEqual(Object.keys(DISABLED_ACTIONS).sort(),
    ['advise-live', 'execute', 'final-audit', 'promote', 'reserve']);
  for (const detail of Object.values(DISABLED_ACTIONS)) assert.match(detail, /disabled|not implemented/);
  assert.deepEqual([...ALLOWED_BODY_KEYS].sort(), ['fixture', 'held', 'label', 'target']);
  assert.ok(FORBIDDEN_BODY_KEYS.size >= 50);
  for (const k of ['seed', 'budgets', 'binding', 'protocol_id', 'receipt', 'idempotency_key']) {
    assert.ok(FORBIDDEN_BODY_KEYS.has(k), k);
  }
  assert.equal(MAX_LABEL_LEN, 128);
  assert.equal(TARGET_NAME, 'coord-jobs-v0');
});

test('dgm core: good completes VALIDATED with all gates passing', () => {
  const v = evaluateFixture('good');
  assert.equal(v.status, 'completed-preview');
  assert.equal(v.envelopeLabel, 'VALIDATED');
  assert.equal(v.adviceReason, 'shadow_only');
  assert.equal(v.budgetFits, true);
  assert.equal(v.budgetReason, 'fits_snapshot_only');
  assert.equal(v.settlement, 'success');
  assert.equal(v.gates.length, 4);
  assert.ok(v.gates.every((g) => g.passed));
  assert.deepEqual(v.gates.map((g) => g.name), [...GATES]);
  assert.equal(v.provenance.archive.length, 2);
  assert.equal(v.provenance.archive.filter((a) => !a.baseline).length, 1);
  assert.equal(v.provenance.candidateScorePpm, CANDIDATE_SCORE_PPM);
  assert.equal(v.provenance.baselineScorePpm, BASELINE_SCORE_PPM);
});

test('dgm core: bad-advice rejects on the adviser version before any run', () => {
  const v = evaluateFixture('bad-advice');
  assert.equal(v.status, 'validation-rejected');
  assert.equal(v.envelopeLabel, 'REJECTED');
  assert.equal(v.adviceReason, 'adviser_version_mismatch');
  assert.equal(v.budgetFits, true);
  assert.equal(v.settlement, 'not_attempted');
  assert.deepEqual(v.gates.map((g) => g.passed), [true, false, true, false]);
  assert.deepEqual(v.provenance.archive, []);
  assert.equal(v.provenance.candidateScorePpm, null);
});

test('dgm core: over-budget rejects on partition exhaustion', () => {
  const v = evaluateFixture('over-budget');
  assert.equal(v.status, 'validation-rejected');
  assert.equal(v.envelopeLabel, 'REJECTED');
  assert.equal(v.adviceReason, 'shadow_only');
  assert.equal(v.budgetFits, false);
  assert.equal(v.budgetReason, 'advice_partition_exhausted');
  assert.equal(v.settlement, 'not_attempted');
  assert.deepEqual(v.gates.map((g) => g.passed), [true, true, false, false]);
  assert.deepEqual(v.provenance.archive, []);
});

test('dgm core: corrupt-receipt validates then fails with the baseline intact', () => {
  const v = evaluateFixture('corrupt-receipt');
  assert.equal(v.status, 'failed');
  assert.equal(v.envelopeLabel, 'VALIDATED');
  assert.equal(v.settlement, 'stale_receipt');
  assert.deepEqual(v.gates.map((g) => g.passed), [true, true, true, false]);
  assert.match(v.gates[3].evidence, /stale_receipt/);
  assert.equal(v.provenance.archive.length, 1);
  assert.equal(v.provenance.archive[0].baseline, true);
  assert.equal(v.provenance.archive[0].scorePpm, BASELINE_SCORE_PPM);
});

test('dgm core: unknown fixtures throw, verdicts carry fixture identities', () => {
  assert.throws(() => evaluateFixture('evil'), RangeError);
  const v = evaluateFixture('good');
  assert.equal(v.provenance.fixtureTable, 'dgm-fixture-table/v1');
  for (const id of [v.provenance.protocolId, v.provenance.evaluationCohortId,
    v.provenance.envelopeIdentity, v.provenance.adviceResponseId]) {
    assert.match(id, /^fixture-[a-z]+-[0-9a-f]+$/);
  }
  assert.ok(v.events.length >= 4);
  assert.deepEqual(v.events.map((e) => e.sequence), v.events.map((_, i) => i));
});

test('dgm core: replay determinism — same fixture twice, identical gates and provenance', () => {
  for (const fixture of FIXTURES) {
    const a = evaluateFixture(fixture);
    const b = evaluateFixture(fixture);
    assert.deepEqual(a, b, fixture);
  }
  // Distinct fixtures diverge.
  assert.notDeepEqual(evaluateFixture('good').gates, evaluateFixture('bad-advice').gates);
  assert.notDeepEqual(evaluateFixture('good').provenance, evaluateFixture('over-budget').provenance);
});

test('dgm core: transitions allow only pause/resume/cancel along held edges', () => {
  assert.equal(transition('completed-preview', 'pause'), 'paused');
  assert.equal(transition('paused', 'resume'), 'completed-preview');
  assert.equal(transition('paused', 'cancel'), 'cancelled');
  for (const [status, action] of [
    ['paused', 'pause'], ['completed-preview', 'resume'], ['completed-preview', 'cancel'],
    ['validation-rejected', 'resume'], ['failed', 'cancel'], ['cancelled', 'pause'],
    ['paused', 'promote'], ['paused', 'explode']
  ]) {
    const out = transition(status, action);
    assert.ok(isRefusal(out), `${status}/${action}`);
    assert.equal(out.reason, 'DGM_PREVIEW_STATE');
    assert.ok(out.detail);
  }
});

test('dgm core: held creation pauses only valid verdicts', () => {
  assert.equal(creationStatus('completed-preview', true), 'paused');
  assert.equal(creationStatus('completed-preview', false), 'completed-preview');
  for (const s of ['validation-rejected', 'failed', 'cancelled']) {
    assert.equal(creationStatus(s, true), s, s);
    assert.equal(creationStatus(s, false), s, s);
  }
});

test('dgm core: create bodies accept only the documented keys and shapes', () => {
  const ok = checkCreateBody({ fixture: 'good' });
  assert.deepEqual(ok, { body: { fixture: 'good', held: false, label: '', target: 'coord-jobs-v0' } });
  const full = checkCreateBody({ fixture: 'good', held: true, label: 'look', target: 'coord-jobs-v0' });
  assert.equal(full.body.held, true);
  assert.equal(full.body.label, 'look');
  // Override keys fail as overrides, even alongside valid keys.
  for (const key of ['seed', 'budgets', 'binding', 'protocol_id', 'route', 'version']) {
    const out = checkCreateBody({ fixture: 'good', [key]: 'x' });
    assert.ok(isRefusal(out), key);
    assert.equal(out.reason, 'DGM_OVERRIDE', key);
  }
  // Unknown keys fail distinctly from overrides.
  const unknown = checkCreateBody({ fixture: 'good', typo: 1 });
  assert.ok(isRefusal(unknown));
  assert.equal(unknown.reason, 'DGM_BAD_BODY');
  // Fixture, held, label, and target shapes.
  assert.equal(checkCreateBody({ fixture: 'nope' }).reason, 'DGM_BAD_FIXTURE');
  assert.equal(checkCreateBody({}).reason, 'DGM_BAD_FIXTURE');
  assert.equal(checkCreateBody({ fixture: 'good', held: 'yes' }).reason, 'DGM_BAD_BODY');
  assert.equal(checkCreateBody({ fixture: 'good', label: 'x'.repeat(129) }).reason, 'DGM_BAD_BODY');
  assert.equal(checkCreateBody({ fixture: 'good', label: 7 }).reason, 'DGM_BAD_BODY');
  assert.equal(checkCreateBody({ fixture: 'good', target: '' }).reason, 'DGM_BAD_BODY');
  const target = checkCreateBody({ fixture: 'good', target: 'other-v0' });
  assert.equal(target.reason, 'DGM_UNKNOWN_TARGET');
  assert.match(target.detail, /coord-jobs-v0/);
  assert.equal(checkCreateBody(null).reason, 'DGM_BAD_BODY');
  assert.equal(checkCreateBody([['fixture', 'good']]).reason, 'DGM_BAD_BODY');
});

test('dgm core: labels are redacted at the boundary, counts untouched', () => {
  const out = checkCreateBody({ fixture: 'good', label: 'call Bearer abcDEF123._~+/=-x then ada@example.com ok' });
  assert.ok(!isRefusal(out));
  assert.ok(!out.body.label.includes('abcDEF123'), out.body.label);
  assert.ok(!out.body.label.includes('ada@example.com'), out.body.label);
  assert.ok(out.body.label.includes('[redacted]'));
  assert.ok(out.body.label.includes('call') && out.body.label.includes('ok'));
  assert.equal(redactText('plain 12 tokens'), 'plain 12 tokens');
  assert.equal(redactText(12), 12);
});

test('dgm core: creation telemetry rows carry env=fixture plus terminal outcomes', () => {
  const terminal = fixtureTelemetryRows('completed-preview');
  assert.deepEqual(terminal.map((r) => r.event),
    ['telemetry.latency', 'telemetry.resources', 'telemetry.tokens', 'telemetry.outcome']);
  for (const row of terminal) assert.equal(row.body.env, 'fixture');
  assert.equal(terminal[3].body.outcome, 'succeeded');
  assert.equal(fixtureTelemetryRows('validation-rejected').at(-1).body.outcome, 'refused');
  assert.equal(fixtureTelemetryRows('failed').at(-1).body.outcome, 'failed');
  assert.equal(fixtureTelemetryRows('cancelled').at(-1).body.outcome, 'cancelled');
  // Held runs emit no outcome row until they leave `paused`.
  const held = fixtureTelemetryRows('paused');
  assert.equal(held.length, 3);
  assert.ok(held.every((r) => r.event !== 'telemetry.outcome'));
  assert.equal(transitionOutcomeRow('completed-preview').body.outcome, 'succeeded');
  assert.equal(transitionOutcomeRow('cancelled').body.outcome, 'cancelled');
  assert.equal(transitionOutcomeRow('paused'), null);
});

test('dgm core: summaries report null when empty, never zero', () => {
  assert.deepEqual(latencySummary([]), { count: 0, p50_ms: null, p95_ms: null, status: 'unknown' });
  assert.deepEqual(latencySummary(['x', NaN]), { count: 0, p50_ms: null, p95_ms: null, status: 'unknown' });
  const one = latencySummary([12]);
  assert.deepEqual(one, { count: 1, p50_ms: 12, p95_ms: 12, status: 'ok' });
  const many = latencySummary([10, 20, 30, 40]);
  assert.equal(many.count, 4);
  assert.equal(many.p50_ms, 20);
  assert.equal(many.p95_ms, 40);
  assert.deepEqual(outcomeCounts([]), {});
  assert.deepEqual(outcomeCounts(['succeeded', 'succeeded', 'failed', '', null]),
    { succeeded: 2, failed: 1 });
  assert.deepEqual(tokensSummary([]),
    { source: 'estimate', prompt_tokens_est: null, completion_tokens_est: null, status: 'unknown' });
  assert.deepEqual(
    tokensSummary([{ source: 'estimate', prompt_tokens_est: 40, completion_tokens_est: 10 }]),
    { source: 'estimate', prompt_tokens_est: 40, completion_tokens_est: 10, status: 'ok' });
  // Authoritative rows never mix into the estimate block.
  assert.equal(tokensSummary([{ source: 'worker', prompt_tokens: 5 }]).status, 'unknown');
});

test('dgm core: telemetry views derive live from stored rows with explicit freshness', () => {
  const stored = (event, body) => ({ event, body_json: JSON.stringify(body) });
  const rows = fixtureTelemetryRows('completed-preview').map((r) => stored(r.event, r.body));
  const view = buildTelemetryView('run_v1_x', rows, CANDIDATE_SCORE_PPM);
  assert.equal(view.env, 'fixture');
  assert.equal(view.readStatus, 'ok');
  assert.equal(view.freshnessNote, 'fresh');
  assert.deepEqual(view.missing, []);
  assert.deepEqual(view.stale, []);
  assert.equal(view.unparsedRows, 0);
  assert.deepEqual(view.outcomeCounts, { succeeded: 1 });
  assert.deepEqual(view.latencySummary, { count: 1, p50_ms: 12, p95_ms: 12, status: 'ok' });
  assert.equal(view.tokensSummary.prompt_tokens_est, 40);
  // Held runs read stale until their outcome row lands.
  const heldView = buildTelemetryView('run_v1_y',
    fixtureTelemetryRows('paused').map((r) => stored(r.event, r.body)), CANDIDATE_SCORE_PPM);
  assert.equal(heldView.readStatus, 'stale');
  assert.deepEqual(heldView.stale, ['run_v1_y']);
  assert.deepEqual(heldView.outcomeCounts, {});
  // One corrupt row degrades the view instead of failing the read.
  const corrupt = buildTelemetryView('run_v1_x',
    [...rows, { event: 'telemetry.latency', body_json: '{oops' }], null);
  assert.equal(corrupt.readStatus, 'degraded');
  assert.equal(corrupt.unparsedRows, 1);
  assert.equal(corrupt.latencySummary.count, 1);
  assert.equal(parseEventBody('{oops'), null);
  assert.equal(parseEventBody('[1]'), null);
  assert.deepEqual(parseEventBody('{"a":1}'), { a: 1 });
});

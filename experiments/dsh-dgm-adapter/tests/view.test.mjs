import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRequest } from '../src/adapter.mjs';
import { evaluate } from '../src/evaluate.mjs';
import { runMeasurement } from '../src/measure.mjs';
import { findWorkItem } from '../fixtures/work-items.mjs';
import {
  BASELINE_CAVEAT,
  BASELINE_LABEL,
  checkRows,
  fixtureRows,
  formatPpm,
  gateRows,
  metricRows,
  selectionSummary,
  shortDigest,
  statusLabel,
  statusTone,
  verdictSummary
} from '../src/view.mjs';

test('formatters are total and readable', () => {
  assert.equal(formatPpm(1_000_000), '100.0%');
  assert.equal(formatPpm(0), '0.0%');
  assert.equal(formatPpm(500_000), '50.0%');
  assert.equal(formatPpm(null), 'n/a');
  assert.equal(formatPpm(undefined), 'n/a');
  assert.equal(shortDigest('a'.repeat(64)), 'a'.repeat(12));
  assert.equal(shortDigest(null), '');
  assert.equal(statusLabel('selected'), 'Selected');
  assert.equal(statusLabel('made-up'), 'made-up');
  assert.equal(statusTone('selected'), 'ok');
  assert.equal(statusTone('rejected'), 'warn');
  assert.equal(statusTone('unavailable'), 'muted');
});

test('metrics and fixture rows mirror the report', async () => {
  const report = await runMeasurement({ replays: 0 });
  const rows = metricRows(report);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].label, 'Defect admission');
  assert.equal(rows[0].baseline, '100.0%');
  assert.equal(rows[0].gate, '0.0%');
  assert.match(rows[0].hint, /parse-only/i, 'the baseline hint must name the policy');
  assert.equal(BASELINE_LABEL, 'Synthetic no-gate reference');
  assert.match(BASELINE_CAVEAT, /human pull-request review is excluded/i);

  const fixtures = fixtureRows(report);
  assert.equal(fixtures.length, 7);
  assert.ok(fixtures.every((fixture) => fixture.baseline && fixture.candidate));
  assert.equal(fixtures[0].id, 'sm-101');
  assert.deepEqual(fixtures[0].baseline.labelled_defects, ['C1', 'C3']);
});

test('verdict and selection summaries expose no actionable authority', async () => {
  const workItem = findWorkItem('sm-106');
  const built = await buildRequest(workItem);
  const verdict = await evaluate(workItem, built.request);
  const summary = verdictSummary(verdict);

  assert.equal(summary.applied, false);
  assert.equal(summary.authority, 'shadow_only');
  assert.equal(summary.status, 'selected');
  assert.equal(summary.subjectPpm, '100.0%');
  assert.equal(summary.repairItems, 0);
  assert.equal(gateRows(verdict).length, 6);
  assert.equal(checkRows(verdict, 'subject').length, 8);
  assert.equal(checkRows(verdict).every((check) => check.passed), true);

  assert.equal(selectionSummary(null).empty, true);
});

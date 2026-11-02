import test from 'node:test';
import assert from 'node:assert/strict';

import { runMeasurement } from '../src/measure.mjs';
import { LIMITATIONS } from '../src/contract.mjs';
import { WORK_ITEMS } from '../fixtures/work-items.mjs';

test('the sweep covers every fixture on both sides', async () => {
  const report = await runMeasurement({ replays: 1 });
  assert.equal(report.fixtures, WORK_ITEMS.length);
  assert.equal(report.artifacts, WORK_ITEMS.length * 2);
  assert.equal(report.rows.length, report.artifacts);
  assert.deepEqual(report.policies, ['synthetic-no-gate', 'dgm-gate']);
  assert.ok(report.limitations.length > LIMITATIONS.length);

  // The reference column must not be readable as upstream or model performance.
  assert.match(report.policy_labels['synthetic-no-gate'], /no-gate/i);
  assert.match(report.policy_labels['synthetic-no-gate'], /human pull-request review excluded/i);
  assert.ok(report.limitations.some((line) => /human review/i.test(line)));
  assert.equal(/upstream-parse-only/.test(JSON.stringify(report)), false);
});

test('the gate catches exactly the labelled defects and rejects nothing clean', async () => {
  const report = await runMeasurement({ replays: 1 });
  const gate = report.metrics['dgm-gate'];

  assert.equal(gate.defect_admission_ppm, 0);
  assert.equal(gate.false_rejection_ppm, 0);
  assert.equal(gate.labelled_defects_missed, 0);
  assert.equal(gate.unlabelled_failures, 0);
  assert.equal(gate.exact_label_matches, gate.defective_artifacts);
  assert.equal(gate.clean_without_failures, gate.clean_artifacts);
  assert.equal(
    gate.labelled_defects_detected,
    WORK_ITEMS.reduce((sum, workItem) => sum + workItem.defects.length, 0)
  );
});

test('the synthetic no-gate reference admits every defective artifact', async () => {
  const report = await runMeasurement({ replays: 1 });
  const parse = report.metrics['synthetic-no-gate'];
  assert.equal(parse.defect_admission_ppm, 1_000_000);
  assert.equal(parse.criteria_coverage_ppm, 0);
  assert.equal(parse.work_units_total, report.artifacts);
});

test('every verdict in the sweep replays identically', async () => {
  const report = await runMeasurement({ replays: 2 });
  assert.equal(report.determinism.all_replays_identical, true);
  assert.equal(report.determinism.distinct_digests, report.artifacts);
  assert.ok(report.rows.every((row) => row.deterministic !== false));
});

test('the report digest is reproducible and excludes latency', async () => {
  const withoutTimer = await runMeasurement({ replays: 0 });
  const again = await runMeasurement({ replays: 0 });
  assert.equal(withoutTimer.report_sha256, again.report_sha256);
  assert.equal(withoutTimer.latency.samples, 0);

  let clock = 0;
  const withTimer = await runMeasurement({ replays: 0, now: () => (clock += 7.5) });
  assert.ok(withTimer.latency.samples > 0);
  assert.equal(withTimer.report_sha256, withoutTimer.report_sha256, 'latency must not enter the digest');
});

test('evidence is only collected when asked for', async () => {
  const quiet = await runMeasurement({ replays: 0 });
  assert.deepEqual(quiet.evidence, []);

  const kept = await runMeasurement({ replays: 0, keepVerdicts: true });
  assert.equal(kept.evidence.length, kept.artifacts);
  assert.equal(kept.report_sha256, quiet.report_sha256);
  assert.ok(kept.evidence.every((entry) => entry.verdict && entry.request));
});


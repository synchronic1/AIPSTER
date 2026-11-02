#!/usr/bin/env node
// Run the fixture sweep and write a reproducible measurement report.
//
//   node scripts/measure.mjs            # write artifacts/measurement.json
//   node scripts/measure.mjs --json     # print the report to stdout
//   node scripts/measure.mjs --replays 3
//
// Latency is measured here and stored, but it is excluded from the report
// digest: it is machine-dependent and never evidence of quality.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMeasurement } from '../src/measure.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const replayIndex = argv.indexOf('--replays');
const replays = replayIndex === -1 ? 2 : Number(argv[replayIndex + 1]);

if (!Number.isInteger(replays) || replays < 0 || replays > 10) {
  console.error('--replays must be an integer between 0 and 10');
  process.exit(2);
}

const startedAt = process.hrtime.bigint();
const report = await runMeasurement({
  now: () => Number(process.hrtime.bigint() - startedAt) / 1e6,
  replays
});

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const outDir = join(root, 'artifacts');
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, 'measurement.json');
  await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const parse = report.metrics['synthetic-no-gate'];
  const gate = report.metrics['dgm-gate'];
  const pct = (value) => (value === null ? 'n/a' : `${(value / 10_000).toFixed(1)}%`);

  console.log('DSH x DGM fixture sweep (synthetic fixtures, no model)');
  console.log(`  fixtures ${report.fixtures}  artifacts ${report.artifacts}  predicates/artifact ${report.rows[0]?.gate_policy?.subject_predicates ?? 'n/a'}`);
  console.log('  reference column: synthetic NO-GATE policy (parse-only); upstream human PR review EXCLUDED.');
  console.log('');
  console.log('  metric                     synthetic-no-gate        dgm-gate');
  console.log(`  defect admission           ${pct(parse.defect_admission_ppm).padEnd(22)}  ${pct(gate.defect_admission_ppm)}`);
  console.log(`  false rejection            ${pct(parse.false_rejection_ppm).padEnd(22)}  ${pct(gate.false_rejection_ppm)}`);
  console.log(`  criteria coverage          ${pct(parse.criteria_coverage_ppm).padEnd(22)}  ${pct(gate.criteria_coverage_ppm)}`);
  console.log(`  work units (total)         ${String(parse.work_units_total).padEnd(22)}  ${gate.work_units_total}`);
  console.log(`  repair items (total)       ${String(parse.repair_items_total).padEnd(22)}  ${gate.repair_items_total}`);
  console.log('');
  console.log(`  labelled defects detected  ${gate.labelled_defects_detected}`);
  console.log(`  labelled defects missed    ${gate.labelled_defects_missed}`);
  console.log(`  unlabelled failures        ${gate.unlabelled_failures}`);
  console.log(`  exact label matches        ${gate.exact_label_matches}/${gate.defective_artifacts}`);
  console.log(`  clean artifacts untouched  ${gate.clean_without_failures}/${gate.clean_artifacts}`);
  console.log(`  replay determinism         ${report.determinism.all_replays_identical ? 'identical' : 'DIVERGED'} (${report.determinism.distinct_digests} distinct digests, ${report.repeats_per_request} repeats/request)`);
  console.log(`  latency p50 / p95 (ms)     ${report.latency.p50_ms.toFixed(2)} / ${report.latency.p95_ms.toFixed(2)} (not digested)`);
  console.log('');
  console.log(`  report digest              ${report.report_sha256}  (repeats_per_request ${report.repeats_per_request})`);
  console.log(`  written                    ${outFile}`);
  console.log('');
  console.log('  Fixture-relative. No model ran. Fewer steps is not improvement.');
  console.log('  Not a measurement of dsh-superagent, DeepSeek Harness or any model.');
}

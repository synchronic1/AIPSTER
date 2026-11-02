// Child process for the runtime no-effect test. Run with:
//   node --import ./tests/no-effect-preload.mjs ./tests/no-effect-probe.mjs
//
// It exercises every delivered code path (build, evaluate, measure, select,
// rollback) and prints one JSON line. Any capability trap the preload installed
// is visible in `hits`. The deliberate fetch at the end proves the trap works:
// a capability-level trap catches a spelling the static scan misses.

import { runMeasurement } from '../src/measure.mjs';
import { buildRequest } from '../src/adapter.mjs';
import { evaluate } from '../src/evaluate.mjs';
import { requestRollback, select } from '../src/selection.mjs';
import { WORK_ITEMS } from '../fixtures/work-items.mjs';

const envBefore = new Map(Object.entries(process.env));

const report = await runMeasurement({ replays: 1, keepVerdicts: true });
const built = await buildRequest(WORK_ITEMS[0]);
const verdict = await evaluate(WORK_ITEMS[0], built.request);
const candidates = report.evidence
  .filter((entry) => entry.subject === 'candidate')
  .map((entry) => entry.verdict);
const selection = await select(candidates, { fixtures: WORK_ITEMS });
const rollback = selection.ok ? requestRollback(selection.selection) : { ok: false, code: selection.code };

// Deliberate capability probe: the preload must catch this form, which the
// source-spelling scan in invariants.test.mjs does not.
let probeCaught = false;
try {
  await globalThis['fetch']('http://127.0.0.1:1/never');
} catch {
  probeCaught = true;
}

const envAfter = new Map(Object.entries(process.env));
const envDiff = [];
for (const [key, value] of envAfter) {
  if (envBefore.get(key) !== value) envDiff.push(`${key}:${envBefore.has(key) ? 'changed' : 'added'}`);
}
for (const key of envBefore.keys()) {
  if (!envAfter.has(key)) envDiff.push(`${key}:removed`);
}

process.stdout.write(`${JSON.stringify({
  verdicts: report.artifacts,
  distinct_digests: report.determinism.distinct_digests,
  report_sha256: report.report_sha256,
  selected_status: verdict.status,
  selection_ok: selection.ok,
  selection_code: selection.ok ? null : selection.code,
  rollback_executed: rollback.ok ? rollback.record.executed : null,
  env_unchanged: envDiff.length === 0,
  env_diff: envDiff,
  probe_caught: probeCaught,
  hits: globalThis.__dshDgmEffectHits
})}\n`);

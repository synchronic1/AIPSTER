// Reproducible measurement over the synthetic fixtures.
//
// Two policies, same fixtures, same contract:
//   synthetic-no-gate  if the artifact parses, it is admissible (no gate at all)
//   dgm-gate           every acceptance predicate + identity + envelope + receipt
//
// The no-gate column is NOT upstream's behaviour. Upstream reviews the resulting
// pull request by hand; that human review is excluded here, so this is a
// "gate vs no gate" reference point, never an improvement claim about
// dsh-superagent, DeepSeek Harness or any model.
//
// Every number below is derived from authored fixture labels. Latency is
// collected separately and is excluded from the report digest: it varies by
// machine and is not evidence of quality.

import { digestOf } from './canonical.mjs';
import { buildRequest } from './adapter.mjs';
import { baselinePolicy, evaluate } from './evaluate.mjs';
import { WORK_ITEMS } from '../fixtures/work-items.mjs';
import { LIMITATIONS, isRefusal } from './contract.mjs';

export const MEASUREMENT_SCHEMA = 'aipster.dsh-dgm.measurement/v1';
export const POLICIES = Object.freeze(['synthetic-no-gate', 'dgm-gate']);
export const POLICY_LABELS = Object.freeze({
  'synthetic-no-gate': 'Synthetic no-gate reference: parse-only admission, upstream human pull-request review excluded',
  'dgm-gate': 'DGM fixture gate: deterministic predicates, identity, envelope and receipt'
});

function rate(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1_000_000);
}

function percentile(samples, fraction) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function labelSet(workItem, subject) {
  return subject === 'baseline' ? [...workItem.defects] : [];
}

/**
 * Run the sweep.
 *
 * @param {object} options
 * @param {() => number} [options.now] zero-argument monotonic clock in milliseconds; omit to skip latency
 * @param {number} [options.replays] verification replays per request
 * @param {boolean} [options.keepVerdicts] keep full requests/verdicts in `report.evidence`
 */
export async function runMeasurement({ now = null, replays = 2, keepVerdicts = false } = {}) {
  const rows = [];
  const evidence = [];
  const latencySamples = [];
  const gateDigests = [];

  for (const workItem of WORK_ITEMS) {
    for (const subject of ['baseline', 'candidate']) {
      const artifact = subject === 'baseline' ? workItem.artifact : workItem.candidate;
      const labelled = labelSet(workItem, subject);
      const parsePolicy = baselinePolicy(artifact);

      const built = await buildRequest(workItem, { subject });
      if (!built.ok) {
        rows.push({
          fixture_id: workItem.id,
          subject,
          labelled_defects: labelled,
          unavailable: built.code,
          detail: built.detail
        });
        continue;
      }

      const started = now ? now() : 0;
      const verdict = await evaluate(workItem, built.request);
      if (now) latencySamples.push(now() - started);
      if (isRefusal(verdict)) {
        rows.push({
          fixture_id: workItem.id,
          subject,
          labelled_defects: labelled,
          unavailable: verdict.code,
          detail: verdict.detail
        });
        continue;
      }

      const failedIds = verdict.checks.subject.filter((check) => !check.passed).map((check) => check.id);
      const detected = labelled.filter((id) => failedIds.includes(id));
      const missed = labelled.filter((id) => !failedIds.includes(id));
      const extra = failedIds.filter((id) => !labelled.includes(id));

      let deterministic = true;
      for (let index = 0; index < replays; index += 1) {
        const replayed = await evaluate(workItem, built.request);
        if (replayed.verdict_sha256 !== verdict.verdict_sha256) deterministic = false;
      }
      gateDigests.push(verdict.verdict_sha256);
      if (keepVerdicts) evidence.push({ fixture_id: workItem.id, subject, request: built.request, verdict });

      rows.push({
        fixture_id: workItem.id,
        subject,
        labelled_defects: labelled,
        parse_policy: {
          status: parsePolicy.status,
          work_units: parsePolicy.work_units,
          admitted_defect: parsePolicy.status === 'selected' && labelled.length > 0,
          rejected_clean: parsePolicy.status !== 'selected' && labelled.length === 0
        },
        gate_policy: {
          status: verdict.status,
          code: verdict.code,
          subject_ppm: verdict.scores.subject_ppm,
          reference_ppm: verdict.scores.reference_ppm,
          work_units: verdict.work_units,
          subject_predicates: verdict.checks.subject.length,
          reference_predicates: verdict.checks.reference.length,
          admitted_defect: verdict.status === 'selected' && labelled.length > 0,
          rejected_clean: verdict.status !== 'selected' && labelled.length === 0,
          detected_defects: detected,
          missed_defects: missed,
          extra_failures: extra,
          repair_items: verdict.repair_brief.map((item) => item.id),
          exact_labels: detected.length === labelled.length && extra.length === 0
        },
        digests: {
          request_sha256: built.request.request_sha256,
          verdict_sha256: verdict.verdict_sha256
        },
        deterministic
      });
    }
  }

  const defective = rows.filter((row) => row.labelled_defects.length > 0);
  const clean = rows.filter((row) => row.labelled_defects.length === 0);
  const gateRows = rows.filter((row) => row.gate_policy);
  const criteriaDefined = criteriaPerArtifact() * rows.length;

  const metrics = {
    'synthetic-no-gate': {
      artifacts: rows.length,
      defect_admission_ppm: rate(rows.filter((row) => row.parse_policy && row.parse_policy.admitted_defect).length, defective.length),
      false_rejection_ppm: rate(rows.filter((row) => row.parse_policy && row.parse_policy.rejected_clean).length, clean.length),
      work_units_total: rows.reduce((sum, row) => sum + (row.parse_policy ? row.parse_policy.work_units : 0), 0),
      repair_items_total: 0,
      criteria_coverage_ppm: rate(0, criteriaDefined)
    },
    'dgm-gate': {
      artifacts: gateRows.length,
      defect_admission_ppm: rate(gateRows.filter((row) => row.gate_policy.admitted_defect).length, defective.length),
      false_rejection_ppm: rate(gateRows.filter((row) => row.gate_policy.rejected_clean).length, clean.length),
      work_units_total: gateRows.reduce((sum, row) => sum + row.gate_policy.work_units, 0),
      repair_items_total: gateRows.reduce((sum, row) => sum + row.gate_policy.repair_items.length, 0),
      criteria_coverage_ppm: rate(
        gateRows.reduce((sum, row) => sum + row.gate_policy.subject_predicates, 0),
        criteriaDefined
      ),
      labelled_defects_detected: gateRows.reduce((sum, row) => sum + row.gate_policy.detected_defects.length, 0),
      labelled_defects_missed: gateRows.reduce((sum, row) => sum + row.gate_policy.missed_defects.length, 0),
      unlabelled_failures: gateRows.reduce((sum, row) => sum + row.gate_policy.extra_failures.length, 0),
      exact_label_matches: defective.filter((row) => row.gate_policy && row.gate_policy.exact_labels).length,
      defective_artifacts: defective.length,
      clean_without_failures: clean.filter((row) => row.gate_policy && row.gate_policy.repair_items.length === 0).length,
      clean_artifacts: clean.length
    }
  };

  const latency = now
    ? {
        samples: latencySamples.length,
        p50_ms: percentile(latencySamples, 0.5),
        p95_ms: percentile(latencySamples, 0.95),
        max_ms: latencySamples.length ? Math.max(...latencySamples) : null,
        note: 'observed wall time on this machine; excluded from the report digest; not evidence of speed'
      }
    : { samples: 0, note: 'no timer was supplied; latency was not measured' };

  const report = {
    schema: MEASUREMENT_SCHEMA,
    fixtures: WORK_ITEMS.length,
    artifacts: rows.length,
    policies: [...POLICIES],
    policy_labels: { ...POLICY_LABELS },
    subject_sets: {
      baseline: 'the fixture artifact that carries the authored labelled defects',
      candidate: 'the repaired candidate artifact; clean by construction'
    },
    repeats_per_request: replays,
    metrics,
    determinism: {
      verdicts: gateDigests.length,
      distinct_digests: new Set(gateDigests).size,
      all_replays_identical: rows.every((row) => row.deterministic !== false)
    },
    latency,
    rows,
    evidence: keepVerdicts ? evidence : [],
    limitations: [
      ...LIMITATIONS,
      'Metrics are fixture-relative: seven authored work items, fourteen artifacts, eight predicates.',
      'The two policies differ in what they check, not in model or data; this is a gate comparison, not a capability comparison.',
      'The no-gate column omits upstream human review of the pull request, which is the control that would catch these defects in practice. Do not read it as upstream performance.',
      'A lower work-unit count is not a quality gain; it is a smaller predicate set.'
    ]
  };

  // Explicit whitelist: adding a field to the report must not silently change
  // the digest, and latency/evidence must never enter it.
  report.report_sha256 = await digestOf({
    schema: report.schema,
    fixtures: report.fixtures,
    artifacts: report.artifacts,
    policies: report.policies,
    policy_labels: report.policy_labels,
    subject_sets: report.subject_sets,
    repeats_per_request: report.repeats_per_request,
    metrics: report.metrics,
    determinism: report.determinism,
    rows: report.rows,
    limitations: report.limitations
  });
  return report;
}

function criteriaPerArtifact() {
  // Every fixture shares one frozen acceptance contract, so any fixture answers.
  return WORK_ITEMS[0] ? WORK_ITEMS[0].criteria.length : 0;
}

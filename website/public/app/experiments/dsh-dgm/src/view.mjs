// Pure view model: report/verdict -> display values.
//
// No DOM, no clock, no randomness. Fixture strings are passed through as plain
// text by the renderer; nothing here is interpolated into markup.

export function formatPpm(ppm) {
  if (ppm === null || ppm === undefined) return 'n/a';
  return `${(ppm / 10_000).toFixed(1)}%`;
}

export function shortDigest(digest, length = 12) {
  if (typeof digest !== 'string') return '';
  return digest.slice(0, length);
}

const STATUS_LABELS = Object.freeze({
  selected: 'Selected',
  rejected: 'Rejected',
  failed: 'Failed',
  unavailable: 'Unavailable',
  disabled: 'Disabled'
});

const STATUS_TONES = Object.freeze({
  selected: 'ok',
  rejected: 'warn',
  failed: 'bad',
  unavailable: 'muted',
  disabled: 'muted'
});

export function statusLabel(status) {
  return STATUS_LABELS[status] || String(status || 'unknown');
}

export function statusTone(status) {
  return STATUS_TONES[status] || 'muted';
}

// The comparison column is a synthetic no-gate reference, not upstream's
// behaviour: upstream reviews the resulting pull request by hand, and that
// human review is excluded from this measurement. The label travels with the
// numbers so the percentage cannot be quoted without it.
export const BASELINE_LABEL = 'Synthetic no-gate reference';
export const BASELINE_CAVEAT = 'parse-only admission; upstream human pull-request review is excluded';

export function metricRows(report) {
  const parse = report.metrics['synthetic-no-gate'];
  const gate = report.metrics['dgm-gate'];
  return [
    {
      label: 'Defect admission',
      hint: 'defective artifacts a parse-only check would pass to human review ÷ defective artifacts',
      baseline: formatPpm(parse.defect_admission_ppm),
      gate: formatPpm(gate.defect_admission_ppm),
      better: 'lower'
    },
    {
      label: 'False rejection',
      hint: 'clean artifacts a parse-only check would still admit ÷ clean artifacts',
      baseline: formatPpm(parse.false_rejection_ppm),
      gate: formatPpm(gate.false_rejection_ppm),
      better: 'lower'
    },
    {
      label: 'Criteria coverage',
      hint: 'acceptance predicates executed ÷ predicates defined',
      baseline: formatPpm(parse.criteria_coverage_ppm),
      gate: formatPpm(gate.criteria_coverage_ppm),
      better: 'higher'
    },
    {
      label: 'Work units',
      hint: 'deterministic predicate evaluations, total',
      baseline: String(parse.work_units_total),
      gate: String(gate.work_units_total),
      better: 'lower'
    },
    {
      label: 'Repair items',
      hint: 'failed predicates returned to the upstream executor',
      baseline: String(parse.repair_items_total),
      gate: String(gate.repair_items_total),
      better: 'lower'
    }
  ];
}

/** Group the flat measurement rows into one entry per fixture. */
export function fixtureRows(report) {
  const byFixture = new Map();
  for (const row of report.rows) {
    if (!byFixture.has(row.fixture_id)) {
      byFixture.set(row.fixture_id, { id: row.fixture_id, baseline: null, candidate: null });
    }
    byFixture.get(row.fixture_id)[row.subject] = row;
  }
  return [...byFixture.values()];
}

export function gateRows(verdict) {
  return verdict.gates.map((entry) => ({
    name: entry.name,
    passed: entry.passed,
    detail: entry.detail
  }));
}

export function checkRows(verdict, side = 'subject') {
  const checks = verdict.checks[side] || [];
  return checks.map((check) => ({
    id: check.id,
    statement: check.statement,
    passed: check.passed,
    detail: check.detail
  }));
}

export function verdictSummary(verdict) {
  return {
    status: verdict.status,
    tone: statusTone(verdict.status),
    label: statusLabel(verdict.status),
    code: verdict.code,
    detail: verdict.detail,
    subjectPpm: formatPpm(verdict.scores.subject_ppm),
    referencePpm: formatPpm(verdict.scores.reference_ppm),
    workUnits: verdict.work_units,
    repairItems: verdict.repair_brief.length,
    verdictDigest: verdict.verdict_sha256,
    receiptDigest: verdict.receipt ? verdict.receipt.receipt_sha256 : null,
    requestDigest: verdict.request_sha256,
    applied: verdict.applied,
    authority: verdict.authority
  };
}

export function selectionSummary(selection) {
  if (!selection) {
    return { empty: true, note: 'No selection has been made. Run the sweep, then select from the passing candidates.' };
  }
  return {
    empty: false,
    selectionId: selection.selection_id,
    selected: selection.selected,
    considered: selection.considered.length,
    rejected: selection.rejected.length,
    rollback: selection.rollback,
    applied: selection.applied,
    digest: selection.selection_sha256,
    note: selection.note
  };
}

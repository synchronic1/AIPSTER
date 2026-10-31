/* Built with Meta Muse. */
// Deterministic fixture-table DGM preview evaluation (dependency-free).
//
// This module is the Worker's entire DGM "evaluation": a pure table that maps
// each fixture name to its fixed verdict. The Python DGM harness (advice
// checks, controller, stub runner) does NOT run here and its digests are not
// reproduced; provenance identities below are fixture-table values, stable
// per fixture but distinct from the harness. What IS real on this path:
// Cloudflare request handling, session/grant authorization, D1 persistence,
// audit rows, and the fixture telemetry rows derived from stored events.
//
// Contract vocabulary mirrored from the stack preview slice
// (fixtures, states, gates, events, reason strings); API field casing
// follows house camelCase. States `loading`/`empty` are UI-only.

export const PREVIEW_SCHEMA = 'aipster.dgm.preview/v1';
export const RUN_SCHEMA = 'aipster.dgm.preview-run/v1';
export const FIXTURE_TABLE = 'dgm-fixture-table/v1';

export const VALIDATED = 'VALIDATED';
export const REJECTED = 'REJECTED';

export const FIXTURE_SEED = 'dgm-preview-seed-v1';
export const FIXTURE_ADVISER_VERSION = 'rules/v1';

export const FIXTURES = ['good', 'bad-advice', 'over-budget', 'corrupt-receipt'];

export const TARGET_NAME = 'coord-jobs-v0';
export const ENDPOINT_KIND = 'coord-jobs';

export const BASELINE_SCORE_PPM = 500000;
export const CANDIDATE_SCORE_PPM = 700000;

export const STATUS_LOADING = 'loading';
export const STATUS_EMPTY = 'empty';
export const STATUS_VALIDATION_REJECTED = 'validation-rejected';
export const STATUS_PAUSED = 'paused';
export const STATUS_CANCELLED = 'cancelled';
export const STATUS_FAILED = 'failed';
export const STATUS_COMPLETED = 'completed-preview';

export const RUN_STATUSES = [
  STATUS_VALIDATION_REJECTED,
  STATUS_PAUSED,
  STATUS_CANCELLED,
  STATUS_FAILED,
  STATUS_COMPLETED
];
export const TERMINAL_STATUSES = new Set([
  STATUS_VALIDATION_REJECTED,
  STATUS_CANCELLED,
  STATUS_FAILED,
  STATUS_COMPLETED
]);

export const GATES = ['target_bound', 'advice_shadow_only', 'envelope_fits', 'archive_settled'];

// Terminal telemetry outcome per run status (stack TERMINAL_OUTCOME parity).
// Paused runs carry no outcome row until they leave `paused`.
export const TERMINAL_OUTCOME = {
  [STATUS_COMPLETED]: 'succeeded',
  [STATUS_VALIDATION_REJECTED]: 'refused',
  [STATUS_FAILED]: 'failed',
  [STATUS_CANCELLED]: 'cancelled'
};

// Disabled actions and their refusal detail. There is deliberately no
// enabler: no flag, no body key, and no exported setter changes this table,
// and the router refuses these before any run lookup.
export const DISABLED_ACTIONS = {
  promote: 'promotion is disabled; no code path enables it',
  execute: 'execution is disabled; no code path enables it',
  reserve: 'advice reservation is not implemented',
  'final-audit': 'final_audit is disabled; no code path enables it',
  'advise-live': 'live_adviser is disabled; no code path enables it'
};

export const ALLOWED_BODY_KEYS = ['fixture', 'held', 'label', 'target'];
export const MAX_LABEL_LEN = 128;

// Controller validation, budgets and bindings. Any browser-supplied key here
// is an override attempt (stack targets.py FORBIDDEN_BODY_KEYS parity).
export const FORBIDDEN_BODY_KEYS = new Set([
  'protocol', 'protocol_id', 'evaluation_cohort_id', 'controller_sha256',
  'evaluator_sha256', 'runner_sha256', 'model_sha256', 'backend_sha256',
  'search_tasks_sha256', 'source_snapshot_sha256', 'evaluator_id', 'seed',
  'validators', 'signature', 'receipt', 'baseline', 'candidate', 'candidate_id',
  'artifact_sha256', 'parent_id', 'hypothesis_sha256', 'dependency_sha256',
  'researcher_sha256', 'config_sha256', 'budgets', 'total', 'per_attempt',
  'max_attempts', 'max_steps', 'max_trials', 'concurrency', 'archive_cap',
  'campaign_deadline_ms', 'termination_margin_ms', 'local_margin_ppm',
  'noise_allowance_ppm', 'exploration_numerator', 'exploration_denominator',
  'resources', 'reserved', 'used', 'bindings', 'binding', 'mutation_paths',
  'route', 'version', 'partition_config_sha256', 'snapshot_id', 'decision_id',
  'adviser_version', 'evidence_ids', 'campaign_id', 'attempt_id',
  'idempotency_key'
]);

export function previewRefused(reason, detail) {
  // Plain-data refusal (no Error subclass): the router maps it to HTTP.
  return { refused: true, reason, detail: detail || '' };
}

export function isRefusal(v) {
  return !!v && typeof v === 'object' && v.refused === true;
}

export function transition(status, action) {
  // Pure state machine. `pause` re-holds a completed preview for inspection.
  // Returns the next status or a refusal; the run is unchanged on refusal.
  if (action === 'pause' && status === STATUS_COMPLETED) return STATUS_PAUSED;
  if (action === 'resume' && status === STATUS_PAUSED) return STATUS_COMPLETED;
  if (action === 'cancel' && status === STATUS_PAUSED) return STATUS_CANCELLED;
  if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
    return previewRefused('DGM_PREVIEW_STATE', `unknown preview action ${JSON.stringify(action)}`);
  }
  return previewRefused('DGM_PREVIEW_STATE', `cannot ${action} a run in state ${JSON.stringify(status)}`);
}

export function creationStatus(verdictStatus, held) {
  // A fresh valid verdict pauses when held; every other verdict keeps its
  // terminal state. Held has no effect on rejected/failed runs.
  if (held === true && verdictStatus === STATUS_COMPLETED) return STATUS_PAUSED;
  return verdictStatus;
}

// cyrb53 over UTF-16 code units, hex rendered. Deterministic across
// isolates without async crypto; fixture-table identities only, never
// confused with harness digests (all carry the `fixture-` prefix at use).
function cyrb53(text, seed) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

function fixtureId(kind, fixture) {
  const text = `${FIXTURE_SEED}|${kind}|${fixture}`;
  return `fixture-${kind}-${cyrb53(text, 0x9e37)}${cyrb53(text, 0x85eb)}`;
}

function gate(name, passed, evidence) {
  return { name, passed, evidence };
}

function archiveEntry(execution, candidateIdentity, scorePpm, receiptId, baseline) {
  return { execution, candidateIdentity, scorePpm, receiptId, baseline };
}

export function evaluateFixture(fixture) {
  // Fixed verdict per fixture. Throws RangeError on unknown fixtures.
  // Returned provenance/gates are deep-equal across calls (replay
  // determinism); run/task ids and timestamps are assigned by the router.
  if (!FIXTURES.includes(fixture)) {
    throw new RangeError(`unknown preview fixture ${JSON.stringify(fixture)}; known: ${FIXTURES.join(', ')}`);
  }
  const adviceOk = fixture !== 'bad-advice';
  const budgetOk = fixture !== 'over-budget';
  const adviceReason = adviceOk ? 'shadow_only' : 'adviser_version_mismatch';
  const budgetReason = budgetOk ? 'fits_snapshot_only' : 'advice_partition_exhausted';
  const label = adviceOk && budgetOk ? VALIDATED : REJECTED;
  const events = [];
  const record = (event, detail) => events.push({ sequence: events.length, event, detail: detail || '' });

  const gates = [
    gate('target_bound', true, 'server binding matches the fixture protocol'),
    gate('advice_shadow_only', adviceOk, adviceReason),
    gate('envelope_fits', budgetOk, budgetReason)
  ];
  record('preview.target_checked', 'bound');
  record('preview.advice_checked', adviceReason);
  record('preview.envelope_checked', budgetReason);

  const provenance = {
    fixture,
    fixtureSeed: FIXTURE_SEED,
    fixtureTable: FIXTURE_TABLE,
    target: TARGET_NAME,
    endpointKind: ENDPOINT_KIND,
    protocolId: fixtureId('protocol', fixture),
    evaluationCohortId: fixtureId('cohort', fixture),
    route: 'fixture',
    envelopeIdentity: fixtureId('envelope', fixture),
    adviceResponseId: fixtureId('advice', fixture),
    baselineScorePpm: BASELINE_SCORE_PPM,
    candidateScorePpm: null,
    archive: []
  };

  if (!adviceOk || !budgetOk) {
    record('preview.rejected', `${adviceReason}/${budgetReason}`);
    return {
      fixture,
      status: STATUS_VALIDATION_REJECTED,
      envelopeLabel: label,
      adviceReason,
      budgetFits: budgetOk,
      budgetReason,
      settlement: 'not_attempted',
      gates: [...gates, gate('archive_settled', false, 'rejected before any runner activity')],
      provenance,
      events
    };
  }
  record('preview.validated', label);
  if (fixture === 'corrupt-receipt') {
    // The fixture receipt is rejected (stale_receipt); the baseline archive
    // entry survives, exactly like the harness corrupt-receipt shape, but no
    // controller runs here — this is the fixture table's fixed outcome.
    record('preview.settled', 'stale_receipt');
    record('preview.failed', 'stale_receipt');
    return {
      fixture,
      status: STATUS_FAILED,
      envelopeLabel: label,
      adviceReason,
      budgetFits: budgetOk,
      budgetReason,
      settlement: 'stale_receipt',
      gates: [...gates, gate('archive_settled', false, 'fixture receipt rejected: stale_receipt')],
      provenance: {
        ...provenance,
        archive: [archiveEntry(
          fixtureId('execution', 'baseline'), fixtureId('candidate', 'baseline'),
          BASELINE_SCORE_PPM, fixtureId('receipt', 'baseline'), true)]
      },
      events
    };
  }
  record('preview.settled', 'success');
  record('preview.completed', 'archive=2');
  return {
    fixture,
    status: STATUS_COMPLETED,
    envelopeLabel: label,
    adviceReason,
    budgetFits: budgetOk,
    budgetReason,
    settlement: 'success',
    gates: [...gates, gate('archive_settled', true, '2 archive entries, 1 candidate')],
    provenance: {
      ...provenance,
      candidateScorePpm: CANDIDATE_SCORE_PPM,
      archive: [
        archiveEntry(
          fixtureId('execution', 'baseline'), fixtureId('candidate', 'baseline'),
          BASELINE_SCORE_PPM, fixtureId('receipt', 'baseline'), true),
        archiveEntry(
          fixtureId('execution', 'candidate'), fixtureId('candidate', 'candidate'),
          CANDIDATE_SCORE_PPM, fixtureId('receipt', 'candidate'), false)
      ]
    },
    events
  };
}

// Redaction before every write. Scope matches the harness label advisory:
// bearer tokens and e-mail addresses are scrubbed (nested structures are
// walked); counts and fixture vocabulary pass through untouched. This is not
// a general PII scrubber — labels must still be treated as display text.
const BEARER_PATTERN = /bearer\s+[A-Za-z0-9\-._~+/=]+/gi;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function redactText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(BEARER_PATTERN, '[redacted]').replace(EMAIL_PATTERN, '[redacted]');
}

export function checkCreateBody(raw) {
  // Returns {body} or a refusal. Only the documented keys are read; override
  // keys fail before unknown keys so a smuggled controller/budget/binding key
  // is never misreported as a typo.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return previewRefused('DGM_BAD_BODY', 'body must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_BODY_KEYS.has(key)) {
      return previewRefused('DGM_OVERRIDE', `browser input must not set ${JSON.stringify(key)}`);
    }
    if (!ALLOWED_BODY_KEYS.includes(key)) {
      return previewRefused('DGM_BAD_BODY', `unexpected browser key ${JSON.stringify(key)}`);
    }
  }
  const fixture = raw.fixture;
  if (!FIXTURES.includes(fixture)) {
    return previewRefused('DGM_BAD_FIXTURE', `fixture must be one of ${FIXTURES.join(', ')}`);
  }
  const held = raw.held === undefined ? false : raw.held;
  if (typeof held !== 'boolean') {
    return previewRefused('DGM_BAD_BODY', 'held must be a boolean');
  }
  const label = raw.label === undefined ? '' : raw.label;
  if (typeof label !== 'string' || label.length > MAX_LABEL_LEN) {
    return previewRefused('DGM_BAD_BODY', `label must be a string of at most ${MAX_LABEL_LEN} chars`);
  }
  const target = raw.target === undefined ? null : raw.target;
  if (target !== null && (typeof target !== 'string' || target === '')) {
    return previewRefused('DGM_BAD_BODY', 'target must be a nonempty name');
  }
  if (target !== null && target !== TARGET_NAME) {
    return previewRefused('DGM_UNKNOWN_TARGET',
      `unknown DGM target ${JSON.stringify(target)}; known targets: ${TARGET_NAME}`);
  }
  return { body: { fixture, held, label: redactText(label), target: target || TARGET_NAME } };
}

// ---- fixture telemetry rows + summaries (pure; operate on stored rows) ----

export function fixtureTelemetryRows(status) {
  // Rows emitted at creation. Terminal runs also emit their outcome row;
  // paused (held) runs emit it when they leave `paused`.
  const rows = [
    { event: 'telemetry.latency', body: { env: 'fixture', phase: 'total', latency_ms: 12 } },
    { event: 'telemetry.resources', body: { env: 'fixture', tokens: 8, calls: 2, wall_ms: 12, attempts: 0 } },
    {
      event: 'telemetry.tokens',
      body: { env: 'fixture', source: 'estimate', prompt_tokens_est: 40, completion_tokens_est: 10 }
    }
  ];
  const outcome = TERMINAL_OUTCOME[status];
  if (outcome !== undefined) {
    rows.push({ event: 'telemetry.outcome', body: { env: 'fixture', outcome, attempt_count: 1 } });
  }
  return rows;
}

export function transitionOutcomeRow(status) {
  // Outcome row appended when a held run leaves `paused` via resume/cancel.
  // Returns null for non-terminal targets (re-hold keeps its outcome row).
  const outcome = TERMINAL_OUTCOME[status];
  if (outcome === undefined || status === STATUS_PAUSED) return null;
  return { event: 'telemetry.outcome', body: { env: 'fixture', outcome, attempt_count: 1 } };
}

function nearestRank(sorted, quantile) {
  if (!sorted.length) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[rank];
}

export function latencySummary(samples) {
  // Empty input yields nulls (never 0): absence of evidence is not speed.
  const finite = samples.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!finite.length) return { count: 0, p50_ms: null, p95_ms: null, status: 'unknown' };
  const sorted = [...finite].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50_ms: nearestRank(sorted, 0.5),
    p95_ms: nearestRank(sorted, 0.95),
    status: 'ok'
  };
}

export function outcomeCounts(outcomes) {
  const counts = {};
  for (const outcome of outcomes) {
    if (typeof outcome !== 'string' || outcome === '') continue;
    counts[outcome] = (counts[outcome] || 0) + 1;
  }
  return counts;
}

export function tokensSummary(rows) {
  // Estimate and authoritative rows never mix: estimate-only fixtures report
  // the estimate block; no rows report nulls, never zeros.
  const estimates = rows.filter((b) => b && b.source === 'estimate');
  if (!estimates.length) {
    return {
      source: 'estimate', prompt_tokens_est: null, completion_tokens_est: null, status: 'unknown'
    };
  }
  const sum = (key) => estimates.reduce((t, b) => t + (Number.isSafeInteger(b[key]) ? b[key] : 0), 0);
  return {
    source: 'estimate',
    prompt_tokens_est: sum('prompt_tokens_est'),
    completion_tokens_est: sum('completion_tokens_est'),
    status: 'ok'
  };
}

export function parseEventBody(bodyJson) {
  try {
    const body = JSON.parse(bodyJson);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

export function buildTelemetryView(runId, rawRows, candidateScorePpm) {
  // Live view derived from stored events (never a stored snapshot, so it
  // cannot go stale). Malformed rows are skipped and counted — one corrupt
  // row degrades the view instead of failing the run read.
  const latencies = [];
  const outcomes = [];
  const tokenRows = [];
  let unparsed = 0;
  for (const row of rawRows || []) {
    const body = parseEventBody(row && row.body_json);
    if (!body) {
      unparsed += 1;
      continue;
    }
    if (row.event === 'telemetry.latency' && typeof body.latency_ms === 'number') {
      latencies.push(body.latency_ms);
    } else if (row.event === 'telemetry.outcome' && typeof body.outcome === 'string') {
      outcomes.push(body.outcome);
    } else if (row.event === 'telemetry.tokens') {
      tokenRows.push(body);
    }
  }
  const hasOutcome = outcomes.length > 0;
  // A run without its terminal outcome row reads `stale` (held runs emit
  // theirs when they leave `paused`); corrupt rows degrade instead.
  const readStatus = unparsed > 0 ? 'degraded' : (hasOutcome ? 'ok' : 'stale');
  return {
    env: 'fixture',
    baselineScorePpm: BASELINE_SCORE_PPM,
    candidateScorePpm: candidateScorePpm === undefined ? null : candidateScorePpm,
    readStatus,
    freshnessNote: readStatus === 'ok' ? 'fresh' : readStatus,
    missing: [],
    stale: hasOutcome ? [] : [runId],
    unparsedRows: unparsed,
    outcomeCounts: outcomeCounts(outcomes),
    latencySummary: latencySummary(latencies),
    tokensSummary: tokensSummary(tokenRows)
  };
}

// Browser entry for the visible experiment.
//
// Everything runs in this tab: fixtures are imported, evaluated and rendered
// locally. There is no network call after the page loads, no storage write, and
// no code path that applies, promotes, merges or executes anything.

import { buildRequest, validateInput } from './adapter.mjs';
import { evaluate, replay } from './evaluate.mjs';
import { requestRollback, select, verifySelection } from './selection.mjs';
import { runMeasurement } from './measure.mjs';
import { WORK_ITEMS } from '../fixtures/work-items.mjs';
import { MODULE_ID, MODULE_VERSION, OPT_IN_FLAG } from './contract.mjs';
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
} from './view.mjs';

const state = {
  enabled: false,
  busy: false,
  report: null,
  evidence: [],
  selection: null
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
};

const byId = (id) => document.getElementById(id);

function setStatus(message, tone) {
  const node = byId('run-status');
  node.textContent = message;
  if (tone) node.dataset.tone = tone;
  else delete node.dataset.tone;
}

function setBusy(busy) {
  state.busy = busy;
  for (const id of ['run-sweep', 'run-replay', 'run-tamper', 'run-select']) {
    const button = byId(id);
    if (button) button.disabled = busy || !state.enabled;
  }
}

function requireEnabled() {
  if (!state.enabled) {
    setStatus('The experiment is disabled. Enable it before running anything.', 'warn');
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ gate */

function applyGate(enabled, { viaUrl = false } = {}) {
  state.enabled = enabled;
  const panel = document.querySelector('.panel--gate');
  panel.dataset.enabled = String(enabled);
  const toggle = byId('gate-toggle');
  toggle.textContent = enabled ? 'Disable experiment' : 'Enable experiment';
  toggle.setAttribute('aria-pressed', String(enabled));
  const stateChip = byId('gate-state');
  stateChip.textContent = enabled ? 'enabled' : 'disabled';
  stateChip.dataset.state = enabled ? 'on' : 'off';

  const message = byId('gate-message');
  if (enabled) {
    message.textContent = `${OPT_IN_FLAG} is on for this tab${viaUrl ? ' (via the experiment=on link)' : ''}. Fixtures are in memory; nothing is applied.`;
    message.dataset.tone = 'ok';
  } else {
    message.textContent = 'The experiment is off. No fixture was read and no verdict exists yet.';
    delete message.dataset.tone;
  }

  byId('run-panel').hidden = !enabled;
  if (!enabled) {
    byId('results').hidden = true;
    state.report = null;
    state.evidence = [];
    state.selection = null;
    setStatus('Ready. No verdict has been produced in this tab yet.');
  }
  setBusy(false);
}

/* -------------------------------------------------------------- overview */

function renderMetrics(report) {
  const body = byId('metrics-body');
  body.replaceChildren();
  for (const row of metricRows(report)) {
    const tr = el('tr');
    const label = el('th', null);
    label.scope = 'row';
    label.append(document.createTextNode(row.label));
    const hint = el('span', 'metric-hint', row.hint);
    label.append(hint);

    const baseline = el('td', 'num', row.baseline);
    const gate = el('td', 'num', row.gate);
    tr.append(label, baseline, gate);
    body.append(tr);
  }

  byId('metrics-note').textContent =
    `${report.fixtures} authored work items, ${report.artifacts} artifacts, `
    + `${report.rows[0]?.gate_policy?.subject_predicates ?? 8} acceptance predicates per artifact. `
    + `Both policies saw identical inputs; the ${BASELINE_LABEL.toLowerCase()} column is `
    + `${BASELINE_CAVEAT}.`;

  const gate = report.metrics['dgm-gate'];
  const facts = byId('metric-facts');
  facts.replaceChildren();
  const fact = (value, label) => {
    const li = el('li');
    li.append(el('strong', null, value), document.createTextNode(label));
    return li;
  };
  facts.append(
    fact(`${gate.labelled_defects_detected}/${gate.labelled_defects_detected + gate.labelled_defects_missed}`, 'labelled defects caught'),
    fact(`${gate.exact_label_matches}/${gate.defective_artifacts}`, 'defective artifacts with exactly the labelled failures'),
    fact(`${gate.clean_without_failures}/${gate.clean_artifacts}`, 'clean artifacts left untouched'),
    fact(report.determinism.all_replays_identical ? 'identical' : 'diverged', ` digests across ${report.repeats_per_request} replays`),
    fact(report.latency.p50_ms === null || report.latency.samples === 0 ? 'not measured' : `${report.latency.p50_ms.toFixed(2)} ms`, ' observed p50, excluded from the digest')
  );

  byId('report-digest').textContent = report.report_sha256;
}

function verdictFor(fixtureId, subject) {
  return state.evidence.find((entry) => entry.fixture_id === fixtureId && entry.subject === subject) || null;
}

function renderFixtures(report) {
  const host = byId('fixtures');
  host.replaceChildren();
  const titles = new Map(WORK_ITEMS.map((item) => [item.id, item.issue.title]));

  for (const fixture of fixtureRows(report)) {
    const details = el('details', 'fixture');
    const summary = el('summary', 'fixture__head');

    const heading = el('div');
    heading.append(
      el('span', 'fixture__id', fixture.id),
      el('h3', 'fixture__title', titles.get(fixture.id) || fixture.id)
    );

    const chips = el('div', 'chips');
    const labelled = fixture.baseline?.labelled_defects || [];
    chips.append(el('span', `chip ${labelled.length ? 'chip--warn' : 'chip--ok'}`, labelled.length ? `labelled: ${labelled.join(', ')}` : 'clean control'));

    const baselineGate = fixture.baseline?.gate_policy;
    const candidateGate = fixture.candidate?.gate_policy;
    if (baselineGate) {
      chips.append(el('span', `chip chip--${statusTone(baselineGate.status)}`, `baseline ${statusLabel(baselineGate.status).toLowerCase()}`));
    }
    if (candidateGate) {
      chips.append(el('span', `chip chip--${statusTone(candidateGate.status)}`, `candidate ${statusLabel(candidateGate.status).toLowerCase()}`));
    }

    summary.append(heading, chips, el('span', 'fixture__toggle', 'details'));

    const pair = el('div', 'pair');
    for (const subject of ['baseline', 'candidate']) {
      const row = fixture[subject];
      if (!row || !row.gate_policy) {
        pair.append(el('p', 'empty', `${subject}: no verdict (${row ? row.unavailable : 'missing'})`));
        continue;
      }
      const tone = statusTone(row.gate_policy.status);
      const item = el('div', 'pair__item');
      item.dataset.tone = tone;
      item.append(
        el('p', 'pair__label', subject),
        el('p', 'pair__value', `${statusLabel(row.gate_policy.status)} · ${row.gate_policy.subject_ppm === null ? 'n/a' : formatPpm(row.gate_policy.subject_ppm)} checks`),
        el('p', 'pair__meta', row.gate_policy.repair_items.length
          ? `repair brief: ${row.gate_policy.repair_items.join(', ')}`
          : 'no repair items'),
        el('p', 'pair__meta', `parse-only policy: ${statusLabel(row.parse_policy.status).toLowerCase()} (${row.parse_policy.admitted_defect ? 'would admit a labelled defect' : 'no labelled defect admitted'})`)
      );
      const inspect = el('button', 'fixture__toggle', 'Inspect verdict');
      inspect.type = 'button';
      inspect.addEventListener('click', (event) => {
        event.preventDefault();
        showDetail(fixture.id, subject);
      });
      item.append(inspect);
      pair.append(item);
    }

    details.append(summary, pair);
    host.append(details);
  }
}

/* ---------------------------------------------------------------- detail */

function listOf(items, { passKey = 'passed', detailKey = 'detail' } = {}) {
  const list = el('ul', 'list');
  for (const item of items) {
    const li = el('li');
    const mark = el('span', `mark ${item[passKey] ? 'mark--pass' : 'mark--fail'}`, item[passKey] ? 'pass' : 'fail');
    const body = el('div');
    const label = item.name || item.id || '';
    const strong = el('strong', null, label);
    body.append(strong);
    const detail = item[detailKey] || item.statement || '';
    if (detail) body.append(el('small', null, detail));
    li.append(mark, body);
    list.append(li);
  }
  return list;
}

function showDetail(fixtureId, subject) {
  const entry = verdictFor(fixtureId, subject);
  const panel = byId('detail-panel');
  const host = byId('detail-body');
  host.replaceChildren();

  if (!entry) {
    host.append(el('p', 'empty', 'No verdict is held for this artifact. Run the sweep first.'));
    panel.hidden = false;
    return;
  }

  const verdict = entry.verdict;
  const summary = verdictSummary(verdict);
  byId('detail-title').textContent = `Verdict · ${fixtureId} · ${subject}`;

  const lead = el('p', 'panel__note');
  lead.textContent = `${summary.label} — ${summary.detail}`;
  host.append(lead);

  const grid = el('div', 'detail-grid');

  const gatesBlock = el('div', 'detail-block');
  gatesBlock.append(el('h3', null, 'Gates'), listOf(gateRows(verdict)));

  const checksBlock = el('div', 'detail-block');
  checksBlock.append(el('h3', null, `Acceptance checks · ${subject}`), listOf(checkRows(verdict, 'subject')));

  const referenceBlock = el('div', 'detail-block');
  referenceBlock.append(el('h3', null, `Reference · ${verdict.subject === 'baseline' ? 'candidate' : 'baseline'}`), listOf(checkRows(verdict, 'reference')));

  grid.append(gatesBlock, checksBlock, referenceBlock);

  const digests = el('div', 'digests');
  const row = (label, value) => {
    const line = el('div');
    line.append(el('span', null, label), el('code', null, value || '—'));
    return line;
  };
  digests.append(
    row('verdict', summary.verdictDigest),
    row('request', summary.requestDigest),
    row('receipt', summary.receiptDigest),
    row('authority / applied', `${summary.authority} / ${String(summary.applied)}`)
  );

  const note = el('p', 'detail-note');
  note.textContent = verdict.repair_brief.length
    ? `Repair brief: ${verdict.repair_brief.map((item) => item.id).join(', ')}. The upstream executor would have to fix these; this adapter does not.`
    : 'No repair items. A pass here is a predicate result on an authored fixture, not a quality measurement.';

  host.append(grid, digests, note);
  panel.hidden = false;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ------------------------------------------------------------- selection */

async function renderSelection(selection) {
  const host = byId('selection-body');
  host.replaceChildren();
  const view = selectionSummary(selection);

  if (view.empty) {
    host.append(el('p', 'empty', view.note));
    return;
  }

  const check = await verifySelection(selection);
  const grid = el('div', 'selection__grid');

  const selectedCard = el('div', 'selection__card');
  selectedCard.append(el('h3', null, 'Selected'));
  if (view.selected) {
    selectedCard.append(
      el('p', 'selection__value', view.selected.fixture_id),
      el('p', 'selection__meta', `${view.selected.subject} artifact · ${formatPpm(view.selected.subject_ppm)} checks passed`),
      el('p', 'selection__meta', `subject ${shortDigest(view.selected.subject_sha256, 16)}`)
    );
  } else {
    selectedCard.append(el('p', 'selection__value', 'none'), el('p', 'selection__meta', 'no candidate passed every gate'));
  }

  const boundCard = el('div', 'selection__card');
  boundCard.append(
    el('h3', null, 'Bound'),
    el('p', 'selection__value', `${view.considered} considered`),
    el('p', 'selection__meta', `${view.rejected} rejected or unavailable`),
    el('p', 'selection__meta', `applied: ${String(view.applied)} · verified: ${check.ok ? 'yes' : `no (${check.reason})`}`)
  );
  if (selection.ties > 1) {
    boundCard.append(el('p', 'selection__meta', `${selection.ties} scored identically; the tie was broken by ${selection.tie_break}.`));
  }

  const rollbackCard = el('div', 'selection__card');
  rollbackCard.append(
    el('h3', null, 'Rollback'),
    el('p', 'selection__value', view.rollback.revision),
    el('p', 'selection__meta', `${view.rollback.action} · applied: ${String(view.rollback.applied)}`),
    el('p', 'selection__meta', `from ${shortDigest(view.rollback.from, 12)} to ${shortDigest(view.rollback.to, 12)}`)
  );

  const rollbackButton = el('button', 'button', 'Prepare rollback request');
  rollbackButton.type = 'button';
  rollbackButton.addEventListener('click', () => {
    const requested = requestRollback(selection, { reason: 'operator inspection in the demo' });
    const line = el('p', 'selection__meta');
    line.textContent = requested.ok
      ? `Rollback request ${shortDigest(requested.record.selection_sha256, 12)} prepared; executed: false. A human performs any restoration.`
      : `Rollback refused: ${requested.code}`;
    rollbackCard.append(line);
    rollbackButton.disabled = true;
  });
  rollbackCard.append(rollbackButton);

  grid.append(selectedCard, boundCard, rollbackCard);

  const note = el('p', 'selection__note', `${view.note} Selection ${shortDigest(view.selectionId, 16)} · digest ${shortDigest(view.digest, 16)}.`);
  host.append(grid, note);
}

/* --------------------------------------------------------------- actions */

async function runSweep() {
  if (!requireEnabled() || state.busy) return;
  setBusy(true);
  setStatus('Running the fixture sweep in this tab…');

  try {
    const report = await runMeasurement({
      now: () => performance.now(),
      replays: 2,
      keepVerdicts: true
    });
    state.report = report;
    state.evidence = report.evidence;
    state.selection = null;

    byId('results').hidden = false;
    renderMetrics(report);
    renderFixtures(report);
    byId('detail-panel').hidden = true;
    await renderSelection(null);
    setStatus(`Sweep complete: ${report.artifacts} verdicts, ${report.determinism.distinct_digests} distinct digests, nothing applied.`, 'ok');
  } catch (error) {
    setStatus(`Sweep failed: ${error && error.message ? error.message : 'unknown error'}`, 'warn');
  } finally {
    setBusy(false);
  }
}

async function runReplayCheck() {
  if (!requireEnabled() || state.busy) return;
  const entry = state.evidence[0];
  if (!entry) {
    setStatus('Run the sweep first; there is nothing to replay.', 'warn');
    return;
  }
  setBusy(true);
  try {
    const item = WORK_ITEMS.find((candidate) => candidate.id === entry.fixture_id);
    const result = await replay(item, entry.request, 3);
    const stable = result.identical;
    setStatus(
      stable
        ? `Replay ${result.runs}× on ${entry.fixture_id}/${entry.subject}: identical verdict digest ${shortDigest(result.digests[0], 16)}.`
        : `Replay diverged: ${result.digests.map((digest) => shortDigest(digest, 8)).join(' ≠ ')}`,
      stable ? 'ok' : 'warn'
    );
  } finally {
    setBusy(false);
  }
}

async function runTamperCheck() {
  if (!requireEnabled() || state.busy) return;
  const item = WORK_ITEMS[0];
  setBusy(true);
  try {
    const built = await buildRequest(item, { tamper: 'candidate' });
    if (!built.ok) {
      setStatus(`Tamper probe could not build a request: ${built.code}`, 'warn');
      return;
    }
    const verdict = await evaluate(item, built.request);
    if (verdict.ok === false) {
      setStatus(`Tamper probe was refused outright: ${verdict.code}.`, 'warn');
      return;
    }
    const honest = verdict.code === 'DGM_IDENTITY_MISMATCH' && verdict.status === 'unavailable';
    setStatus(
      honest
        ? `Post-seal mutation refused: ${verdict.code}. The sealed request binds a candidate digest the fixture no longer matches, so no score was produced.`
        : `Tamper probe did not refuse as expected (status ${verdict.status} / ${verdict.code}). Treat this as a failure.`,
      honest ? 'ok' : 'warn'
    );
  } finally {
    setBusy(false);
  }
}

async function runSelection() {
  if (!requireEnabled() || state.busy) return;
  if (!state.evidence.length) {
    setStatus('Run the sweep first; selection needs verdicts.', 'warn');
    return;
  }
  setBusy(true);
  try {
    const verdicts = state.evidence
      .filter((entry) => entry.subject === 'candidate')
      .map((entry) => entry.verdict);
    // Selection re-derives every verdict from its fixture; without the
    // fixtures it refuses rather than trusting a record's own seal.
    const result = await select(verdicts, {
      fixtures: WORK_ITEMS,
      baselineRevision: 'rev-2026-11-02-a'
    });
    if (!result.ok) {
      setStatus(`Selection refused: ${result.code} — ${result.detail}`, 'warn');
      return;
    }
    state.selection = result.selection;
    await renderSelection(result.selection);
    setStatus(
      `Selected ${result.selection.selected ? result.selection.selected.fixture_id : 'nothing'}. applied: false. A rollback plan is attached and unexecuted.`,
      'ok'
    );
    byId('selection-body').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ boot */

function boot() {
  byId('meta-module').textContent = MODULE_ID;
  byId('meta-version').textContent = MODULE_VERSION;
  byId('footer-version').textContent = `v${MODULE_VERSION}`;

  byId('gate-toggle').addEventListener('click', () => applyGate(!state.enabled));
  byId('run-sweep').addEventListener('click', runSweep);
  byId('run-replay').addEventListener('click', runReplayCheck);
  byId('run-tamper').addEventListener('click', runTamperCheck);
  byId('run-select').addEventListener('click', runSelection);
  byId('detail-close').addEventListener('click', () => {
    byId('detail-panel').hidden = true;
  });

  const params = new URLSearchParams(window.location.search);
  applyGate(params.get('experiment') === 'on', { viaUrl: true });

  // Reject any attempt to smuggle override keys through the page's own input
  // surface. The demo has no free-text input, so this is a guard, not a feature.
  const probe = validateInput({});
  if (!probe.ok) {
    setStatus(`Input guard rejected an empty probe: ${probe.code}`, 'warn');
  }
}

boot();

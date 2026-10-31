/* Built with Meta Muse. */
// Admin scaffold shell: same-origin reads only. The shell renders whatever
// availability state the server reports and invents no data — an unknown or
// missing field is shown as unknown, never as zero or healthy.
'use strict';

async function loadStatus() {
  const grant = document.getElementById('grant');
  try {
    const res = await fetch('/api/admin/v1/status', { credentials: 'same-origin' });
    const body = await res.json().catch(() => null);
    if (res.ok && body && body.grant) {
      grant.textContent = 'Authorized as ' + body.grant.role + ' (scope ' + body.grant.scope + '). '
        + 'Elevation: ' + (body.elevation || 'unknown') + '. Mutations: ' + (body.mutations || 'unknown') + '.';
    } else if (body && body.code) {
      grant.textContent = 'Not authorized (' + body.code + '). Sign in with an administration grant.';
    } else {
      grant.textContent = 'Authorization unknown (HTTP ' + res.status + ').';
    }
  } catch {
    grant.textContent = 'Authorization unknown (request failed).';
  }
}

async function loadSection(section, endpoint) {
  const state = section.querySelector('.state');
  state.textContent = 'Loading…';
  try {
    const res = await fetch(endpoint, { credentials: 'same-origin' });
    const body = await res.json().catch(() => null);
    if (res.ok && body) {
      const parts = ['state: ' + (body.state === null || body.state === undefined ? 'unknown' : body.state)];
      if (body.reason_code) parts.push('reason: ' + body.reason_code);
      if (body.metric) parts.push('metric: ' + body.metric);
      if (Array.isArray(body.items)) parts.push('items: ' + body.items.length + ' (total ' + (body.total === null ? 'unknown' : body.total) + ')');
      state.textContent = parts.join(', ') + '.';
    } else if (body && body.code) {
      state.textContent = 'Unavailable: ' + body.code + ' (HTTP ' + res.status + ').';
    } else {
      state.textContent = 'Unavailable: HTTP ' + res.status + '.';
    }
  } catch {
    state.textContent = 'Unavailable: request failed.';
  }
}

document.querySelectorAll('button[data-endpoint]').forEach((button) => {
  button.addEventListener('click', () => {
    const section = button.closest('section');
    if (section) loadSection(section, button.getAttribute('data-endpoint'));
  });
});

loadStatus();

// ---- DGM fixture preview (flag-gated; the server authorizes every call) ----

const dgmEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dgmUnknown = (v) => (v === null || v === undefined ? 'unknown' : String(v));

let dgmCurrentRun = null;

async function dgmFetch(path, opts) {
  const init = { credentials: 'same-origin', ...(opts || {}) };
  if (init.method && init.method !== 'GET') {
    init.headers = { 'X-Aipster-CSRF': '1', ...((init.body ? { 'Content-Type': 'application/json' } : {})), ...(init.headers || {}) };
  }
  const res = await fetch(path, init);
  const body = await res.json().catch(() => null);
  return { res, body };
}

function dgmFailure(body, status) {
  if (body && body.code) return body.code + ' (HTTP ' + status + ')';
  return 'HTTP ' + status;
}

async function loadDgmRuns() {
  const box = document.getElementById('dgm-runs');
  box.textContent = 'Loading…';
  try {
    const { res, body } = await dgmFetch('/api/admin/v1/dgm/preview/runs');
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!res.ok || !body || !Array.isArray(body.items)) {
      box.textContent = 'Unavailable: ' + dgmFailure(body, res.status) + '.';
      return;
    }
    if (!body.items.length) {
      box.textContent = 'No preview runs yet (empty).';
      return;
    }
    const list = document.createElement('ul');
    for (const run of body.items) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.setAttribute('href', '#dgm-run-' + run.runId);
      link.textContent = run.runId + ' — ' + run.fixture + ' — ' + run.status + ' / ' + run.envelopeLabel;
      link.addEventListener('click', (event) => {
        if (event && event.preventDefault) event.preventDefault();
        return loadDgmRun(run.runId);
      });
      item.appendChild(link);
      list.appendChild(item);
    }
    box.appendChild(list);
  } catch {
    box.textContent = 'Unavailable: request failed.';
  }
}

async function createDgmRun() {
  const state = document.getElementById('dgm-create-state');
  state.textContent = 'Creating…';
  const fixture = document.getElementById('dgm-fixture').value;
  const held = !!document.getElementById('dgm-held').checked;
  const label = document.getElementById('dgm-label').value || '';
  try {
    const { res, body } = await dgmFetch('/api/admin/v1/dgm/preview/runs', {
      method: 'POST', body: JSON.stringify(label ? { fixture, held, label } : { fixture, held })
    });
    if (res.ok && body) {
      state.textContent = 'Created ' + body.runId + ' (' + body.status + ' / ' + body.envelopeLabel + ').';
      loadDgmRuns();
      loadDgmRun(body.runId);
    } else {
      state.textContent = 'Refused: ' + dgmFailure(body, res.status) + '.';
    }
  } catch {
    state.textContent = 'Refused: request failed.';
  }
}

function dgmDetailHtml(run) {
  const row = (label, value) => '<tr><th>' + dgmEsc(label) + '</th><td>' + value + '</td></tr>';
  const gates = (Array.isArray(run.gates) ? run.gates : []).map((g) =>
    '<tr><td>' + dgmEsc(g.name) + '</td><td>' + (g.passed ? 'pass' : 'fail') +
    '</td><td>' + dgmEsc(g.evidence) + '</td></tr>').join('');
  const events = (Array.isArray(run.events) ? run.events : []).map((e) =>
    '<tr><td>' + dgmEsc(e.sequence) + '</td><td>' + dgmEsc(e.event) +
    '</td><td>' + dgmEsc(e.detail) + '</td></tr>').join('');
  const telem = run.telemetry || {};
  const latency = telem.latencySummary || {};
  const tokens = telem.tokensSummary || {};
  const prov = run.provenance || {};
  const archive = (Array.isArray(prov.archive) ? prov.archive : []).map((a) =>
    '<tr><td>' + dgmEsc(a.scorePpm) + '</td><td>' + (a.baseline ? 'baseline' : 'candidate (fixture)') + '</td></tr>').join('');
  return '<span id="dgm-run-' + dgmEsc(run.runId) + '"></span>'
    + '<table>' + row('run', dgmEsc(run.runId)) + row('fixture', dgmEsc(run.fixture) + ' (fixture)')
    + row('evaluation', dgmEsc(run.evaluation)) + row('status', dgmEsc(run.status))
    + row('envelope', dgmEsc(run.envelopeLabel)) + row('label', dgmEsc(run.label || ''))
    + row('advice reason', dgmEsc(run.adviceReason)) + row('settlement', dgmEsc(run.settlement)) + '</table>'
    + '<h3>Readiness gates</h3><table><tr><th>gate</th><th>verdict</th><th>evidence</th></tr>' + gates + '</table>'
    + '<h3>Archived candidates (fixture)</h3><table><tr><th>score ppm</th><th>kind</th></tr>'
    + (archive || '<tr><td colspan="2">no archived entries (run never settled)</td></tr>') + '</table>'
    + '<h3>Budget/event trace</h3><table><tr><th>#</th><th>event</th><th>detail</th></tr>' + events + '</table>'
    + '<h3>Telemetry (fixture rows, real persistence)</h3><table>'
    + row('read status', dgmEsc(telem.readStatus) + ' (' + dgmEsc(telem.freshnessNote) + ')')
    + row('outcome counts', dgmEsc(JSON.stringify(telem.outcomeCounts || {})))
    + row('latency', dgmEsc('count=' + dgmUnknown(latency.count)
      + ' p50=' + dgmUnknown(latency.p50_ms) + ' p95=' + dgmUnknown(latency.p95_ms)))
    + row('tokens (estimate)', dgmEsc('prompt=' + dgmUnknown(tokens.prompt_tokens_est)
      + ' completion=' + dgmUnknown(tokens.completion_tokens_est)))
    + '</table>';
}

function dgmControlState(status) {
  document.getElementById('dgm-pause').disabled = status !== 'completed-preview';
  document.getElementById('dgm-resume').disabled = status !== 'paused';
  document.getElementById('dgm-cancel').disabled = status !== 'paused';
}

async function loadDgmRun(runId) {
  const state = document.getElementById('dgm-run-state');
  const detail = document.getElementById('dgm-run-detail');
  state.textContent = 'Loading…';
  detail.innerHTML = '';
  dgmCurrentRun = null;
  dgmControlState(null);
  try {
    const { res, body } = await dgmFetch('/api/admin/v1/dgm/preview/runs/' + encodeURIComponent(runId));
    if (res.ok && body) {
      dgmCurrentRun = body.runId;
      state.textContent = body.runId + ' — ' + body.status + ' / ' + body.envelopeLabel + '.';
      detail.innerHTML = dgmDetailHtml(body);
      dgmControlState(body.status);
    } else {
      state.textContent = 'Unavailable: ' + dgmFailure(body, res.status) + '.';
    }
  } catch {
    state.textContent = 'Unavailable: request failed.';
  }
}

async function dgmControl(action) {
  if (!dgmCurrentRun) return;
  const state = document.getElementById('dgm-run-state');
  state.textContent = 'Loading…';
  try {
    const { res, body } = await dgmFetch(
      '/api/admin/v1/dgm/preview/runs/' + encodeURIComponent(dgmCurrentRun) + '/' + action, { method: 'POST' });
    if (res.ok && body) {
      loadDgmRuns();
      loadDgmRun(body.runId);
    } else {
      state.textContent = 'Refused: ' + dgmFailure(body, res.status) + '.';
    }
  } catch {
    state.textContent = 'Refused: request failed.';
  }
}

document.getElementById('dgm-runs-load').addEventListener('click', loadDgmRuns);
document.getElementById('dgm-create').addEventListener('click', createDgmRun);
document.getElementById('dgm-pause').addEventListener('click', () => dgmControl('pause'));
document.getElementById('dgm-resume').addEventListener('click', () => dgmControl('resume'));
document.getElementById('dgm-cancel').addEventListener('click', () => dgmControl('cancel'));

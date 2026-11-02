/* Built with Meta Muse. */
// Admin scaffold shell: same-origin reads only. The shell renders whatever
// availability state the server reports and invents no data — an unknown or
// missing field is shown as unknown, never as zero or healthy.
'use strict';

function paintAuthButtons(authorized) {
  const signin = document.getElementById('signin-github');
  const signout = document.getElementById('signout');
  if (!signin || !signout) return;
  signin.hidden = !!authorized;
  signout.hidden = !authorized;
}

async function loadStatus() {
  const grant = document.getElementById('grant');
  try {
    const res = await fetch('/api/admin/v1/status', { credentials: 'same-origin' });
    const body = await res.json().catch(() => null);
    if (res.ok && body && body.grant) {
      grant.textContent = 'Authorized as ' + body.grant.role + ' (scope ' + body.grant.scope + '). '
        + 'Elevation: ' + (body.elevation || 'unknown') + '. Mutations: ' + (body.mutations || 'unknown') + '.';
      paintAuthButtons(true);
    } else if (body && body.code) {
      grant.textContent = 'Not authorized (' + body.code + '). Sign in with an administration grant.';
      paintAuthButtons(false);
    } else {
      grant.textContent = 'Authorization unknown (HTTP ' + res.status + ').';
      paintAuthButtons(false);
    }
  } catch {
    grant.textContent = 'Authorization unknown (request failed).';
    paintAuthButtons(false);
  }
}

async function signInWithGitHub() {
  const grant = document.getElementById('grant');
  try {
    // Same GitHub OAuth entry as the user panel: the server still decides
    // every admin route via its own admin_grants check. OAuth alone grants
    // no administration privilege.
    const origin = (typeof location !== 'undefined' && location.origin) ? location.origin : '';
    const res = await fetch('/api/auth/sign-in/social', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'github', callbackURL: origin + '/admin/', errorCallbackURL: origin + '/admin/' }),
    });
    const body = await res.json().catch(() => null);
    const url = body && (body.url || body.redirect);
    if (!res.ok || !url) throw new Error('Sign-in did not return a redirect.');
    if (typeof location !== 'undefined') location.assign(url);
  } catch {
    grant.textContent = 'Sign-in failed (request failed).';
  }
}

async function signOut() {
  const grant = document.getElementById('grant');
  try {
    await fetch('/api/auth/sign-out', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
  } catch {
    grant.textContent = 'Sign-out failed (request failed).';
    return;
  }
  loadStatus();
}

// ---- Synthetic demo (fixture rows only; never touches the network) ----
//
// The demo renders hard-coded fixtures into #demo-result and performs no
// fetch: it cannot read real users, hold a grant, mint a credential, or
// bypass backend authorization. Fixture tenants are demo-only and carry no
// exercisable roles.

const DEMO_USERS = [
  { id: 'demo_user_1', name: 'Demo Operator', email: 'demo-1@example.invalid', provider: 'github', status: 'active', tenant: 'demo', admin_roles: [], keys_active: 0 },
  { id: 'demo_user_2', name: 'Demo Support', email: 'demo-2@example.invalid', provider: 'credential', status: 'suspended', tenant: 'demo', admin_roles: [], keys_active: 0 },
];

function enterDemo() {
  const box = document.getElementById('demo-result');
  const exit = document.getElementById('demo-exit');
  const rows = DEMO_USERS.map((it) =>
    '<tr><td>' + esc(it.id) + '</td><td>' + esc(it.name) + '</td><td>' + esc(it.email)
    + '</td><td>' + esc(it.provider) + '</td><td>' + esc(it.status) + '</td><td>' + esc(it.tenant)
    + '</td><td>not applicable (demo)</td><td>' + unknown(it.keys_active) + '</td></tr>').join('');
  box.innerHTML = '<p class="banner">Synthetic demo — fixture data only. No real users, no privileges, no live requests.</p>'
    + '<table><tr><th>id</th><th>name</th><th>email</th><th>provider</th><th>status</th><th>tenant</th><th>admin roles</th><th>keys</th></tr>' + rows + '</table>';
  if (exit) exit.hidden = false;
}

function exitDemo() {
  const box = document.getElementById('demo-result');
  const exit = document.getElementById('demo-exit');
  box.innerHTML = '';
  if (exit) exit.hidden = true;
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
    if (!section) return;
    if (section.id === 'overview') { loadOverview(); return; }
    if (section.id === 'resources') { loadResources(0); return; }
    if (section.id === 'audit') { loadAudit(0); return; }
    if (section.id === 'coverage') { loadCoverage(); return; }
    if (section.id === 'operations') { loadHealth(); return; }
    if (section.id === 'access') { loadUsers(0); loadSessions(0); return; }
    loadSection(section, button.getAttribute('data-endpoint'));
  });
});
document.getElementById('resources-prev').addEventListener('click', () => loadResources(Math.max(0, resourcesOffset - RESOURCES_LIMIT)));
document.getElementById('resources-next').addEventListener('click', () => loadResources(resourcesOffset + RESOURCES_LIMIT));
document.getElementById('audit-prev').addEventListener('click', () => loadAudit(Math.max(0, auditOffset - AUDIT_LIMIT)));
document.getElementById('audit-next').addEventListener('click', () => loadAudit(auditOffset + AUDIT_LIMIT));
document.getElementById('users-prev').addEventListener('click', () => loadUsers(Math.max(0, usersOffset - USERS_LIMIT)));
document.getElementById('users-next').addEventListener('click', () => loadUsers(usersOffset + USERS_LIMIT));
document.getElementById('sessions-prev').addEventListener('click', () => loadSessions(Math.max(0, sessionsOffset - SESSIONS_LIMIT)));
document.getElementById('sessions-next').addEventListener('click', () => loadSessions(sessionsOffset + SESSIONS_LIMIT));
document.getElementById('signin-github').addEventListener('click', () => signInWithGitHub());
document.getElementById('signout').addEventListener('click', () => signOut());
document.getElementById('demo-enter').addEventListener('click', () => enterDemo());
document.getElementById('demo-exit').addEventListener('click', () => exitDemo());

loadStatus();

// ---- Overview / Resources (Milestone 1: real authorized data) ----

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unknown = (v) => (v === null || v === undefined ? 'unknown' : String(v));

function requestFailure(body, status) {
  if (body && body.code) return body.code + ' (HTTP ' + status + ')';
  return 'HTTP ' + status;
}

let overviewSeq = 0;

async function loadOverview() {
  const mySeq = ++overviewSeq;
  const section = document.getElementById('overview');
  const state = section.querySelector('.state');
  const box = document.getElementById('overview-result');
  state.textContent = 'Loading…';
  box.textContent = '';
  try {
    const res = await fetch('/api/admin/v1/overview', { credentials: 'same-origin' });
    if (mySeq !== overviewSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== overviewSeq) return;
    if (!res.ok || !body) {
      state.textContent = 'Unavailable: ' + requestFailure(body, res.status) + '.';
      return;
    }
    if (body.state !== 'available' || !body.resources) {
      state.textContent = 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').';
      return;
    }
    state.textContent = 'Loaded ' + unknown(body.observed_at) + '.';
    const r = body.resources;
    box.innerHTML = '<table>'
      + '<tr><th>resources total</th><td>' + unknown(r.total) + '</td></tr>'
      + '<tr><th>online</th><td>' + unknown(r.online) + '</td></tr>'
      + '<tr><th>stale</th><td>' + unknown(r.stale) + '</td></tr>'
      + '<tr><th>offline</th><td>' + unknown(r.offline) + '</td></tr>'
      + '<tr><th>unknown</th><td>' + unknown(r.unknown) + '</td></tr>'
      + '<tr><th>fabrics</th><td>' + esc(body.fabrics_state || 'unknown')
      + (body.fabrics_reason_code ? ' (' + esc(body.fabrics_reason_code) + ')' : '') + '</td></tr>'
      + '<tr><th>usable capacity</th><td>' + esc(body.usable_capacity_state || 'unknown') + '</td></tr>'
      + '<tr><th>coverage</th><td>' + esc(body.coverage_state || 'unknown')
      + (body.coverage_reason_code ? ' (' + esc(body.coverage_reason_code) + ')' : '') + '</td></tr>'
      + '</table>';
  } catch {
    if (mySeq !== overviewSeq) return;
    state.textContent = 'Unavailable: request failed.';
  }
}

let resourcesOffset = 0;
let resourcesSeq = 0;
const RESOURCES_LIMIT = 20;

async function loadResources(offset) {
  const section = document.getElementById('resources');
  const state = section.querySelector('.state');
  const box = document.getElementById('resources-result');
  const pages = document.getElementById('resources-pages');
  const label = document.getElementById('resources-page-label');
  const prev = document.getElementById('resources-prev');
  const next = document.getElementById('resources-next');
  const myOffset = Math.max(0, offset || 0);
  resourcesOffset = myOffset;
  const mySeq = ++resourcesSeq;
  state.textContent = 'Loading…';
  box.textContent = '';
  pages.hidden = true;
  try {
    const res = await fetch('/api/admin/v1/resources?limit=' + RESOURCES_LIMIT + '&offset=' + myOffset, { credentials: 'same-origin' });
    if (mySeq !== resourcesSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== resourcesSeq) return;
    if (!res.ok || !body) {
      state.textContent = 'Unavailable: ' + requestFailure(body, res.status) + '.';
      return;
    }
    if (body.state !== 'available' || !Array.isArray(body.items)) {
      state.textContent = 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').';
      return;
    }
    const total = Number.isSafeInteger(body.total) && body.total >= 0 ? body.total : null;
    state.textContent = 'Loaded ' + unknown(body.observed_at) + '.';
    if (!body.items.length) {
      box.textContent = total === 0 ? 'No resources registered (empty).' : 'No rows on this page.';
    } else {
      const rows = body.items.map((it) =>
        '<tr><td>' + esc(it.id) + '</td><td>' + esc(it.name) + '</td><td>' + esc(it.kind)
        + '</td><td>' + esc(it.liveness) + '</td><td>' + esc(it.lastSeenAt || 'unknown')
        + '</td><td>' + unknown(it.usable) + '</td><td>' + unknown(it.configured)
        + '</td><td>' + unknown(it.authenticated) + '</td></tr>').join('');
      box.innerHTML = '<table><tr><th>id</th><th>name</th><th>kind</th><th>liveness</th>'
        + '<th>last seen</th><th>usable</th><th>configured</th><th>authenticated</th></tr>' + rows + '</table>';
    }
    // Window bounds and Next come from offset plus limit (echoed when sane,
    // else requested): items.length shrinks when malformed rows skip, so it
    // must never size the window. The displayed count rides along separately.
    const effOffset = Number.isSafeInteger(body.offset) && body.offset >= 0 ? body.offset : myOffset;
    const effLimit = Number.isSafeInteger(body.limit) && body.limit > 0 ? body.limit : RESOURCES_LIMIT;
    if (total !== null && total > 0) {
      const winStart = effOffset + 1;
      const winEnd = Math.min(effOffset + effLimit, total);
      if (winStart > winEnd) {
        label.textContent = 'Rows 0 of ' + total + ' (' + body.items.length + ' shown).';
      } else if (body.items.length < winEnd - winStart + 1) {
        label.textContent = 'Rows ' + winStart + '–' + winEnd + ' of ' + total + ' (' + body.items.length + ' shown).';
      } else {
        label.textContent = 'Rows ' + winStart + '–' + winEnd + ' of ' + total + '.';
      }
      prev.disabled = effOffset === 0;
      next.disabled = (effOffset + effLimit) >= total;
      pages.hidden = false;
    }
  } catch {
    if (mySeq !== resourcesSeq) return;
    state.textContent = 'Unavailable: request failed.';
  }
}

// ---- Audit (read-only projection over stored events) ----
//
// The server owns the projection: it sends only id, a validated action (or
// null), a category and a validated timestamp. This pane renders exactly that
// and never asks for actor, target or detail — it has no field to put them in.

let auditOffset = 0;
let auditSeq = 0;
const AUDIT_LIMIT = 20;

async function loadAudit(offset) {
  const section = document.getElementById('audit');
  const state = section.querySelector('.state');
  const box = document.getElementById('audit-result');
  const pages = document.getElementById('audit-pages');
  const label = document.getElementById('audit-page-label');
  const prev = document.getElementById('audit-prev');
  const next = document.getElementById('audit-next');
  const myOffset = Math.max(0, offset || 0);
  auditOffset = myOffset;
  const mySeq = ++auditSeq;
  state.textContent = 'Loading…';
  box.textContent = '';
  pages.hidden = true;
  try {
    const res = await fetch('/api/admin/v1/audit?limit=' + AUDIT_LIMIT + '&offset=' + myOffset, { credentials: 'same-origin' });
    if (mySeq !== auditSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== auditSeq) return;
    if (!res.ok || !body) {
      state.textContent = 'Unavailable: ' + requestFailure(body, res.status) + '.';
      return;
    }
    if (body.state !== 'available' || !Array.isArray(body.items)) {
      // Unavailable is a measurement failure, never an empty feed.
      state.textContent = 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').';
      return;
    }
    const total = Number.isSafeInteger(body.total) && body.total >= 0 ? body.total : null;
    state.textContent = 'Loaded ' + unknown(body.observed_at) + '.';
    if (!body.items.length) {
      box.textContent = total === 0 ? 'No audit events recorded (empty).' : 'No rows on this page.';
    } else {
      const rows = body.items.map((it) => {
        const action = it.action_known && typeof it.action === 'string' ? esc(it.action) : 'unknown';
        const at = it.at_known && typeof it.at === 'string' ? esc(it.at) : 'unknown';
        return '<tr><td>' + esc(it.id) + '</td><td>' + action + '</td><td>'
          + esc(it.category || 'unknown') + '</td><td>' + at + '</td></tr>';
      }).join('');
      box.innerHTML = '<table><tr><th>event</th><th>action</th><th>category</th><th>at</th></tr>' + rows + '</table>';
    }
    // Window bounds come from offset plus limit, never from items.length:
    // rows the server declined to project still occupy a slot in total, and
    // the shortfall is disclosed as "(N shown)".
    const effOffset = Number.isSafeInteger(body.offset) && body.offset >= 0 ? body.offset : myOffset;
    const effLimit = Number.isSafeInteger(body.limit) && body.limit > 0 ? body.limit : AUDIT_LIMIT;
    if (total !== null && total > 0) {
      const winStart = effOffset + 1;
      const winEnd = Math.min(effOffset + effLimit, total);
      if (winStart > winEnd) {
        label.textContent = 'Rows 0 of ' + total + ' (' + body.items.length + ' shown).';
      } else if (body.items.length < winEnd - winStart + 1) {
        label.textContent = 'Rows ' + winStart + '–' + winEnd + ' of ' + total + ' (' + body.items.length + ' shown).';
      } else {
        label.textContent = 'Rows ' + winStart + '–' + winEnd + ' of ' + total + '.';
      }
      prev.disabled = effOffset === 0;
      next.disabled = (effOffset + effLimit) >= total;
      pages.hidden = false;
    }
  } catch {
    if (mySeq !== auditSeq) return;
    state.textContent = 'Unavailable: request failed.';
  }
}

// ---- Coverage (static truthful release states; no collectors yet) ----

let coverageSeq = 0;

async function loadCoverage() {
  const mySeq = ++coverageSeq;
  const section = document.getElementById('coverage');
  const state = section.querySelector('.state');
  const box = document.getElementById('coverage-result');
  state.textContent = 'Loading…';
  box.textContent = '';
  try {
    const res = await fetch('/api/admin/v1/coverage', { credentials: 'same-origin' });
    if (mySeq !== coverageSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== coverageSeq) return;
    if (!res.ok || !body) {
      state.textContent = 'Unavailable: ' + requestFailure(body, res.status) + '.';
      return;
    }
    if (body.state !== 'available' || !Array.isArray(body.items)) {
      state.textContent = 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').';
      return;
    }
    state.textContent = 'Loaded ' + unknown(body.observed_at) + '.';
    if (!body.items.length) {
      box.textContent = 'No coverage rows recorded.';
    } else {
      const rows = body.items.map((it) =>
        '<tr><td>' + esc(it.metric) + '</td><td>' + esc(it.release_state)
        + '</td><td>' + esc(it.reason_code || 'unknown') + '</td><td>' + unknown(it.supported_runtime) + '</td></tr>').join('');
      box.innerHTML = '<table><tr><th>metric</th><th>release state</th><th>reason</th><th>runtime</th></tr>' + rows + '</table>';
    }
  } catch {
    if (mySeq !== coverageSeq) return;
    state.textContent = 'Unavailable: request failed.';
  }
}

// ---- Operations health (read-only probes; nothing here changes infra) ----

let healthSeq = 0;

async function loadHealth() {
  const mySeq = ++healthSeq;
  const section = document.getElementById('operations');
  const state = section.querySelector('.state');
  const box = document.getElementById('operations-result');
  state.textContent = 'Loading…';
  box.textContent = '';
  try {
    const res = await fetch('/api/admin/v1/operations/health', { credentials: 'same-origin' });
    if (mySeq !== healthSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== healthSeq) return;
    if (!res.ok || !body) {
      state.textContent = 'Unavailable: ' + requestFailure(body, res.status) + '.';
      return;
    }
    if (body.state !== 'available' || !body.control_plane || !body.compatibility) {
      state.textContent = 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').';
      return;
    }
    state.textContent = 'Loaded ' + unknown(body.observed_at) + '.';
    const c = body.collectors || {};
    box.innerHTML = '<table>'
      + '<tr><th>control plane (d1)</th><td>' + esc(body.control_plane.d1 || 'unknown') + '</td></tr>'
      + '<tr><th>admin grants table</th><td>' + esc(body.control_plane.admin_grants || 'unknown') + '</td></tr>'
      + '<tr><th>collectors</th><td>' + esc(c.state || 'unknown')
      + (c.reason_code ? ' (' + esc(c.reason_code) + ')' : '') + '</td></tr>'
      + '<tr><th>inference</th><td>' + esc(body.compatibility.inference || 'unknown')
      + (body.compatibility.inference_reason_code ? ' (' + esc(body.compatibility.inference_reason_code) + ')' : '') + '</td></tr>'
      + '<tr><th>fabric model</th><td>' + esc(body.compatibility.fabric_model || 'unknown') + '</td></tr>'
      + '<tr><th>worker versions</th><td>' + unknown(body.compatibility.worker_versions)
      + ' (' + esc(body.compatibility.worker_versions_state || 'unknown') + ')</td></tr>'
      + '<tr><th>runtime readiness</th><td>' + unknown(body.compatibility.runtime_readiness)
      + ' (' + esc(body.compatibility.runtime_readiness_state || 'unknown') + ')</td></tr>'
      + '<tr><th>dgm preview</th><td>' + esc(body.compatibility.dgm_preview || 'unknown') + '</td></tr>'
      + '</table>';
  } catch {
    if (mySeq !== healthSeq) return;
    state.textContent = 'Unavailable: request failed.';
  }
}

// ---- Access directory (minimal identity projection, escaped) ----

let usersOffset = 0;
let usersSeq = 0;
const USERS_LIMIT = 20;

async function loadUsers(offset) {
  const section = document.getElementById('access');
  const state = section.querySelector('.state');
  const box = document.getElementById('users-result');
  const pages = document.getElementById('users-pages');
  const label = document.getElementById('users-page-label');
  const prev = document.getElementById('users-prev');
  const next = document.getElementById('users-next');
  const myOffset = Math.max(0, offset || 0);
  usersOffset = myOffset;
  const mySeq = ++usersSeq;
  state.textContent = 'Loading…';
  box.textContent = '';
  pages.hidden = true;
  try {
    const res = await fetch('/api/admin/v1/access/users?limit=' + USERS_LIMIT + '&offset=' + myOffset, { credentials: 'same-origin' });
    if (mySeq !== usersSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== usersSeq) return;
    if (!res.ok || !body) {
      state.textContent = 'Unavailable: ' + requestFailure(body, res.status) + '.';
      return;
    }
    if (body.state !== 'available' || !Array.isArray(body.items)) {
      state.textContent = 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').';
      return;
    }
    const total = Number.isSafeInteger(body.total) && body.total >= 0 ? body.total : null;
    state.textContent = 'Loaded ' + unknown(body.observed_at) + '.';
    if (!body.items.length) {
      box.textContent = total === 0 ? 'No users recorded (empty).' : 'No rows on this page.';
    } else {
      const roleCell = (it) => {
        // null is unknown: a failed read is not "none", and a demo tenant
        // holds no exercisable role even when a row was stored.
        if (!Array.isArray(it.admin_roles)) {
          return it.tenant === 'demo' ? 'not applicable (demo)' : 'unknown';
        }
        return esc(it.admin_roles.join(', ') || 'none');
      };
      const rows = body.items.map((it) =>
        '<tr><td>' + esc(it.id) + '</td><td>' + esc(it.name || 'unknown') + '</td><td>' + esc(it.email || 'unknown')
        + '</td><td>' + esc(it.provider || 'unknown') + '</td><td>' + esc(it.status) + '</td><td>' + esc(it.tenant)
        + '</td><td>' + roleCell(it) + '</td><td>' + unknown(it.keys_active) + '</td></tr>').join('');
      box.innerHTML = '<table><tr><th>id</th><th>name</th><th>email</th><th>provider</th><th>status</th><th>tenant</th><th>admin roles</th><th>keys</th></tr>' + rows + '</table>';
    }
    const effOffset = Number.isSafeInteger(body.offset) && body.offset >= 0 ? body.offset : myOffset;
    const effLimit = Number.isSafeInteger(body.limit) && body.limit > 0 ? body.limit : USERS_LIMIT;
    if (total !== null && total > 0) {
      const winStart = effOffset + 1;
      const winEnd = Math.min(effOffset + effLimit, total);
      if (winStart > winEnd) {
        label.textContent = 'Rows 0 of ' + total + ' (' + body.items.length + ' shown).';
      } else if (body.items.length < winEnd - winStart + 1) {
        label.textContent = 'Rows ' + winStart + '\u2013' + winEnd + ' of ' + total + ' (' + body.items.length + ' shown).';
      } else {
        label.textContent = 'Rows ' + winStart + '\u2013' + winEnd + ' of ' + total + '.';
      }
      prev.disabled = effOffset === 0;
      next.disabled = (effOffset + effLimit) >= total;
      pages.hidden = false;
    }
  } catch {
    if (mySeq !== usersSeq) return;
    state.textContent = 'Unavailable: request failed.';
  }
}

// ---- Access sessions (safe refs only; presence honestly unknown) ----

let sessionsOffset = 0;
let sessionsSeq = 0;
const SESSIONS_LIMIT = 20;

async function loadSessions(offset) {
  const state2 = document.getElementById('sessions-state');
  const box = document.getElementById('sessions-result');
  const pages = document.getElementById('sessions-pages');
  const label = document.getElementById('sessions-page-label');
  const prev = document.getElementById('sessions-prev');
  const next = document.getElementById('sessions-next');
  const myOffset = Math.max(0, offset || 0);
  sessionsOffset = myOffset;
  const mySeq = ++sessionsSeq;
  state2.textContent = 'Loading…';
  box.textContent = '';
  pages.hidden = true;
  try {
    const res = await fetch('/api/admin/v1/access/sessions?limit=' + SESSIONS_LIMIT + '&offset=' + myOffset, { credentials: 'same-origin' });
    if (mySeq !== sessionsSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== sessionsSeq) return;
    if (!res.ok || !body) {
      state2.textContent = 'Unavailable: ' + requestFailure(body, res.status) + '.';
      return;
    }
    if (body.state !== 'available' || !Array.isArray(body.items)) {
      state2.textContent = 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').';
      return;
    }
    const total = Number.isSafeInteger(body.total) && body.total >= 0 ? body.total : null;
    state2.textContent = 'Loaded ' + unknown(body.observed_at) + '.';
    if (!body.items.length) {
      box.textContent = total === 0 ? 'No sessions recorded (empty).' : 'No rows on this page.';
    } else {
      const rows = body.items.map((it) =>
        '<tr><td>' + esc(it.id) + '</td><td>' + esc(it.user_id || 'unknown') + '</td><td>' + esc(it.issued_at || 'unknown')
        + '</td><td>' + esc(it.expires_at || 'unknown') + '</td><td>' + (it.active ? 'active' : 'expired')
        + '</td><td>' + esc(it.authentication_method || 'unknown') + '</td><td>' + esc(it.presence) + '</td></tr>').join('');
      box.innerHTML = '<table><tr><th>session</th><th>user</th><th>issued</th><th>expires</th><th>state</th><th>auth method</th><th>presence</th></tr>' + rows + '</table>';
    }
    const effOffset = Number.isSafeInteger(body.offset) && body.offset >= 0 ? body.offset : myOffset;
    const effLimit = Number.isSafeInteger(body.limit) && body.limit > 0 ? body.limit : SESSIONS_LIMIT;
    if (total !== null && total > 0) {
      const winStart = effOffset + 1;
      const winEnd = Math.min(effOffset + effLimit, total);
      if (winStart > winEnd) {
        label.textContent = 'Rows 0 of ' + total + ' (' + body.items.length + ' shown).';
      } else if (body.items.length < winEnd - winStart + 1) {
        label.textContent = 'Rows ' + winStart + '\u2013' + winEnd + ' of ' + total + ' (' + body.items.length + ' shown).';
      } else {
        label.textContent = 'Rows ' + winStart + '\u2013' + winEnd + ' of ' + total + '.';
      }
      prev.disabled = effOffset === 0;
      next.disabled = (effOffset + effLimit) >= total;
      pages.hidden = false;
    }
  } catch {
    if (mySeq !== sessionsSeq) return;
    state2.textContent = 'Unavailable: request failed.';
  }
}

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

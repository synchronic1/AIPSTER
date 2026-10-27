/* Built with Meta Muse. */
// Control-panel client. Session cookie is httpOnly; sign-in is GitHub OAuth
// for invited testers or the seeded demo username/password (same sessions).
// Mutations carry a custom CSRF header (never a secret). API secrets are
// shown once and never persisted.
'use strict';
let me = null;
// Identity/navigation generation: bumped on logout, sign-in, and tab switch.
// In-flight async work from a previous generation is dropped, never rendered,
// so late owner responses cannot repopulate demo UI (or vice versa).
let generation = 0;
const staleError = () => Object.assign(new Error('Stale response.'), { stale: true });
const isStale = (e) => !!(e && e.stale);

const $ = (id) => document.getElementById(id);
const banner = (msg) => { const b = $('banner'); b.textContent = msg; b.hidden = false; setTimeout(() => { b.hidden = true; }, 3500); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = (el, kind, msg) => { el.innerHTML = `<div class="card ${kind}">${esc(msg)}</div>`; };
const loading = (el) => state(el, 'muted', 'Loading…');

async function api(path, opts = {}) {
  const gen = generation;
  // Auth transitions (logout) run unfenced: their completion must not depend
  // on tab-navigation generations, or a mid-logout tab click could strand
  // owner state after the server session already ended.
  const fenced = !opts.unfenced;
  const init = { ...opts };
  delete init.unfenced;
  let res;
  try {
    res = await fetch(path, { ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.method && init.method !== 'GET' && !path.startsWith('/api/auth/') ? { 'X-Aipster-CSRF': '1' } : {}), ...(init.headers || {}) } });
  } catch (e) {
    if (fenced && gen !== generation) throw staleError();
    throw e;
  }
  if (fenced && gen !== generation) throw staleError();
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (fenced && gen !== generation) throw staleError();
  if (!res.ok) {
    const code = data && data.code ? ` (${data.code})` : '';
    throw new Error((data && data.error ? data.error : `Request failed: ${res.status}`) + code);
  }
  return data;
}

const pill = (ok, label) => `<span class="pill ${ok ? 'ok' : 'bad'}">${esc(label)}: ${ok ? 'yes' : 'no'}</span>`;

function resourceCard(r) {
  const s = r.state || {};
  return `<div class="card"><h2>${esc(r.name)}</h2>
    <p class="muted">${esc(r.id)} · ${esc(r.kind)} · origin: ${esc(r.origin)} · owner: ${esc(r.owner && r.owner.name)}</p>
    <p>${esc(r.compute.cpu)} · ${esc(r.compute.gpu)}</p>
    <p>${pill(s.configured, 'configured')}${pill(s.authenticated, 'authenticated')}${pill(s.online, 'online')}${pill(s.usable, 'usable')}</p>
    <p class="muted">status: ${esc(s.status)} · heartbeat: ${esc(r.heartbeatAt || 'unknown')} · scope: ${esc(r.scope)}</p>
    <p class="muted">capabilities: ${esc((r.capabilities || []).join(', ') || 'none recorded')}</p>
    ${r.credits ? `<p>credits: ${esc(r.credits.label)} ${esc(r.credits.amount)} ${esc(r.credits.currency || '')} <span class="muted">(informational only)</span></p>` : '<p class="muted">credits: unknown / none recorded</p>'}
    <p class="muted">verification: ${esc(r.verification && r.verification.note || 'unknown')}</p></div>`;
}

async function loadOverview() {
  const el = $('ov-cards'); loading(el);
  try {
    const [inv, shared, usage] = await Promise.all([api('/api/inventory?limit=50'), api('/api/shared-with-me?limit=50'), api('/api/usage?limit=1')]);
    const ready = inv.items.filter((r) => r.state.status === 'ready').length;
    el.innerHTML = `<div class="card"><h2>My resources</h2><p>${inv.total} total · ${ready} ready</p></div>
      <div class="card"><h2>Shared with me</h2><p>${shared.total} active grant(s)</p></div>
      <div class="card"><h2>Usage</h2><p>${usage.totals.requests} requests · ${usage.totals.tokensIn + usage.totals.tokensOut} tokens</p></div>`;
    $('ov-note').innerHTML = me && me.demo
      ? '<p class="muted">DEMO DATA: simulated fixtures for exploration. Grants and live actions are disabled. Inference dispatch is disabled.</p>'
      : '<p class="muted">No demo data: only resources you register appear here. Inference dispatch is disabled.</p>';
  } catch (e) { if (isStale(e)) return; state(el, 'error', e.message); }
}

async function loadCompute() {
  const el = $('compute-list'); loading(el);
  try {
    const inv = await api('/api/inventory?limit=50');
    el.innerHTML = inv.items.length ? inv.items.map(resourceCard).join('') : '';
    if (!inv.items.length) state(el, '', 'No resources yet. Register one above.');
    $('grant-resource').innerHTML = inv.items.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  } catch (e) { if (isStale(e)) return; state(el, 'error', e.message); }
}

async function loadShared() {
  const el = $('shared-list'); loading(el);
  try {
    const data = await api('/api/shared-with-me?limit=50');
    el.innerHTML = data.items.length ? data.items.map((g) =>
      `<div class="card"><h2>${esc(g.resourceName)}</h2><p class="muted">from ${esc(g.ownerName)} · inference-only</p>
       <p>jobs ${g.usedJobs}/${g.quotas.maxJobs} · tokens ${g.usedTokens}/${g.quotas.maxTokens}</p>
       <p class="muted">enforcement: ${esc(g.enforcement)}</p></div>`).join('') : '';
    if (!data.items.length) state(el, '', 'Nothing shared with you yet.');
  } catch (e) { if (isStale(e)) return; state(el, 'error', e.message); }
}

async function loadGrants() {
  const el = $('grant-list'); loading(el);
  try {
    const data = await api('/api/grants?limit=50');
    el.innerHTML = data.items.filter((g) => !g.revokedAt).map((g) =>
      `<div class="card"><h2>${esc(g.resourceId)}</h2><p class="muted">→ ${esc(g.granteeId)} · jobs ${g.usedJobs}/${g.quotas.maxJobs} · tokens ${g.usedTokens}/${g.quotas.maxTokens}</p>
       <button type="button" class="danger" data-revoke="${esc(g.id)}">Revoke</button></div>`).join('');
    if (!data.items.some((g) => !g.revokedAt)) state(el, '', 'No outgoing grants.');
    el.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
      try { await api('/api/grants/' + b.dataset.revoke, { method: 'DELETE' }); banner('Grant revoked.'); loadGrants(); }
      catch (e) { if (isStale(e)) return; banner(e.message); }
    }));
  } catch (e) { if (isStale(e)) return; state(el, 'error', e.message); }
}

async function loadKeys() {
  const el = $('key-list'); loading(el);
  try {
    const data = await api('/api/keys?limit=50');
    el.innerHTML = data.items.filter((k) => !k.revokedAt).map((k) =>
      `<div class="card"><h2>${esc(k.name)}</h2><p class="muted">${esc(k.prefix)}… · scope: ${esc(k.scope)}</p>
       <p class="muted">created ${esc(k.createdAt)} · expires ${esc(k.expiresAt || 'never')} · last used ${esc(k.lastUsedAt || 'never')}</p>
       <button type="button" class="danger" data-revkey="${esc(k.id)}">Revoke</button></div>`).join('');
    if (!data.items.some((k) => !k.revokedAt)) state(el, '', 'No API keys yet.');
    el.querySelectorAll('[data-revkey]').forEach((b) => b.addEventListener('click', async () => {
      try { await api('/api/keys/' + b.dataset.revkey, { method: 'DELETE' }); banner('Key revoked.'); loadKeys(); }
      catch (e) { if (isStale(e)) return; banner(e.message); }
    }));
  } catch (e) { if (isStale(e)) return; state(el, 'error', e.message); }
}

async function loadUsage() {
  const t = $('usage-totals'), el = $('usage-list'); loading(el);
  try {
    const data = await api('/api/usage?limit=50');
    const fmt = (v) => (v === null || v === undefined ? 'unknown' : '$' + Number(v).toFixed(4));
    t.innerHTML = `<div class="card"><p>${data.totals.requests} requests · ${data.totals.tokensIn} in / ${data.totals.tokensOut} out tokens</p>
      <p class="muted">model cost ${fmt(data.totals.modelCostUsd)} · execution cost ${fmt(data.totals.executionCostUsd)} (tracked separately; unmeasured stays unknown)</p></div>`;
    el.innerHTML = data.items.map((u) =>
      `<div class="card"><p>${esc(u.kind)} · ${u.requests} req · ${u.tokensIn}/${u.tokensOut} tok</p>
       <p class="muted">${esc(u.at)} · source: ${esc(u.costSource)}</p></div>`).join('');
    if (!data.items.length) state(el, '', 'No usage recorded yet.');
  } catch (e) { if (isStale(e)) return; state(el, 'error', e.message); }
}

async function loadSettings() {
  try {
    const s = await api('/api/settings');
    $('settings-name').value = s.displayName || '';
    $('settings-email').textContent = s.username ? s.username + ' (demo username sign-in)' : (s.email || '');
    $('settings-via').textContent = s.demo ? 'demo username sign-in' : 'GitHub';
    const a = await api('/api/audit?limit=20');
    $('audit-list').innerHTML = a.items.map((x) => `<div class="card"><p>${esc(x.action)} → ${esc(x.target)}</p><p class="muted">${esc(x.at)}</p></div>`).join('') || '<div class="card">No activity yet.</div>';
  } catch (e) { if (isStale(e)) return; banner(e.message); }
}

const loaders = { overview: loadOverview, compute: loadCompute, shared: loadShared, sharing: () => { loadCompute(); loadGrants(); }, federation: loadFederation, keys: loadKeys, usage: loadUsage, settings: loadSettings };

// ---- federation ----
const idem = () => ({ 'Idempotency-Key': (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)) });
let fabPreview = null; // { id, digest } — cleared by resetState
const fabNodes = [];

async function loadFederation() {
  const on = $('fab-on'), off = $('fab-off');
  try {
    const nodes = await api('/v1/fabric/nodes');
    on.hidden = false; off.hidden = true;
    fabNodes.length = 0;
    for (const n of nodes.items) fabNodes.push(n);
    $('fab-node-list').innerHTML = nodes.items.length ? nodes.items.map((n) =>
      `<div class="card"><h2>${esc(n.label)}</h2><p class="muted">${esc(n.id)} · workspace ${esc(n.workspace)} · fingerprint ${esc(n.fingerprint)}</p></div>`).join('')
      : '<div class="card">No nodes yet. Register one above.</div>';
    const opts = nodes.items.map((n) => `<option value="${esc(n.id)}">${esc(n.label)} (${esc(n.id)})</option>`).join('');
    for (const id of ['fab-inv-issuer', 'fab-accept-node', 'fab-authz-node']) $(id).innerHTML = opts;
    const [out, inc, conns] = await Promise.all([
      api('/v1/fabric/invitations?role=issued'), api('/v1/fabric/invitations?role=received'), api('/v1/fabric/connections')
    ]);
    $('fab-inv-out').innerHTML = out.items.length ? out.items.map((v) =>
      `<div class="card"><p>${esc(v.issuer_node)} → ${esc(v.recipient_node)} <span class="muted">(${esc(v.state)})</span></p>
       ${v.state === 'issued' ? `<button type="button" class="danger" data-fab-revoke-inv="${esc(v.id)}">Revoke</button>` : ''}</div>`).join('')
      : '<div class="card">No outgoing invitations.</div>';
    $('fab-inv-in').innerHTML = inc.items.length ? inc.items.map((v) =>
      `<div class="card"><p>${esc(v.issuer_node)} → ${esc(v.recipient_node)} <span class="muted">(${esc(v.state)})</span></p>
       <p class="muted">${esc(v.purpose || 'no purpose recorded')}</p>
       ${v.state === 'issued' ? `<button type="button" class="danger" data-fab-decline-inv="${esc(v.id)}">Decline</button>` : ''}</div>`).join('')
      : '<div class="card">No incoming invitations.</div>';
    $('fab-prev-conn').innerHTML = conns.items.filter((c) => c.state === 'active').map((c) =>
      `<option value="${esc(c.id)}">${esc(c.id)} (${esc(c.a_node)} ↔ ${esc(c.b_node)})</option>`).join('');
    $('fab-conn-list').innerHTML = conns.items.length ? conns.items.map((c) =>
      `<div class="card"><p>${esc(c.a_node)} ↔ ${esc(c.b_node)} <span class="muted">${esc(c.state)} · v${c.version}</span></p>
       <p>
       ${c.state === 'active' ? `<button type="button" data-fab-susp="${esc(c.id)}" data-v="${c.version}">Suspend</button> <button type="button" class="danger" data-fab-disc="${esc(c.id)}" data-v="${c.version}">Disconnect</button>` : ''}
       ${c.state !== 'active' ? `<button type="button" data-fab-resume="${esc(c.id)}" data-v="${c.version}">Resume…</button>` : ''}
       </p><p class="muted" data-fab-resume-msg="${esc(c.id)}"></p></div>`).join('')
      : '<div class="card">No connections yet. Accept an invitation to create one.</div>';
    const [gout, gin, denies] = await Promise.all([
      api('/v1/fabric/grants?scope=outgoing'), api('/v1/fabric/grants?scope=incoming'), api('/v1/fabric/denies')
    ]);
    const grantCard = (g, mine) => `<div class="card"><p>${esc(g.id)} <span class="muted">${esc(g.status)} · v${g.version} · expires ${esc(g.expiry)}</span></p>
      <p class="muted">${(g.snapshot || []).length} resource(s) · models ${(g.models || []).join(', ')}</p>
      ${mine && g.status === 'enforced' ? `<button type="button" data-fab-pause="${esc(g.id)}" data-v="${g.version}">Pause</button> <button type="button" class="danger" data-fab-revoke="${esc(g.id)}" data-v="${g.version}">Revoke</button>` : ''}
      ${mine && g.status === 'paused' ? `<button type="button" data-fab-grant-resume="${esc(g.id)}" data-v="${g.version}">Resume…</button>` : ''}</div>`;
    $('fab-grant-out').innerHTML = gout.items.length ? gout.items.map((g) => grantCard(g, true)).join('') : '<div class="card">No outgoing grants.</div>';
    $('fab-grant-in').innerHTML = gin.items.length ? gin.items.map((g) => grantCard(g, false)).join('') : '<div class="card">No incoming grants.</div>';
    $('fab-deny-list').innerHTML = denies.items.length ? denies.items.map((d) =>
      `<div class="card"><p>deny ${esc(d.action || '*')} on ${esc(d.resource_id || '*')}</p><button type="button" class="danger" data-fab-undeny="${esc(d.id)}">Remove</button></div>`).join('')
      : '<div class="card">No denies.</div>';
    wireFabButtons();
  } catch (e) {
    if (isStale(e)) return;
    on.hidden = true; off.hidden = false;
  }
}

function wireFabButtons() {
  const click = (sel, fn) => document.querySelectorAll(sel).forEach((b) => b.addEventListener('click', fn));
  click('[data-fab-revoke-inv]', async (e) => { try { await api('/v1/fabric/invitations/' + e.target.dataset.fabRevokeInv + '/revoke', { method: 'POST', headers: idem(), body: '{}' }); banner('Invitation revoked.'); loadFederation(); } catch (ex) { if (!isStale(ex)) banner(ex.message); } });
  click('[data-fab-decline-inv]', async (e) => { try { await api('/v1/fabric/invitations/' + e.target.dataset.fabDeclineInv + '/decline', { method: 'POST', headers: idem(), body: '{}' }); banner('Invitation declined.'); loadFederation(); } catch (ex) { if (!isStale(ex)) banner(ex.message); } });
  click('[data-fab-susp]', async (e) => { try { await api('/v1/fabric/connections/' + e.target.dataset.fabSusp + '/suspend', { method: 'POST', headers: idem(), body: JSON.stringify({ expectedVersion: Number(e.target.dataset.v) }) }); banner('Connection suspended.'); loadFederation(); } catch (ex) { if (!isStale(ex)) banner(ex.message); } });
  click('[data-fab-disc]', async (e) => { try { await api('/v1/fabric/connections/' + e.target.dataset.fabDisc + '/disconnect', { method: 'POST', headers: idem(), body: JSON.stringify({ expectedVersion: Number(e.target.dataset.v) }) }); banner('Connection disconnected.'); loadFederation(); } catch (ex) { if (!isStale(ex)) banner(ex.message); } });
  click('[data-fab-resume]', async (e) => {
    const id = e.target.dataset.fabResume, v = Number(e.target.dataset.v);
    const key = prompt('Resume requires one side\'s node secret. Paste it:');
    if (!key) return;
    try { await api('/v1/fabric/connections/' + id + '/resume', { method: 'POST', headers: idem(), body: JSON.stringify({ expectedVersion: v, nodeKey: key }) }); banner('Connection resumed.'); loadFederation(); } catch (ex) { if (!isStale(ex)) banner(ex.message); }
  });
  click('[data-fab-pause]', async (e) => { try { await api('/v1/fabric/grants/' + e.target.dataset.fabPause + '/pause', { method: 'POST', headers: idem(), body: JSON.stringify({ expectedVersion: Number(e.target.dataset.v) }) }); banner('Grant paused.'); loadFederation(); } catch (ex) { if (!isStale(ex)) banner(ex.message); } });
  click('[data-fab-revoke]', async (e) => { try { await api('/v1/fabric/grants/' + e.target.dataset.fabRevoke + '/revoke', { method: 'POST', headers: idem(), body: JSON.stringify({ expectedVersion: Number(e.target.dataset.v) }) }); banner('Grant revoked.'); loadFederation(); } catch (ex) { if (!isStale(ex)) banner(ex.message); } });
  click('[data-fab-grant-resume]', async (e) => {
    const id = e.target.dataset.fabGrantResume, v = Number(e.target.dataset.v);
    try {
      const a = await api('/v1/fabric/approvals', { method: 'POST', headers: idem(), body: JSON.stringify({ action: 'grant.resume', targetId: id }) });
      await api('/v1/fabric/approvals/' + a.id + '/decide', { method: 'POST', headers: idem(), body: JSON.stringify({ decision: 'approve' }) });
      await api('/v1/fabric/grants/' + id + '/resume', { method: 'POST', headers: idem(), body: JSON.stringify({ expectedVersion: v, approvalId: a.id }) });
      banner('Grant resumed.'); loadFederation();
    } catch (ex) { if (!isStale(ex)) banner(ex.message); }
  });
  click('[data-fab-undeny]', async (e) => { try { await api('/v1/fabric/denies/' + e.target.dataset.fabUndeny, { method: 'DELETE' }); banner('Deny removed.'); loadFederation(); } catch (ex) { if (!isStale(ex)) banner(ex.message); } });
}

function resetState() {
  // Clear every identity-scoped pixel and form field. Runs on logout and on
  // every sign-in before the new identity renders, so a same-document account
  // switch never shows the previous identity's data (incl. revealed secrets).
  for (const id of ['ov-cards', 'ov-note', 'compute-list', 'shared-list', 'grant-list', 'key-list', 'usage-totals', 'usage-list', 'audit-list']) $(id).innerHTML = '';
  for (const id of ['fab-node-list', 'fab-inv-out', 'fab-inv-in', 'fab-conn-list', 'fab-grant-out', 'fab-grant-in', 'fab-deny-list', 'fab-authz-out']) $(id).innerHTML = '';
  for (const id of ['fab-inv-issuer', 'fab-accept-node', 'fab-authz-node', 'fab-prev-conn']) $(id).innerHTML = '';
  $('grant-resource').innerHTML = '';
  $('key-secret').textContent = ''; $('key-reveal').hidden = true;
  $('fab-node-secret').textContent = ''; $('fab-node-reveal').hidden = true;
  $('fab-inv-secret').textContent = ''; $('fab-inv-reveal').hidden = true;
  $('fab-commit-box').hidden = true; $('fab-commit-text').textContent = ''; $('fab-commit-digest').textContent = '';
  fabPreview = null; fabNodes.length = 0;
  $('fab-on').hidden = true; $('fab-off').hidden = true;
  $('whoami').textContent = '';
  $('settings-email').textContent = ''; $('settings-via').textContent = '…';
  for (const id of ['res-name', 'res-origin', 'res-cpu', 'res-gpu', 'res-caps', 'grant-user', 'key-name', 'key-expires', 'settings-name', 'demo-username', 'demo-password']) $(id).value = '';
  for (const id of ['fab-node-label', 'fab-node-ws', 'fab-inv-node', 'fab-inv-ws', 'fab-inv-purpose', 'fab-accept-token', 'fab-accept-key', 'fab-prev-res', 'fab-prev-consumers', 'fab-prev-models', 'fab-deny-res', 'fab-deny-action', 'fab-authz-res', 'fab-authz-model', 'fab-authz-consumer']) $(id).value = '';
  $('grant-jobs').value = '50'; $('grant-tokens').value = '50000'; $('key-scope').value = 'read';
  $('fab-prev-tokens').value = '100000'; $('fab-prev-reqs').value = '1000';
  for (const id of ['login-error', 'demo-error', 'resource-error', 'grant-error', 'key-error', 'settings-error']) { const e = $(id); e.textContent = ''; e.hidden = true; }
  for (const id of ['fab-node-error', 'fab-inv-error', 'fab-accept-error', 'fab-prev-error', 'fab-commit-error', 'fab-deny-error', 'fab-authz-error']) { const e = $(id); e.textContent = ''; e.hidden = true; }
  $('banner').textContent = ''; $('banner').hidden = true;
  $('demo-banner').hidden = true; $('demo-grants-note').hidden = true; $('demo-keys-note').hidden = true; $('demo-fab-note').hidden = true;
  $('grant-form').hidden = false;
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === 'overview' ? 'true' : 'false'));
  document.querySelectorAll('[role="tabpanel"]').forEach((p) => { p.hidden = p.id !== 'tab-overview'; });
}

document.querySelectorAll('[data-tab]').forEach((btn) => btn.addEventListener('click', () => {
  generation++;
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', b === btn ? 'true' : 'false'));
  document.querySelectorAll('[role="tabpanel"]').forEach((p) => { p.hidden = p.id !== 'tab-' + btn.dataset.tab; });
  loaders[btn.dataset.tab]();
}));

$('github-login').addEventListener('click', async () => {
  const err = $('login-error'); err.hidden = true;
  try {
    const data = await api('/api/auth/sign-in/social', { method: 'POST', body: JSON.stringify({ provider: 'github', callbackURL: location.origin + '/app/' }) });
    const url = data && (data.url || data.redirect);
    if (!url) throw new Error('Sign-in did not return a redirect.');
    location.assign(url);
  } catch (ex) { if (isStale(ex)) return; err.textContent = ex.message; err.hidden = false; }
});

$('demo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('demo-error'); err.hidden = true;
  const password = $('demo-password').value;
  $('demo-password').value = '';
  try {
    await api('/api/auth/sign-in/username', { method: 'POST', body: JSON.stringify({ username: $('demo-username').value.trim(), password }) });
    const data = await api('/api/auth/get-session');
    if (!data || !data.user) throw new Error('Demo sign-in did not establish a session.');
    me = data.user; showApp();
  } catch (ex) { if (isStale(ex)) return; err.textContent = ex.message; err.hidden = false; }
});

$('logout').addEventListener('click', async () => {
  // A failed sign-out must never present as completed: only transition on
  // success, and say so on failure (review finding, fixed).
  try {
    // Empty JSON body: the auth endpoint requires a JSON content type.
    // Unfenced: tab navigation during logout must not invalidate cleanup.
    // A genuine failure still banners and stays signed in.
    await api('/api/auth/sign-out', { method: 'POST', body: '{}', unfenced: true });
  } catch (ex) { banner('Sign-out failed: ' + ex.message); return; }
  generation++;
  me = null;
  resetState();
  $('view-app').hidden = true; $('view-login').hidden = false; $('sessionbar').hidden = true;
});

$('resource-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('resource-error'); err.hidden = true;
  try {
    const caps = $('res-caps').value.split(',').map((s) => s.trim()).filter(Boolean);
    await api('/api/inventory', { method: 'POST', body: JSON.stringify({ name: $('res-name').value, kind: $('res-kind').value, origin: $('res-origin').value, cpu: $('res-cpu').value, gpu: $('res-gpu').value, capabilities: caps }) });
    $('res-name').value = ''; $('res-origin').value = ''; $('res-cpu').value = ''; $('res-gpu').value = ''; $('res-caps').value = '';
    banner('Resource registered (unverified).'); loadCompute();
  } catch (ex) { if (isStale(ex)) return; err.textContent = ex.message; err.hidden = false; }
});

$('grant-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('grant-error'); err.hidden = true;
  try {
    await api('/api/grants', { method: 'POST', body: JSON.stringify({ resourceId: $('grant-resource').value, grantee: $('grant-user').value, maxJobs: Number($('grant-jobs').value), maxTokens: Number($('grant-tokens').value) }) });
    $('grant-user').value = ''; banner('Grant created.'); loadGrants();
  } catch (ex) { if (isStale(ex)) return; err.textContent = ex.message; err.hidden = false; }
});

$('key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('key-error'); err.hidden = true;
  try {
    const body = { name: $('key-name').value, scope: $('key-scope').value };
    if ($('key-expires').value) body.expiresAt = new Date($('key-expires').value + 'T00:00:00Z').toISOString();
    const k = await api('/api/keys', { method: 'POST', body: JSON.stringify(body) });
    $('key-secret').textContent = k.secret;
    $('key-reveal').hidden = false;
    $('key-name').value = ''; $('key-expires').value = '';
    loadKeys();
  } catch (ex) { if (isStale(ex)) return; err.textContent = ex.message; err.hidden = false; }
});
$('key-dismiss').addEventListener('click', () => { $('key-secret').textContent = ''; $('key-reveal').hidden = true; });

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('settings-error'); err.hidden = true;
  try {
    const s = await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ displayName: $('settings-name').value }) });
    banner('Saved.'); me.name = s.displayName; $('whoami').textContent = me.name + ' (' + me.email + ')';
  } catch (ex) { if (isStale(ex)) return; err.textContent = ex.message; err.hidden = false; }
});

$('fab-node-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('fab-node-error'); err.hidden = true;
  try {
    const n = await api('/v1/fabric/nodes', { method: 'POST', headers: idem(), body: JSON.stringify({ label: $('fab-node-label').value, workspace: $('fab-node-ws').value || 'default' }) });
    $('fab-node-secret').textContent = n.nodeSecret;
    $('fab-node-reveal').hidden = false;
    $('fab-node-label').value = ''; $('fab-node-ws').value = '';
    loadFederation();
  } catch (ex) { if (isStale(ex)) return; err.textContent = ex.message; err.hidden = false; }
});
$('fab-node-dismiss').addEventListener('click', () => { $('fab-node-secret').textContent = ''; $('fab-node-reveal').hidden = true; });

$('fab-inv-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('fab-inv-error'); err.hidden = true;
  try {
    const v = await api('/v1/fabric/invitations', { method: 'POST', headers: idem(), body: JSON.stringify({ issuerNode: $('fab-inv-issuer').value, recipientNode: $('fab-inv-node').value.trim(), recipientWorkspace: $('fab-inv-ws').value.trim() || 'default', purpose: $('fab-inv-purpose').value }) });
    $('fab-inv-secret').textContent = v.token;
    $('fab-inv-reveal').hidden = false;
    $('fab-inv-node').value = ''; $('fab-inv-ws').value = ''; $('fab-inv-purpose').value = '';
    loadFederation();
  } catch (ex) { if (isStale(ex)) return; err.textContent = ex.message; err.hidden = false; }
});
$('fab-inv-dismiss').addEventListener('click', () => { $('fab-inv-secret').textContent = ''; $('fab-inv-reveal').hidden = true; });

$('fab-accept-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('fab-accept-error'); err.hidden = true;
  const token = $('fab-accept-token').value, nodeKey = $('fab-accept-key').value;
  $('fab-accept-token').value = ''; $('fab-accept-key').value = '';
  try {
    await api('/v1/fabric/invitations/accept', { method: 'POST', headers: idem(), body: JSON.stringify({ token, nodeId: $('fab-accept-node').value, nodeKey }) });
    banner('Invitation accepted. Connection carries zero resource access until you commit a grant.');
    loadFederation();
  } catch (ex) { if (isStale(ex)) return; err.textContent = ex.message; err.hidden = false; }
});

$('fab-prev-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('fab-prev-error'); err.hidden = true;
  const csv = (id) => $(id).value.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const p = await api('/v1/fabric/previews', { method: 'POST', headers: idem(), body: JSON.stringify({ connectionId: $('fab-prev-conn').value, resourceIds: csv('fab-prev-res'), consumers: csv('fab-prev-consumers'), models: csv('fab-prev-models'), maxTokens: Number($('fab-prev-tokens').value), maxRequests: Number($('fab-prev-reqs').value) }) });
    fabPreview = { id: p.id, digest: p.digest };
    $('fab-commit-text').textContent = p.confirmation;
    $('fab-commit-digest').textContent = p.digest;
    $('fab-commit-error').hidden = true;
    $('fab-commit-box').hidden = false;
  } catch (ex) { if (isStale(ex)) return; err.textContent = ex.message; err.hidden = false; }
});

$('fab-commit-go').addEventListener('click', async () => {
  const err = $('fab-commit-error'); err.hidden = true;
  if (!fabPreview) { err.textContent = 'Build a preview first.'; err.hidden = false; return; }
  try {
    const a = await api('/v1/fabric/approvals', { method: 'POST', headers: idem(), body: JSON.stringify({ previewId: fabPreview.id }) });
    await api('/v1/fabric/approvals/' + a.id + '/decide', { method: 'POST', headers: idem(), body: JSON.stringify({ decision: 'approve' }) });
    await api('/v1/fabric/grants', { method: 'POST', headers: idem(), body: JSON.stringify({ approvalId: a.id, previewHash: fabPreview.digest }) });
    fabPreview = null; $('fab-commit-box').hidden = true;
    $('fab-prev-res').value = ''; $('fab-prev-consumers').value = ''; $('fab-prev-models').value = '';
    banner('Grant committed and enforced.'); loadFederation();
  } catch (ex) { if (isStale(ex)) return; err.textContent = ex.message; err.hidden = false; }
});

$('fab-deny-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('fab-deny-error'); err.hidden = true;
  try {
    await api('/v1/fabric/denies', { method: 'POST', headers: idem(), body: JSON.stringify({ resourceId: $('fab-deny-res').value.trim() || undefined, action: $('fab-deny-action').value.trim() || undefined }) });
    $('fab-deny-res').value = ''; $('fab-deny-action').value = '';
    banner('Deny added.'); loadFederation();
  } catch (ex) { if (isStale(ex)) return; err.textContent = ex.message; err.hidden = false; }
});

$('fab-authz-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('fab-authz-error'); err.hidden = true;
  const out = $('fab-authz-out');
  try {
    const r = await api('/v1/fabric/authorization/preview', { method: 'POST', body: JSON.stringify({ nodeId: $('fab-authz-node').value, resourceId: $('fab-authz-res').value.trim(), incarnation: 'gen1', action: 'infer', model: $('fab-authz-model').value.trim(), consumer: $('fab-authz-consumer').value.trim(), maxTokens: 1000 }) });
    out.innerHTML = `<div class="card"><h2>Decision: ${esc(r.decision)}</h2><p class="muted">${esc(r.code)} · evaluated ${esc(r.evaluated)} grant(s)</p></div>`;
  } catch (ex) { if (isStale(ex)) return; err.textContent = ex.message; err.hidden = false; }
});

function showApp() {
  generation++;
  resetState();
  $('view-login').hidden = true; $('view-app').hidden = false; $('sessionbar').hidden = false;
  $('whoami').textContent = me.name + ' (' + (me.username || me.email) + ')';
  const demo = !!(me && me.demo);
  $('demo-banner').hidden = !demo;
  $('grant-form').hidden = demo;
  $('demo-grants-note').hidden = !demo;
  $('demo-keys-note').hidden = !demo;
  $('demo-fab-note').hidden = !demo;
  loadOverview();
}

(async () => {
  try {
    const data = await api('/api/auth/get-session');
    if (data && data.user) { me = data.user; showApp(); }
  } catch { /* stay on login */ }
})();

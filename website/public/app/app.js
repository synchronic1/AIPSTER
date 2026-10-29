/* Built with Meta Muse. */
// Control-panel client. Session cookie is httpOnly; sign-in is GitHub OAuth
// for public GitHub registration or the seeded demo username/password (same sessions).
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

// ---- resource-status strip (read-only, bounded polling) ----
// Polls GET /api/status only while signed in on the Overview tab: a 30s base
// interval with exponential backoff to 5min on failure, stopping entirely on
// auth loss or after repeated failures. Token + generation fencing drops
// late/stale work exactly like every other loader; no timers are cleared
// because invalidation (not cancellation) is the established pattern here.
let statusPollToken = 0;
const STATUS_POLL_BASE_MS = 30000;
const STATUS_POLL_MAX_MS = 5 * 60 * 1000;
const STATUS_POLL_MAX_FAILURES = 10;

const formatAge = (ms) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
};

function renderStatus(el, data) {
  const s = data.summary || { total: 0, online: 0, stale: 0, offline: 0, unknown: 0 };
  const list = data.items || [];
  const items = list.map((r) =>
    `<p class="muted">${esc(r.name)} · ${esc(r.kind)} · ${esc(r.liveness)} · last seen ${esc(r.lastSeenAgeMs === null || r.lastSeenAgeMs === undefined ? 'never' : formatAge(r.lastSeenAgeMs))}${r.demoFixture ? ' · DEMO' : ''}</p>`).join('');
  const note = data.demo
    ? 'DEMO DATA: simulated fixture, not a live node.'
    : 'Declared resources only — live telemetry is unavailable, so nothing here means ready to run.';
  // Counts always cover every owned resource; only the listed page is capped.
  const truncated = data.itemsTruncated === true
    ? `<p class="muted">showing ${list.length} of ${s.total} — older resources omitted from the list; counts cover all resources.</p>`
    : '';
  el.innerHTML = `<h2>Resource status</h2>
    <p class="muted">${s.total} resource(s) · ${s.online} online · ${s.stale} stale · ${s.offline} offline · ${s.unknown} unknown · ${data.sharedWithMe} shared with me</p>
    ${truncated}
    ${items || '<p class="muted">No resources yet.</p>'}
    <p class="muted">${esc(note)}</p>`;
}

function scheduleStatusPoll(token, gen, delayMs, failures) {
  if (typeof setTimeout !== 'function') return;
  setTimeout(() => {
    if (token !== statusPollToken || gen !== generation) return;
    refreshStatusStrip(token, gen, failures);
  }, delayMs);
}

async function refreshStatusStrip(token, gen, failures) {
  const strip = $('status-strip');
  try {
    const data = await api('/api/status');
    if (token !== statusPollToken || gen !== generation) return;
    renderStatus(strip, data);
    scheduleStatusPoll(token, gen, STATUS_POLL_BASE_MS, 0);
  } catch (e) {
    if (isStale(e) || token !== statusPollToken || gen !== generation) return;
    if (/AUTH_REQUIRED|KEY_EXPIRED/.test(e.message)) {
      strip.innerHTML = '<h2>Resource status</h2><p class="muted">Sign-in expired — status updates paused.</p>';
      return;
    }
    const next = failures + 1;
    if (next >= STATUS_POLL_MAX_FAILURES) {
      strip.innerHTML = '<h2>Resource status</h2><p class="muted">Status unavailable after repeated retries — reopen Overview to try again.</p>';
      return;
    }
    strip.innerHTML = '<h2>Resource status</h2><p class="muted">Status update failed — retrying quietly.</p>';
    scheduleStatusPoll(token, gen, Math.min(STATUS_POLL_BASE_MS * 2 ** next, STATUS_POLL_MAX_MS), next);
  }
}

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
  const token = ++statusPollToken;
  const gen = generation;
  $('status-strip').innerHTML = '<h2>Resource status</h2><p class="muted">Checking resource status…</p>';
  refreshStatusStrip(token, gen, 0);
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

// "Connect your computer" onboarding. Installer-first and OS-aware: a primary
// installer action, a secondary agent-assisted setup that copies pinned,
// secret-free instructions, and an OS picker that corrects detection. Every
// destination is the public AIPSTER repo at the pinned commit whose
// local-worker/ files were checked against provenance.json. The pin is the
// reviewed #17 head (merged; worker requires a local token and validates
// Host/Origin); move it only with a re-verified re-pin. The card makes no API
// call, holds no credential, and auto-launches nothing. No verified installer
// is packaged for any platform yet and heartbeat/pairing support (PR #20) is
// not deployed, so progress honestly stops at "Setup needed".
const WORKER_COMMIT = '242c5300e0379d25bcb1624c67abc9806271d1df';
const WORKER_TREE = 'https://github.com/synchronic1/AIPSTER/blob/' + WORKER_COMMIT + '/local-worker/';
const WORKER_LINKS = {
  quickstart: WORKER_TREE + 'README.md',
  tested: WORKER_TREE + 'README.md#tested-installation',
  engine: WORKER_TREE + 'README.md#optional-real-engine-preparation-not-needed-for-the-mock-check',
  troubleshoot: WORKER_TREE + 'README.md#stop-uninstall-and-troubleshoot',
  evidence: WORKER_TREE + 'VERIFICATION.md',
  gaps: WORKER_TREE + 'EXECUTION-GAPS.md',
  securityFix: 'https://github.com/synchronic1/AIPSTER/pull/17',
  heartbeat: 'https://github.com/synchronic1/AIPSTER/pull/20'
};
const COPIED_MESSAGE = 'Instructions copied. Open ChatGPT, Claude, or your preferred local agent and paste these instructions.';

// Verified installer availability per platform. Every platform is honestly
// unavailable until a packaging PR ships a worker-only artifact (the worker
// plus its install files, licenses and provenance, pinned to a reviewed
// commit with a checksum) and qualifies it. An available entry is
// { available: true, url, sha256, version } and renders a real download with
// its checksum; the repository archive is never offered as an installer.
const INSTALLERS = {
  windows: { available: false, reason: 'no verified installer package exists yet' },
  macos: { available: false, reason: 'no verified installer package exists yet' },
  linux: { available: false, reason: 'no verified installer package exists yet' }
};
const OS_META = {
  windows: { label: 'Windows x64', shell: 'PowerShell', venvBin: '.\\.venv\\Scripts', posix: false },
  macos: { label: 'macOS', shell: 'Terminal', venvBin: '.venv/bin', posix: true },
  linux: { label: 'Linux', shell: 'a shell', venvBin: '.venv/bin', posix: true }
};

// Best-effort OS suggestion; the picker always lets the user correct it.
function detectOs() {
  try {
    if (typeof navigator === 'undefined') return null;
    const plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    const s = String(plat).toLowerCase();
    if (s.includes('win')) return 'windows';
    if (s.includes('mac')) return 'macos';
    if (s.includes('linux') || s.includes('android') || s.includes('cros')) return 'linux';
  } catch { /* detection unavailable */ }
  return null;
}

// Pinned worker commands per OS: worker-only sparse checkout at WORKER_COMMIT,
// isolated install, self-test, fresh worker-local token, mock serve.
function workerCommands(os) {
  const meta = OS_META[os] || OS_META.windows;
  const py = meta.posix ? meta.venvBin + '/python' : meta.venvBin + '\\python.exe';
  const exe = meta.posix ? meta.venvBin + '/dendrite' : meta.venvBin + '\\dendrite.exe';
  const token = meta.posix
    ? "export DENDRITE_API_TOKEN=\"$(" + meta.venvBin + "/python -c 'import secrets; print(secrets.token_urlsafe(32))')\""
    : '$env:DENDRITE_API_TOKEN = ' + meta.venvBin + '\\python.exe -c "import secrets; print(secrets.token_urlsafe(32))"';
  return [
    'git clone --filter=blob:none --no-checkout https://github.com/synchronic1/AIPSTER.git',
    'cd AIPSTER',
    'git sparse-checkout set --no-cone local-worker',
    'git fetch origin ' + WORKER_COMMIT,
    'git checkout --detach ' + WORKER_COMMIT,
    'cd local-worker',
    'uv run --no-project --python 3.12.14 python install.py',
    py + ' test_installation.py',
    token,
    exe + ' serve --config configs/mock.toml'
  ];
}

// Complete, version-pinned instructions for the user's own local agent. They
// contain no credential and no AIPSTER endpoint: the agent generates a fresh
// worker-local token on the machine, and the worker never contacts AIPSTER.
function agentInstructions(os) {
  const meta = OS_META[os] || OS_META.windows;
  const lines = workerCommands(os);
  const fetch = lines.slice(0, 6).map((l) => '  ' + l).join('\n');
  const tested = os === 'windows'
    ? 'Windows x64 is the only tested platform (mock check only).'
    : 'Only Windows x64 is tested; macOS and Linux steps are untested adaptation, so verify each step before continuing.';
  return ['Set up the AIPSTER local worker on THIS computer (assisted install).',
    '',
    'READ FIRST - what this does and does NOT do:',
    '- Install the local Dendrite worker (ganglion-dendrite 0.1.0) from the reviewed',
    '  AIPSTER source revision below, in an isolated folder on this machine.',
    '- Installing does NOT share this computer, does NOT enable inference, and does',
    '  NOT contact AIPSTER: the worker gets no AIPSTER credential and there is no',
    '  pairing step yet. AIPSTER dispatch stays disabled.',
    '- Inspect this machine first, then explain every change BEFORE making it and',
    '  wait for my approval. Do not change system Python, install global packages,',
    '  add services or startup tasks, or expose anything to a network.',
    '',
    'Pinned source - do not substitute another revision:',
    '- Repository: https://github.com/synchronic1/AIPSTER',
    '- Commit: ' + WORKER_COMMIT + ' (security-fixed: local token required, Host/Origin checked)',
    '- Worker directory: local-worker/',
    '- Quickstart (follow its Tested installation exactly): ' + WORKER_LINKS.quickstart,
    '',
    'Step 1 - inspect this machine (report, change nothing):',
    '- OS and CPU architecture; Git version; uv 0.12.12 exactly (must match); Python',
    '  3.12.14 availability (install with "uv python install 3.12.14" if missing);',
    '  about 1 GiB free disk space and memory for tooling.',
    '- ' + tested,
    '',
    'Step 2 - fetch worker files only (in ' + meta.shell + '):',
    fetch,
    '',
    'Step 3 - install into an isolated environment:',
    '- Run: ' + lines[6],
    '  (verifies vendored hashes, refuses an existing .venv, installs hash-locked',
    '  wheels from public PyPI; needs network to public Python hosts on first use).',
    '- Run the self-test: ' + lines[7],
    '- On any failure: stop, show the error, and point at the README troubleshooting',
    '  table. Do not edit lock files or retry with other versions.',
    '',
    'Step 4 - create the worker-LOCAL token on this machine:',
    '- Generate a fresh random value of 32+ characters and keep it in this terminal',
    '  session only:',
    '  ' + lines[8],
    '- This token is NOT an AIPSTER key: never paste it into AIPSTER, a URL, a file',
    '  you share, or any chat log. "serve" refuses to start without it, even on loopback.',
    '',
    'Step 5 - start the mock worker and verify (simulated output only):',
    '- Start: ' + lines[9],
    '- In a second terminal with the same token, run the three verification requests',
    '  from the quickstart\'s second-terminal block against the loopback address it',
    '  specifies (health, node identity, simulated execution). Expect ok status and',
    '  simulated output. A running worker is NOT proof of inference readiness: no',
    '  engine or model is installed by these steps.',
    '',
    'Step 6 - record this computer in AIPSTER (I do this myself, not you):',
    '- In AIPSTER My Compute I use Register resource. It is saved as declared and',
    '  unverified. There is no pairing code or worker credential yet, so this does',
    '  not connect the worker.',
    '',
    'Finish by reporting: installed revision, inspect and test results, how to stop',
    '(Ctrl+C, then discard the token) and uninstall (delete local-worker/.venv and',
    'local-worker/.state if present), and that connection stays pending until',
    'AIPSTER ships heartbeat and pairing support.'
  ].join('\n');
}

let connect = null;

function paintConnectCard() {
  const el = $('connect-card');
  if (!connect) { el.innerHTML = ''; el.hidden = true; return; }
  const L = WORKER_LINKS;
  const meta = OS_META[connect.os];
  const options = ['windows', 'macos', 'linux'].map((k) =>
    `<option value="${k}"${k === connect.os ? ' selected' : ''}>${esc(OS_META[k].label)}</option>`).join('');
  const detectedNote = connect.detected
    ? `Detected: ${esc(OS_META[connect.detected].label)}. Change it if that is wrong.`
    : 'Detection unavailable in this browser — pick your system and the steps below follow it.';
  const inst = INSTALLERS[connect.os];
  const primary = inst.available
    ? `<a class="btn" href="${esc(inst.url)}">Download installer</a>`
    : '<button type="button" class="btn" data-action="download">Download installer</button>';
  const installerLine = inst.available
    ? `<p class="muted">Installer for ${esc(meta.label)} ${esc(inst.version)}: verify the SHA-256 checksum <code>${esc(inst.sha256)}</code> before running it.</p>`
    : `<p class="muted">Installer for ${esc(meta.label)}: <strong>not available</strong> — ${esc(inst.reason)}, so there is nothing to download. The worker is published as source only.</p>`;
  let status = '';
  if (connect.phase === 'download-note') {
    status = `<p class="notice" role="status">No verified installer for ${esc(meta.label)} yet — ${esc(inst.reason)}. Use "Set up with my agent" above, or Advanced below for the pinned manual steps.</p>`;
  } else if (connect.phase === 'copied') {
    status = `<p class="notice" role="status"><span class="pill ok">Copied</span> ${esc(COPIED_MESSAGE)}</p>`;
  } else if (connect.phase === 'copy-failed') {
    status = `<p class="notice" role="status"><span class="pill warn">Copy unavailable</span> This browser would not let the page copy automatically. Select the instructions below and copy them yourself, or press "Set up with my agent" to try again.</p><label>Setup instructions (select and copy)<textarea class="copy-fallback" readonly rows="18">${esc(connect.fallback)}</textarea></label>`;
  }
  const commands = workerCommands(connect.os).map(esc).join('\n');
  const advanced = `<details><summary>Advanced: manual install, source and troubleshooting</summary>
<h3>Manual install (${esc(meta.label)})</h3>
<p>Prerequisites: Git, <code>uv 0.12.12</code> and Python 3.12.14 (<code>uv python install 3.12.14</code>). In ${esc(meta.shell)}, following the <a href="${L.tested}">tested installation</a> (the clone fetches worker files only via sparse checkout):</p>
<pre tabindex="0" aria-label="${esc(meta.label)} install commands"><code>${commands}</code></pre>
<p class="muted"><code>serve</code> refuses to start without <code>DENDRITE_API_TOKEN</code> (32+ characters), even on loopback. This is a <strong>worker-local</strong> token that you generate on this machine. It is not an AIPSTER API key or heartbeat key. Never reuse it, and never paste it into AIPSTER, a URL or a shared config. Local requests other than <code>/healthz</code> need <code>Authorization: Bearer</code> with that token (see the <a href="${L.quickstart}">quickstart</a>).</p>
<p class="muted">The mock config returns simulated output only. A native engine (llama-server, built separately) and a GGUF model you obtain yourself are separate prerequisites. See <a href="${L.engine}">engine preparation</a>.</p>
<h3>Platforms and source</h3>
<ul class="platforms"><li><span class="pill ok">Windows x64: tested</span> <span class="muted">mock check only, from a git clone with CPython 3.12.14 and uv 0.12.12 (<a href="${L.evidence}">evidence</a>). No real engine or model was tested.</span></li>
<li><span class="pill warn">macOS / Linux: not qualified</span> <span class="muted">commands are for adaptation only (use <code>.venv/bin/</code>). They are untested.</span></li></ul>
<p class="muted">The worker is published as source, pinned to the <a href="${L.securityFix}">security-fixed revision</a> that requires a local token and checks Host/Origin.</p>
<h3>Connect</h3>
<p>For now, record this computer with <strong>Register resource</strong> below. It is saved as a declared, unverified resource. There is no pairing code or worker credential yet, so the worker never contacts AIPSTER.</p>
<p>Status: <strong>not connected</strong>. Registered resources show as unverified/offline until heartbeat support ships. A running worker is not proof of readiness. See the <a href="${L.gaps}">execution gaps</a>.</p>
<details><summary>Troubleshooting</summary><ul><li>Existing <code>.venv</code>: use a fresh clone, or stop the worker and remove that local venv.</li><li>uv version mismatch: install uv 0.12.12. Do not update the lock files.</li><li>Hash mismatch: restore the exact public commit and run <code>verify_vendor.py</code>.</li><li><code>serve</code> exits asking for <code>DENDRITE_API_TOKEN</code>: generate a fresh value of 32+ characters as shown above.</li><li>401 from <code>/v1/...</code>: send <code>Authorization: Bearer</code> with the exact token the worker started with.</li><li>400 Host or 403 Origin not allowed: call the worker by its loopback address and port, not another hostname.</li><li>Port 8090 in use: stop the old instance or pick a free loopback port in the config.</li><li>TLS or package index failure: check access to public PyPI.</li></ul><p><a href="${L.troubleshoot}">Full troubleshooting table</a></p></details>
<details><summary>Disconnect and uninstall</summary><p>Stop the worker with Ctrl+C, then close the terminal or run <code>Remove-Item Env:DENDRITE_API_TOKEN</code> to discard the local token. To uninstall, delete only <code>local-worker/.venv</code> (and <code>.state</code> if present). This setup adds no service, startup task or global package. The worker holds no AIPSTER credential, so there is nothing to revoke here. Keep it on loopback and never expose it to a network.</p></details>
</details>`;
  el.innerHTML = `<div class="connect-grid"><div class="connect-rail">
<h2>Connect your computer</h2>
<svg class="connect-illus" viewBox="0 0 220 150" width="220" height="150" role="img" aria-label="A computer connecting to a three-node inference fabric"><g fill="none" stroke-linecap="round"><rect x="14" y="48" width="76" height="54" rx="6" fill="#0b0e12" stroke="#F2B887" stroke-width="4"/><line x1="38" y1="102" x2="38" y2="114" stroke="#F2B887" stroke-width="4"/><line x1="66" y1="102" x2="66" y2="114" stroke="#F2B887" stroke-width="4"/><line x1="28" y1="114" x2="76" y2="114" stroke="#F2B887" stroke-width="4"/><line x1="90" y1="62" x2="140" y2="48" stroke="#7c9787" stroke-width="4" stroke-dasharray="2 8"/><line x1="90" y1="88" x2="140" y2="102" stroke="#7c9787" stroke-width="4" stroke-dasharray="2 8"/><circle cx="162" cy="42" r="20" fill="#0b0e12" stroke="#98c379" stroke-width="4"/><circle cx="162" cy="108" r="20" fill="#0b0e12" stroke="#98c379" stroke-width="4"/><circle cx="198" cy="75" r="14" fill="#0b0e12" stroke="#98c379" stroke-width="4"/><line x1="162" y1="62" x2="162" y2="88" stroke="#98c379" stroke-width="3"/></g></svg>
<p class="benefit">Prepare the computer you are using now for future sharing. Installing the worker never shares anything or enables inference by itself.</p>
<ol class="progress" aria-label="Connection progress">
<li class="now" aria-current="step"><strong>Setup needed</strong><span class="st muted">You are here. Not connected.</span></li>
<li><strong>Installing</strong><span class="st muted">Blocked: no verified installer is packaged yet.</span></li>
<li><strong>Pairing</strong><span class="st muted">Blocked: <a href="${L.heartbeat}">heartbeat and pairing support</a> is not merged or deployed.</span></li>
<li><strong>Connected</strong><span class="st muted">Needs verified worker evidence. A download or a running worker is not proof.</span></li>
</ol>
<p><span class="pill warn">Setup needed</span></p>
</div><div class="connect-body">
<p class="lede">Connect this computer in two steps: install the local worker (<code>ganglion-dendrite 0.1.0</code>, reviewed AIPSTER commit <code>${WORKER_COMMIT.slice(0, 7)}</code>), then register it below. AIPSTER dispatch stays disabled, and nothing is shared unless you create a grant.</p>
<div class="osrow"><label for="connect-os">Your system</label><select id="connect-os" data-action="os">${options}</select><span class="muted">${detectedNote}</span></div>
<p class="actions">${primary}<button type="button" class="btn secondary" data-action="copy-agent">Set up with my agent</button></p>
${installerLine}
${status}
${advanced}
</div></div>`;
  el.hidden = false;
}

function onConnectClick(ev) {
  if (!connect) return;
  const t = ev && ev.target;
  const near = t && typeof t.closest === 'function' ? t.closest('[data-action]') : null;
  const action = (near && near.dataset && near.dataset.action) || (t && t.dataset && t.dataset.action);
  if (action === 'download') {
    connect.phase = 'download-note';
    paintConnectCard();
  } else if (action === 'copy-agent') {
    copyAgentInstructions();
  }
}

function onConnectChange(ev) {
  if (!connect) return;
  const t = ev && ev.target;
  if (t && t.dataset && t.dataset.action === 'os' && OS_META[t.value]) {
    connect.os = t.value;
    connect.phase = 'idle';
    connect.fallback = '';
    paintConnectCard();
  }
}

async function copyAgentInstructions() {
  if (!connect) return;
  const gen = generation;
  const text = agentInstructions(connect.os);
  let clipboard = null;
  try {
    clipboard = (typeof navigator !== 'undefined' && navigator.clipboard) || null;
  } catch { clipboard = null; }
  try {
    if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
    await clipboard.writeText(text);
    if (gen !== generation) return;
    connect.phase = 'copied';
    connect.fallback = '';
  } catch {
    if (gen !== generation) return;
    connect.phase = 'copy-failed';
    connect.fallback = text;
  }
  paintConnectCard();
}

function renderConnectCard() {
  const detected = detectOs();
  connect = { os: detected || 'windows', detected, phase: 'idle', fallback: '' };
  paintConnectCard();
  const el = $('connect-card');
  el.onclick = onConnectClick;
  el.onchange = onConnectChange;
}

async function loadCompute() {
  renderConnectCard();
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

const loaders = { overview: loadOverview, compute: loadCompute, shared: loadShared, sharing: () => { loadCompute(); loadGrants(); }, keys: loadKeys, usage: loadUsage, settings: loadSettings };

function resetState() {
  // Clear every identity-scoped pixel and form field. Runs on logout and on
  // every sign-in before the new identity renders, so a same-document account
  // switch never shows the previous identity's data (incl. revealed secrets).
  statusPollToken++;
  for (const id of ['status-strip', 'ov-cards', 'ov-note', 'compute-list', 'shared-list', 'grant-list', 'key-list', 'usage-totals', 'usage-list', 'audit-list']) $(id).innerHTML = '';
  $('grant-resource').innerHTML = '';
  $('key-secret').textContent = ''; $('key-reveal').hidden = true;
  $('whoami').textContent = '';
  $('settings-email').textContent = ''; $('settings-via').textContent = '…';
  for (const id of ['res-name', 'res-origin', 'res-cpu', 'res-gpu', 'res-caps', 'grant-user', 'key-name', 'key-expires', 'settings-name', 'demo-username', 'demo-password']) $(id).value = '';
  $('grant-jobs').value = '50'; $('grant-tokens').value = '50000'; $('key-scope').value = 'read';
  for (const id of ['login-error', 'demo-error', 'resource-error', 'grant-error', 'key-error', 'settings-error']) { const e = $(id); e.textContent = ''; e.hidden = true; }
  $('banner').textContent = ''; $('banner').hidden = true;
  $('demo-banner').hidden = true; $('demo-grants-note').hidden = true; $('demo-keys-note').hidden = true;
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
    const data = await api('/api/auth/sign-in/social', { method: 'POST', body: JSON.stringify({ provider: 'github', callbackURL: location.origin + '/app/', errorCallbackURL: location.origin + '/app/' }) });
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
  connect = null;
  $('connect-card').innerHTML = ''; $('connect-card').hidden = true;
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
  loadOverview();
}

function callbackErrorMessage(code) {
  const c = String(code || '').toLowerCase();
  if (c === 'not_verified' || c === 'email_not_found' || c === 'email_not_verified') {
    return 'GitHub sign-in needs a verified email on your GitHub account. Verify an email there, then try again.';
  }
  if (c === 'account_not_linked') {
    return 'This GitHub email is already registered with a different sign-in method. Sign in with that method instead; accounts are never merged automatically.';
  }
  if (c === 'access_denied') return 'GitHub sign-in was cancelled.'
  return 'GitHub sign-in failed. Please try again.'
}

(async () => {
  try {
    try {
      const params = new URLSearchParams(location.search || '');
      const cbError = params.get('error');
      if (cbError) {
        const err = $('login-error'); err.textContent = callbackErrorMessage(cbError); err.hidden = false;
        history.replaceState(null, '', location.pathname);
      }
    } catch { /* error display must never break session restore */ }
    const data = await api('/api/auth/get-session');
    if (data && data.user) { me = data.user; showApp(); }
  } catch { /* stay on login */ }
})();

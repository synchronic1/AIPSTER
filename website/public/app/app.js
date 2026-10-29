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

// Paged inventory fetch: walks /api/inventory?limit=50&offset=… until the
// reported total is reached (at most 2 requests under the 100-resource cap),
// so selectors offer every owned resource instead of the newest 50. Each
// page goes through the fenced api(), and the generation is re-checked
// between pages so a tab switch mid-pagination drops the stale walk.
async function allInventory() {
  const gen = generation;
  const items = [];
  let offset = 0;
  let total = Infinity;
  for (let pages = 0; pages < 10 && items.length < total; pages++) {
    const page = await api(`/api/inventory?limit=50&offset=${offset}`);
    if (gen !== generation) throw staleError();
    if (!page || !Array.isArray(page.items) || !page.items.length) break;
    items.push(...page.items);
    total = Number.isSafeInteger(page.total) && page.total >= 0 ? page.total : items.length;
    offset += page.items.length;
  }
  return items;
}

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
  const items = list.map((r) => {
    const seen = r.lastSeenAt !== null && r.lastSeenAt !== undefined;
    const age = r.lastSeenAgeMs === null || r.lastSeenAgeMs === undefined ? 'never' : formatAge(r.lastSeenAgeMs);
    // Only heartbeat-seen rows replace the telemetry-unavailable copy with
    // reachability-only copy. usable=false gets a distinct not-ready
    // attention note and never renders as runnable/ready.
    const hb = !seen ? '' : r.usable === false
      ? ' · ATTENTION: reachable but NOT usable for inference'
      : ' · heartbeat seen (reachability only — not ready to run)';
    return `<p class="muted">${esc(r.name)} · ${esc(r.kind)} · ${esc(r.liveness)} · last seen ${esc(age)}${hb}${r.demoFixture ? ' · DEMO' : ''}</p>`;
  }).join('');
  const anySeen = list.some((r) => r.lastSeenAt !== null && r.lastSeenAt !== undefined);
  const note = data.demo
    ? 'DEMO DATA: simulated fixture, not a live node.'
    : anySeen
      ? 'Heartbeat telemetry seen for some resources — reachability only, never inference acceptance. Resources never seen have no telemetry; nothing here means ready to run.'
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
  // Pairing/link state from row fields only. The browser cannot observe an
  // install, so there is no "installed" state here — only what the server
  // row proves: needs-link (manual, never paired), linked (paired, never
  // beaten), reachable (fresh heartbeat, still not inference-ready), stale.
  const link = !s.authenticated ? 'needs-link — pair this worker to link it'
    : !r.heartbeatAt ? 'linked — awaiting first heartbeat'
    : s.online ? 'reachable — heartbeat seen (reachability only, never ready to run)'
    : 'stale — last beat ' + (r.heartbeatAt || 'unknown') + '; start the worker sender or check its key';
  return `<div class="card"><h2>${esc(r.name)}</h2>
    <p class="muted">${esc(r.id)} · ${esc(r.kind)} · origin: ${esc(r.origin)} · owner: ${esc(r.owner && r.owner.name)}</p>
    <p>${esc(r.compute.cpu)} · ${esc(r.compute.gpu)}</p>
    <p>${pill(s.configured, 'configured')}${pill(s.authenticated, 'authenticated')}${pill(s.online, 'online')}${pill(s.usable, 'usable')}</p>
    <p class="muted">status: ${esc(s.status)} · heartbeat: ${esc(r.heartbeatAt || 'unknown')} · scope: ${esc(r.scope)}</p>
    <p class="muted">capabilities: ${esc((r.capabilities || []).join(', ') || 'none recorded')}</p>
    ${r.credits ? `<p>credits: ${esc(r.credits.label)} ${esc(r.credits.amount)} ${esc(r.credits.currency || '')} <span class="muted">(informational only)</span></p>` : '<p class="muted">credits: unknown / none recorded</p>'}
    <p class="muted">verification: ${esc(r.verification && r.verification.note || 'unknown')}</p>
    <p class="muted">link: ${esc(link)}</p></div>`;
}

async function loadOverview() {
  const el = $('ov-cards'); loading(el);
  const token = ++statusPollToken;
  const gen = generation;
  $('status-strip').innerHTML = '<h2>Resource status</h2><p class="muted">Checking resource status…</p>';
  refreshStatusStrip(token, gen, 0);
  try {
    const [inv, shared, usage] = await Promise.all([api('/api/inventory?limit=50'), api('/api/shared-with-me?limit=50'), api('/api/usage?limit=1')]);
    // Reachability is fresh liveness, not terminal usability (Codex P2
    // round 12): a mock worker beating usable:false is online but
    // unusable, and the status strip counts it — so must this count.
    const reachable = inv.items.filter((r) => r.state.online).length;
    el.innerHTML = `<div class="card"><h2>My resources</h2><p>${inv.total} total · ${reachable} reachable</p></div>
      <div class="card"><h2>Shared with me</h2><p>${shared.total} active grant(s)</p></div>
      <div class="card"><h2>Usage</h2><p>${usage.totals.requests} requests · ${usage.totals.tokensIn + usage.totals.tokensOut} tokens</p></div>`;
    $('ov-note').innerHTML = me && me.demo
      ? '<p class="muted">DEMO DATA: simulated fixtures for exploration. Grants and live actions are disabled. Inference dispatch is disabled.</p>'
      : '<p class="muted">No demo data: only resources you register or pair appear here. Inference dispatch is disabled.</p>';
  } catch (e) { if (isStale(e)) return; state(el, 'error', e.message); }
}

// "Connect your computer" onboarding. Installer-first and OS-aware: a primary
// installer action (disabled with an explanation until a verified installer
// exists), a secondary agent-assisted setup that copies pinned, secret-free
// instructions on qualified platforms only, and an OS picker that corrects
// detection. Linked
// documentation is pinned separately from the worker source, which remains
// pinned to the reviewed #17 head (merged; worker requires a local token and
// validates Host/Origin); move either pin only with a re-verified re-pin.
// The card renders with no API call and holds no credential; the only call
// it ever makes is minting a one-time pairing code when the user clicks Pair,
// and the code is cleared on Done, tab switch, or sign-out. No verified
// installer is packaged for any platform yet, so progress honestly stops at
// "Setup needed" until the worker is installed and paired elsewhere.
const WORKER_COMMIT = '3092039327a6fbef0c03a901605385339c34de96';
const DOCS_COMMIT = 'bf0d485495c6a0a5a7ea72fc2b4e1a0b4c62d933';
const DOCS_TREE = 'https://github.com/synchronic1/AIPSTER/blob/' + DOCS_COMMIT + '/local-worker/';
const WORKER_LINKS = {
  quickstart: DOCS_TREE + 'README.md',
  tested: DOCS_TREE + 'README.md#tested-installation',
  engine: DOCS_TREE + 'README.md#optional-real-engine-preparation-not-needed-for-the-mock-check',
  troubleshoot: DOCS_TREE + 'README.md#stop-uninstall-and-troubleshoot',
  evidence: DOCS_TREE + 'VERIFICATION.md',
  gaps: DOCS_TREE + 'EXECUTION-GAPS.md',
  securityFix: 'https://github.com/synchronic1/AIPSTER/pull/17',
  heartbeat: 'https://github.com/synchronic1/AIPSTER/pull/20'
};
const COPIED_MESSAGE = 'Instructions copied. Paste them into ChatGPT, Claude, or your preferred local agent.';

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
  windows: { label: 'Windows x64', shell: 'PowerShell', venvBin: '.\\.venv\\Scripts', posix: false, agentQualified: true },
  macos: { label: 'macOS', shell: 'Terminal', venvBin: '.venv/bin', posix: true, agentQualified: false },
  linux: { label: 'Linux', shell: 'a shell', venvBin: '.venv/bin', posix: true, agentQualified: false }
};

// Best-effort platform suggestion; the picker always lets the user correct
// it. Architecture is never inferred: every Windows result is reported as
// plain "Windows", never "Windows x64". Phones and tablets report 'mobile'
// so the card can direct the user to the computer they want to connect
// instead of offering a desktop install as though it runs on the phone.
function detectOs() {
  try {
    if (typeof navigator === 'undefined') return null;
    const uaData = navigator.userAgentData || null;
    if (uaData && uaData.mobile === true) return 'mobile';
    const plat = (uaData && uaData.platform) || navigator.platform || '';
    const ua = typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
    const s = (String(plat) + ' ' + ua).toLowerCase();
    if (s.includes('android') || s.includes('iphone') || s.includes('ipad') || s.includes('mobile')) return 'mobile';
    if (s.includes('win')) return 'windows';
    if (s.includes('mac')) {
      const touch = Number(navigator.maxTouchPoints || 0);
      if (touch > 1) return 'mobile';
      return 'macos';
    }
    if (s.includes('linux')) return 'linux';
  } catch { /* detection unavailable */ }
  return null;
}
const OS_FAMILY = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
const MOBILE_NOTE = 'You seem to be on a phone or tablet. Open AIPSTER on the computer you want to connect — the steps below install on the computer in front of you.';

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
    'git sparse-checkout set --no-cone /local-worker/ /LICENSE',
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
  // Installed interpreter, not bare `python` (Codex P2 round 4): setup
  // never activates the venv, so bare commands fail or miss Dendrite.
  const pyExe = meta.venvBin + (meta.posix ? '/python' : '\\python.exe');
  const lines = workerCommands(os);
  const fetch = lines.slice(0, 6).map((l) => '  ' + l).join('\n');
  const tested = os === 'windows'
    ? 'Windows x64 is the only tested platform (mock check only).'
    : 'Only Windows x64 is tested; macOS and Linux steps are untested adaptation, so verify each step before continuing.';
  return ['AIPSTER agent setup packet v1.',
    'Set up the AIPSTER local worker on THIS computer (assisted install).',
    '',
    'READ FIRST - what this does and does NOT do:',
    '- Install the local Dendrite worker (ganglion-dendrite 0.1.0) from the reviewed',
    '  AIPSTER source revision below, in an isolated folder on this machine.',
    '- Installing does NOT share this computer and does NOT enable inference. The',
    '  worker does not contact AIPSTER until I pair it (my step below): until then',
    '  it holds no AIPSTER credential. AIPSTER dispatch stays disabled.',
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
    '- Confirm CPU architecture: these steps cover x64 only. On ARM64 or any other',
    '  architecture, stop and explain that no qualified instructions exist; do not',
    '  adapt them silently.',
    '- ' + tested,
    '',
    'Step 2 - fetch worker files only (in ' + meta.shell + '):',
    fetch,
    '- The checkout contains the worker and the root LICENSE only; the license is',
    '  required by local-worker/LICENSING.md. Do not fetch the rest of the repository.',
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
    'Step 6 - link this computer in AIPSTER (I do this myself, not you):',
    '- In AIPSTER My Compute I use Pair this computer, then type the one-time',
    '  code into `' + pyExe + ' pairing.py pair` on this machine. That registers the',
    '  worker automatically; then I start `' + pyExe + ' pairing.py heartbeat-loop` so',
    '  reachability is reported. Manual Register resource under Advanced stays a fallback.',
    '',
    'Finish by reporting: installed revision, inspect and test results, how to stop',
    '(Ctrl+C, then discard the token) and uninstall (delete local-worker/.venv and',
    'local-worker/.state if present). There is no automatic update: reinstall from',
    'scratch at a newer pin only if AIPSTER publishes one. After pairing, the',
    '  worker sends reachability heartbeats on its own; a heartbeat never means',
    '  inference-ready, and dispatch stays disabled.'
  ].join('\n');
}

let connect = null;

// Approved installer origins (dormant: no installer is available yet). A
// future available entry renders a download only when its URL is an AIPSTER
// release download and its checksum is a full SHA-256 hex digest.
const INSTALLER_URL_OK = /^https:\/\/github\.com\/synchronic1\/AIPSTER\/releases\/download\//;
const installerUsable = (inst) => !!(inst && inst.available
  && INSTALLER_URL_OK.test(inst.url || '') && /^[0-9a-f]{64}$/.test(inst.sha256 || ''));

function paintConnectCard() {
  const el = $('connect-card');
  if (!connect) { el.innerHTML = ''; el.hidden = true; return; }
  // Preserve in-progress reading across repaints: an open Advanced section
  // stays open, and focus returns to the control the user just used instead
  // of being dropped. querySelector is real-DOM only; the static test harness
  // has no live tree, so every access is guarded.
  const live = el.querySelector ? el.querySelector('details') : null;
  const advOpen = !!(live && live.open);
  const active = (typeof document !== 'undefined' && document.activeElement) || null;
  const focusAction = active && active.dataset ? active.dataset.action || null : null;
  const L = WORKER_LINKS;
  const meta = OS_META[connect.os];
  const unpickedMobile = connect.detected === 'mobile' && !connect.picked;
  const options = (unpickedMobile ? '<option value="" selected>Choose a computer…</option>' : '') + ['windows', 'macos', 'linux'].map((k) =>
    `<option value="${k}"${k === connect.os && !unpickedMobile ? ' selected' : ''}>${esc(OS_META[k].label)}</option>`).join('');
  const detectedNote = connect.detected === 'mobile'
    ? MOBILE_NOTE + (connect.picked ? ` You picked ${esc(meta.label)} as the target computer.` : '')
    : connect.detected
      ? `Detected: ${esc(OS_FAMILY[connect.detected])}. Change it if that is wrong.`
      : 'Detection unavailable in this browser — pick your system and the steps below follow it.';
  const inst = INSTALLERS[connect.os];
  const usable = installerUsable(inst);
  const primary = unpickedMobile
    ? '<button type="button" class="btn" disabled>Pick a target computer above</button>'
    : usable
      ? `<a class="btn" href="${esc(inst.url)}">Download installer</a>`
      : `<button type="button" class="btn" disabled>Installer coming soon for ${esc(meta.label)}</button>`;
  const secondary = unpickedMobile ? ''
    : meta.agentQualified
      ? '<button type="button" class="btn secondary" data-action="copy-agent">Set up with my agent</button>'
      : '<button type="button" class="btn secondary" data-action="platforms">View supported platforms</button>';
  // Installed interpreter for pair/sender commands (Codex P2 round 4).
  const pyExe = meta.venvBin + (meta.posix ? '/python' : '\\python.exe');
  // Pairing is platform-independent (a browser code mint), so it stays
  // available even before an OS pick. Demo accounts cannot mint: the server
  // would 403, so the card says so up front instead of failing on click.
  const pairBtn = (me && me.demo)
    ? '<button type="button" class="btn secondary" disabled>Pairing unavailable for demo</button>'
    : '<button type="button" class="btn secondary" data-action="pair">Pair this computer</button>';
  const pairBlock = (() => {
    const p = connect.pair;
    if (!p || p.phase === 'idle') return '';
    if (p.phase === 'minting') return '<p class="notice" role="status">Minting a one-time code…</p>';
    if (p.phase === 'error') return `<p class="notice" role="status"><span class="pill warn">Pairing failed</span> ${esc(p.error)} <span class="actions"><button type="button" class="btn secondary" data-action="pair-again">Try again</button></span></p>`;
    return `<div class="reveal" role="status"><p><span class="pill ok">Code minted</span> Type this code into the worker's pair step. Single use — it cannot be shown again.</p>
<code class="pair-code" aria-label="one-time pairing code" tabindex="0">${esc(p.code)}</code>
<p class="muted">Expires ${esc(p.expiresAt)}. On the worker: run the pair step, type the code when asked, then start the heartbeat sender (see Advanced). The worker contacts AIPSTER only after pairing; heartbeats prove reachability only.</p>
<p class="actions"><button type="button" class="btn secondary" data-action="pair-done">Done</button><button type="button" class="btn secondary" data-action="pair-again">Mint a new code</button></p></div>`;
  })();
  const installerLine = unpickedMobile
    ? '<p class="muted">Pick a target computer to check installer availability.</p>'
    : usable
      ? `<p class="muted">Installer for ${esc(meta.label)} ${esc(inst.version)}: verify the SHA-256 checksum <code>${esc(inst.sha256)}</code> before running it.</p>`
      : `<p class="muted">Installer for ${esc(meta.label)}: <strong>not available</strong> — ${esc(inst.reason)}, so there is nothing to download. The worker is published as source only.</p>`;
  let status = '';
  if (connect.phase === 'platforms') {
    status = `<p class="notice" role="status"><strong>Supported platforms:</strong> Windows x64 — tested (mock check only). macOS and Linux are not qualified, so agent setup is offered for Windows only. See Advanced for the pinned manual steps.</p>`;
  } else if (connect.phase === 'copied') {
    status = `<p class="notice" role="status"><span class="pill ok">Copied</span> ${esc(COPIED_MESSAGE)} The agent needs authorized access to this computer — a browser-only chat cannot install software by itself.</p>`;
  } else if (connect.phase === 'copy-failed') {
    const saveNote = connect.saveFailed ? ' The file download failed in this browser, so use the selectable text.' : '';
    status = `<p class="notice" role="status"><span class="pill warn">Copy unavailable</span> This browser would not let the page copy automatically. Select the instructions below and copy them yourself, download them as a file, or press "Set up with my agent" to try again.${esc(saveNote)}</p><p class="actions"><button type="button" class="btn secondary" data-action="save-instructions">Download instructions</button></p><label>Setup instructions (select and copy)<textarea class="copy-fallback" readonly rows="18">${esc(connect.fallback)}</textarea></label>`;
  }
  const commands = workerCommands(connect.os).map(esc).join('\n');
  const advanced = `<details><summary>Advanced: manual install, source and troubleshooting</summary>
<h3>Manual install (${esc(meta.label)})</h3>
<p>Prerequisites: Git, <code>uv 0.12.12</code> and Python 3.12.14 (<code>uv python install 3.12.14</code>). In ${esc(meta.shell)}, following the <a href="${esc(L.tested)}">tested installation</a> (the sparse checkout contains the worker and its root <code>LICENSE</code> only):</p>
<pre tabindex="0" aria-label="${esc(meta.label)} install commands"><code>${commands}</code></pre>
<p class="muted"><code>serve</code> refuses to start without <code>DENDRITE_API_TOKEN</code> (32+ characters), even on loopback. This is a <strong>worker-local</strong> token that you generate on this machine. It is not an AIPSTER API key or heartbeat key. Never reuse it, and never paste it into AIPSTER, a URL or a shared config. Local requests other than <code>/healthz</code> need <code>Authorization: Bearer</code> with that token (see the <a href="${esc(L.quickstart)}">quickstart</a>).</p>
<p class="muted">The mock config returns simulated output only. A native engine (llama-server, built separately) and a GGUF model you obtain yourself are separate prerequisites. See <a href="${esc(L.engine)}">engine preparation</a>.</p>
<h3>Platforms and source</h3>
<ul class="platforms"><li><span class="pill ok">Windows x64: tested</span> <span class="muted">mock check only, from a git clone with CPython 3.12.14 and uv 0.12.12 (<a href="${esc(L.evidence)}">evidence</a>). No real engine or model was tested.</span></li>
<li><span class="pill warn">macOS / Linux: not qualified</span> <span class="muted">commands are for adaptation only (use <code>.venv/bin/</code>). They are untested.</span></li></ul>
<p class="muted">The worker is published as source, pinned to the <a href="${esc(L.securityFix)}">security-fixed revision</a> that requires a local token and checks Host/Origin.</p>
<h3>Connect</h3>
<p>Mint a one-time pairing code above (10-minute expiry, single use), then on this computer run the worker's pair step (<code>${pyExe} pairing.py pair</code> for source installs) and type the code when asked. Pairing registers this computer automatically — hardware and capabilities are discovered, not typed — and delivers a sender key the worker stores privately. The worker contacts AIPSTER only after pairing.</p>
<p>Status: <strong>not linked until paired</strong>. Paired workers appear below on their own; heartbeats prove reachability only, never readiness. Prefer pairing over typing: manual entry stays available under <strong>Advanced: manual resource registration</strong> below. See the <a href="${esc(L.heartbeat)}">heartbeat intake</a> and the <a href="${esc(L.gaps)}">execution gaps</a>.</p>
<p>Source installs only: pairing saves the credential and exits — the worker does not start its own sender. In a second terminal, next to <code>serve</code>, run:</p>
<pre tabindex="0" aria-label="start the heartbeat sender"><code>${pyExe} pairing.py heartbeat-loop</code></pre>
<p class="muted">Leave it running. If its key is revoked or expires it exits asking for a re-pair; pair again with a fresh code. Packaged launcher integration is pending with the installer release.</p>
<details><summary>Troubleshooting</summary><ul><li>Existing <code>.venv</code>: use a fresh clone, or stop the worker and remove that local venv.</li><li>uv version mismatch: install uv 0.12.12. Do not update the lock files.</li><li>Hash mismatch: restore the exact public commit and run <code>verify_vendor.py</code>.</li><li><code>serve</code> exits asking for <code>DENDRITE_API_TOKEN</code>: generate a fresh value of 32+ characters as shown above.</li><li>401 from <code>/v1/...</code>: send <code>Authorization: Bearer</code> with the exact token the worker started with.</li><li>400 Host or 403 Origin not allowed: call the worker by its loopback address and port, not another hostname.</li><li>Port 8090 in use: stop the old instance or pick a free loopback port in the config.</li><li>TLS or package index failure: check access to public PyPI.</li></ul><p><a href="${esc(L.troubleshoot)}">Full troubleshooting table</a></p></details>
<details><summary>Disconnect and uninstall</summary><p>Stop the worker with Ctrl+C, then close the terminal or run <code>Remove-Item Env:DENDRITE_API_TOKEN</code> to discard the local token. To uninstall, delete only <code>local-worker/.venv</code> (and <code>.state</code> if present). There is no automatic update; reinstall from scratch at a newer pin only if AIPSTER publishes one. This setup adds no service, startup task or global package. The worker holds no AIPSTER credential, so there is nothing to revoke here. Keep it on loopback and never expose it to a network.</p></details>
</details>`;
  el.innerHTML = `<div class="connect-grid"><div class="connect-rail">
<h2>Connect your computer</h2>
<svg class="connect-illus" viewBox="0 0 220 150" width="220" height="150" role="img" aria-label="A computer connecting to a three-node inference fabric"><g fill="none" stroke-linecap="round"><rect x="14" y="48" width="76" height="54" rx="6" fill="#0b0e12" stroke="#F2B887" stroke-width="4"/><line x1="38" y1="102" x2="38" y2="114" stroke="#F2B887" stroke-width="4"/><line x1="66" y1="102" x2="66" y2="114" stroke="#F2B887" stroke-width="4"/><line x1="28" y1="114" x2="76" y2="114" stroke="#F2B887" stroke-width="4"/><line x1="90" y1="62" x2="140" y2="48" stroke="#7c9787" stroke-width="4" stroke-dasharray="2 8"/><line x1="90" y1="88" x2="140" y2="102" stroke="#7c9787" stroke-width="4" stroke-dasharray="2 8"/><circle cx="162" cy="42" r="20" fill="#0b0e12" stroke="#98c379" stroke-width="4"/><circle cx="162" cy="108" r="20" fill="#0b0e12" stroke="#98c379" stroke-width="4"/><circle cx="198" cy="75" r="14" fill="#0b0e12" stroke="#98c379" stroke-width="4"/><line x1="162" y1="62" x2="162" y2="88" stroke="#98c379" stroke-width="3"/></g></svg>
<p class="benefit">Prepare the computer you are using now for future sharing. Installing the worker never shares anything or enables inference by itself.</p>
<ol class="progress" aria-label="Connection progress">
<li class="now" aria-current="step"><strong>Setup needed</strong><span class="st muted">You are here. Not connected.</span></li>
<li><strong>Installing</strong><span class="st muted">Blocked: no verified installer is packaged yet.</span></li>
<li><strong>Pairing</strong><span class="st muted">Available: mint a one-time code below, then type it into the worker's pair step. Heartbeats start after pairing.</span></li>
<li><strong>Connected</strong><span class="st muted">Needs verified worker evidence. A download or a running worker is not proof.</span></li>
</ol>
<p><span class="pill warn">Setup needed</span></p>
</div><div class="connect-body">
<p class="lede">Prepare this computer in two steps: install the local worker (<code>ganglion-dendrite 0.1.0</code>, reviewed AIPSTER commit <code>${WORKER_COMMIT.slice(0, 7)}</code>), then pair it below with a one-time code. AIPSTER dispatch stays disabled, and nothing is shared unless you create a grant; dispatch is not available, so nothing can run.</p>
<div class="osrow"><label for="connect-os">Your system</label><select id="connect-os" data-action="os" aria-describedby="connect-os-note">${options}</select><span class="muted" id="connect-os-note">${detectedNote}</span></div>
<p class="actions">${primary}${secondary}${pairBtn}</p>
${installerLine}
${status}
${pairBlock}
${advanced}
</div></div>`;
  el.hidden = false;
  if (el.querySelector) {
    if (advOpen) {
      const adv = el.querySelector('details');
      if (adv) adv.open = true;
    }
    if (connect.phase === 'copy-failed') {
      const ta = el.querySelector('textarea.copy-fallback');
      if (ta) ta.focus();
    } else if (focusAction) {
      const back = el.querySelector(`[data-action="${focusAction}"]`);
      if (back) back.focus();
    }
  }
}

function onConnectClick(ev) {
  if (!connect) return;
  const t = ev && ev.target;
  const near = t && typeof t.closest === 'function' ? t.closest('[data-action]') : null;
  const action = (near && near.dataset && near.dataset.action) || (t && t.dataset && t.dataset.action);
  if (action === 'platforms') {
    connect.phase = 'platforms';
    connect.copyOp = (connect.copyOp || 0) + 1;
    paintConnectCard();
  } else if (action === 'copy-agent') {
    copyAgentInstructions();
  } else if (action === 'save-instructions') {
    saveInstructions();
  } else if (action === 'pair' || action === 'pair-again') {
    mintPairingCode();
  } else if (action === 'pair-done') {
    // Refresh, don't just repaint (Codex P2 round 3): the worker may have
    // claimed while My Compute sat open, and the pre-pairing inventory
    // would otherwise keep saying "No resources yet". If nothing claimed
    // yet the list truthfully stays empty.
    loadCompute();
  }
}

function saveInstructions() {
  if (!connect || !connect.fallback) return;
  if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  if (typeof document === 'undefined' || !document.createElement || !document.body) return;
  let url = null;
  try {
    url = URL.createObjectURL(new Blob([connect.fallback], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'aipster-worker-setup.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (typeof setTimeout === 'function') setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* already gone */ } }, 4000);
  } catch {
    if (url) { try { URL.revokeObjectURL(url); } catch { /* already gone */ } }
    connect.saveFailed = true;
    paintConnectCard();
  }
}

function onConnectChange(ev) {
  if (!connect) return;
  const t = ev && ev.target;
  if (t && t.dataset && t.dataset.action === 'os' && OS_META[t.value]) {
    connect.os = t.value;
    connect.picked = true;
    connect.phase = 'idle';
    connect.fallback = '';
    connect.pair = { phase: 'idle', code: '', expiresAt: '', error: '', op: (connect.pair && connect.pair.op) || 0 };
    connect.saveFailed = false;
    connect.copyOp = (connect.copyOp || 0) + 1;
    paintConnectCard();
  }
}

async function copyAgentInstructions() {
  if (!connect) return;
  const gen = generation;
  // Operation identity: a slow clipboard write must not report success for a
  // card the user has since re-rendered, switched OS on, or re-clicked.
  const card = connect;
  const os = card.os;
  if (!OS_META[os].agentQualified) return;
  if (card.detected === 'mobile' && !card.picked) return;
  const op = (card.copyOp = (card.copyOp || 0) + 1);
  const text = card.detected === 'mobile'
    ? `Target computer: ${OS_META[os].label} (these steps run on that computer, not on this phone or tablet).\n` + agentInstructions(os)
    : agentInstructions(os);
  let clipboard = null;
  try {
    clipboard = (typeof navigator !== 'undefined' && navigator.clipboard) || null;
  } catch { clipboard = null; }
  try {
    if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
    await clipboard.writeText(text);
    if (gen !== generation || connect !== card || card.copyOp !== op || card.os !== os) return;
    card.phase = 'copied';
    card.fallback = '';
  } catch {
    if (gen !== generation || connect !== card || card.copyOp !== op || card.os !== os) return;
    card.phase = 'copy-failed';
    card.fallback = text;
    card.saveFailed = false;
  }
  paintConnectCard();
}

async function mintPairingCode() {
  if (!connect || (me && me.demo)) return;
  const gen = generation;
  const card = connect;
  const op = (card.pair.op = (card.pair.op || 0) + 1);
  card.pair.phase = 'minting';
  card.pair.error = '';
  paintConnectCard();
  try {
    const data = await api('/api/pairing/codes', { method: 'POST', body: JSON.stringify({ ttlMinutes: 10 }) });
    if (gen !== generation || connect !== card || card.pair.op !== op) return;
    card.pair.phase = 'shown';
    card.pair.code = data.code;
    card.pair.expiresAt = data.expiresAt;
  } catch (e) {
    if (isStale(e) || gen !== generation || connect !== card || card.pair.op !== op) return;
    card.pair.phase = 'error';
    card.pair.error = e.message;
  }
  paintConnectCard();
}

function renderConnectCard() {
  const detected = detectOs();
  const os = detected && detected !== 'mobile' ? detected : 'windows';
  connect = { os, detected, picked: false, phase: 'idle', fallback: '', saveFailed: false, copyOp: 0, pair: { phase: 'idle', code: '', expiresAt: '', error: '', op: 0 } };
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
    if (!inv.items.length) state(el, '', 'No resources yet. Pair a worker above, or register one manually under Advanced.');
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
    const [data, inv] = await Promise.all([api('/api/keys?limit=50'), allInventory()]);
    $('key-resource').innerHTML = inv.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
    el.innerHTML = data.items.filter((k) => !k.revokedAt).map((k) =>
      `<div class="card"><h2>${esc(k.name)}</h2><p class="muted">${esc(k.prefix)}… · scope: ${esc(k.scope)}${k.scope === 'heartbeat' && k.resourceId ? ` · resource: ${esc(k.resourceId)}` : ''}</p>
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
  connect = null;
  $('connect-card').innerHTML = ''; $('connect-card').hidden = true;
  $('grant-resource').innerHTML = '';
  $('key-secret').textContent = ''; $('key-reveal').hidden = true;
  $('key-curl').textContent = ''; $('key-curl-wrap').hidden = true;
  $('key-resource').innerHTML = ''; $('key-resource-wrap').hidden = true;
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

$('key-scope').addEventListener('change', () => {
  $('key-resource-wrap').hidden = $('key-scope').value !== 'heartbeat';
});

$('key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('key-error'); err.hidden = true;
  try {
    const body = { name: $('key-name').value, scope: $('key-scope').value };
    if ($('key-expires').value) body.expiresAt = new Date($('key-expires').value + 'T00:00:00Z').toISOString();
    if (body.scope === 'heartbeat') {
      if (!$('key-resource').value) throw new Error('Choose the resource this heartbeat key is bound to.');
      body.resourceId = $('key-resource').value;
    }
    const k = await api('/api/keys', { method: 'POST', body: JSON.stringify(body) });
    $('key-secret').textContent = k.secret;
    // Heartbeat keys reveal a copyable curl example bound to the same
    // resource; the secret itself is still shown once and never persisted.
    if (k.scope === 'heartbeat' && k.resourceId) {
      $('key-curl').textContent = `curl -X POST ${location.origin}/api/resources/${k.resourceId}/heartbeat -H "Authorization: Bearer ${k.secret}" -H "Content-Type: application/json" -d '{"usable":true}'`;
      $('key-curl-wrap').hidden = false;
    } else {
      $('key-curl').textContent = ''; $('key-curl-wrap').hidden = true;
    }
    $('key-reveal').hidden = false;
    $('key-name').value = ''; $('key-expires').value = '';
    loadKeys();
  } catch (ex) { if (isStale(ex)) return; err.textContent = ex.message; err.hidden = false; }
});
$('key-dismiss').addEventListener('click', () => { $('key-secret').textContent = ''; $('key-curl').textContent = ''; $('key-curl-wrap').hidden = true; $('key-reveal').hidden = true; });
$('key-curl-copy').addEventListener('click', async () => {
  try {
    const text = $('key-curl').textContent || '';
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      banner('Curl example copied.');
    } else {
      banner('Select the curl example above to copy it.');
    }
  } catch (e) { if (isStale(e)) return; banner('Copy failed: ' + e.message); }
});

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

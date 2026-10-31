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
    // Only heartbeat-seen rows replace the heartbeat-unavailable copy with
    // reachability-only copy. usable=false gets a distinct not-ready
    // attention note and never renders as runnable/ready.
    // Present-tense reachability needs a fresh heartbeat (Muse W4
    // round 13): lastSeenAt survives after a worker goes stale, so the
    // old timestamp-presence check kept ATTENTION: reachable forever.
    const hb = !seen ? '' : r.liveness !== 'online'
      ? ' · not currently reachable'
      : r.usable === false
        ? ' · ATTENTION: reachable but NOT usable for inference'
        : ' · heartbeat seen (reachability only — not ready to run)';
    return `<p class="muted">${esc(r.name)} · ${esc(r.kind)} · ${esc(r.liveness)} · last seen ${esc(age)}${hb}${r.demoFixture ? ' · DEMO' : ''}</p>`;
  }).join('');
  const anySeen = list.some((r) => r.lastSeenAt !== null && r.lastSeenAt !== undefined);
  const note = data.demo
    ? 'DEMO DATA: simulated fixture, not a live node.'
    : anySeen
      ? 'Worker heartbeats seen for some resources — reachability only, never inference acceptance. Resources never seen have no heartbeats; nothing here means ready to run.'
      : 'Declared resources only — no worker heartbeats seen, so nothing here means connected or ready to run. Heartbeats prove reachability only; capability reports (Models tab) are separate snapshots for estimation.';
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
    const [inv, shared, usage, catalog] = await Promise.all([api('/api/inventory?limit=50'), api('/api/shared-with-me?limit=50'), api('/api/usage?limit=1'), api('/api/catalog/summary')]);
    // Reachability is fresh liveness, not terminal usability (Codex P2
    // round 12): a mock worker beating usable:false is online but
    // unusable, and the status strip counts it — so must this count.
    const reachable = inv.items.filter((r) => r.state.online).length;
    el.innerHTML = `<div class="card"><h2>My resources</h2><p>${inv.total} total · ${reachable} reachable</p></div>
      <div class="card"><h2>Shared with me</h2><p>${shared.total} active grant(s)</p></div>
      <div class="card"><h2>Usage</h2><p>${usage.totals.requests} requests · ${usage.totals.tokensIn + usage.totals.tokensOut} tokens</p></div>
      <div class="card"><h2>Models & adapters</h2><p>${catalog.privateAssets} private · ${catalog.activeDeployments} active deployment(s)</p><div class="actions"><button type="button" class="btn secondary" data-goto="models">Browse catalog</button></div></div>`;
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
// documentation and worker source have immutable pins. The reviewed pairing
// client retains the #17 local-token and Host/Origin guards and the API
// edge-compatible sender; move either pin only with a re-verified re-pin.
// The card renders with no API call and initially holds no credential; the call
// it ever makes is minting a one-time pairing code when the user clicks Pair,
// and the code is cleared on Done, tab switch, or sign-out.
// The packaged Windows installer predates the API edge-compat fix, so it
// will not be published; a rebuilt installer is pending qualification and
// there is nothing to download. macOS/Linux are not packaged at all. The
// progress stage derives from the tab's inventory snapshot (setup /
// pairing / reachable); it never claims an unverified state.
const WORKER_COMMIT = '3fa309cb08461ea046ee23e801404911c1f3bcc2';
const DOCS_COMMIT = '3fa309cb08461ea046ee23e801404911c1f3bcc2';
const DOCS_TREE = 'https://github.com/synchronic1/AIPSTER/blob/' + DOCS_COMMIT + '/local-worker/';
const WORKER_LINKS = {
  quickstart: DOCS_TREE + 'README.md',
  tested: DOCS_TREE + 'README.md#tested-installation',
  engine: DOCS_TREE + 'README.md#optional-real-engine-preparation-not-needed-for-the-mock-check',
  troubleshoot: DOCS_TREE + 'README.md#stop-uninstall-and-troubleshoot',
  evidence: DOCS_TREE + 'VERIFICATION.md',
  gaps: DOCS_TREE + 'EXECUTION-GAPS.md',
  pairing: DOCS_TREE + 'PAIRING-INTEGRATION.md',
  securityFix: 'https://github.com/synchronic1/AIPSTER/pull/17',
  heartbeat: 'https://github.com/synchronic1/AIPSTER/pull/20'
};
const COPIED_MESSAGE = 'Instructions copied. Paste them into ChatGPT, Claude, or your preferred local agent.';

// Verified installer availability per platform. A platform is honestly
// unavailable until a packaging PR ships a worker-only artifact (the worker
// plus its install files, licenses and provenance, pinned to a reviewed
// commit with a checksum) and qualifies it. An available entry is
// { available: true, url, sha256, version } and renders a real download with
// its checksum; the repository archive is never offered as an installer.
// A packaged-but-unpublished entry ({ available: false, packaged: true,
// version, sha256, built_from }) shows the built version, checksum, and
// build source with no link: there is nothing to download until the release
// owner publishes the verified file.
const INSTALLERS = {
  windows: { available: false, packaged: true, version: '0.1.0',
    sha256: '81f60828bcc89f038f7a0ded16db76bb06f0c64c42942fa9c52b24cb7f503688',
    built_from: 'cee3390bda28ac70ee75f6e432fd633e4f76a9f0',
    reason: 'packaged 0.1.0 build predates the API edge-compat fix; a rebuilt installer is pending qualification and no release file is published' },
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
    // ChromeOS identifies itself as CrOS while navigator.platform may only
    // report Linux. It is not a supported Linux install target.
    if (s.includes('cros')) return null;
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
const needsTargetSelection = (card) => !card.picked && (!card.detected || card.detected === 'mobile');

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

function workerPairingCommands(os) {
  const meta = OS_META[os] || OS_META.windows;
  const py = meta.posix ? meta.venvBin + '/python' : meta.venvBin + '\\python.exe';
  return [py + ' pairing.py pair', py + ' pairing.py heartbeat-loop --config configs/mock.toml', py + ' pairing.py unpair'];
}

// Complete, version-pinned instructions for the user's own local agent. They
// contain no credential: the owner performs pairing locally and explicitly
// starts the sender. Installation alone never contacts AIPSTER.
function agentInstructions(os) {
  const meta = OS_META[os] || OS_META.windows;
  const lines = workerCommands(os);
  const pairing = workerPairingCommands(os);
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
    '- Commit: ' + WORKER_COMMIT + ' (reviewed: local token required, Host/Origin checked, API edge-compatible sender)',
    '- Worker directory: local-worker/',
    '- Standalone worker background and troubleshooting: ' + WORKER_LINKS.quickstart,
    '- Use the pinned commands below for pairing; do not substitute an older checkout from background documentation.',
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
    '- In a second terminal, open the same local-worker directory. I use Pair this',
    '  computer in AIPSTER My Compute, then run: ' + pairing[0],
    '- I type the one-time code into that local prompt. Never ask me to paste the',
    '  code or stored sender key into this chat. Pairing registers the resource',
    '  and stores its heartbeat credential privately; it does not start a sender.',
    '- In that terminal I explicitly start reachability heartbeats with:',
    '  ' + pairing[1],
    '- Mock reports usable=false. Choose Done or reopen My Compute to load the paired resource;',
    '  a heartbeat proves reachability only, never inference readiness.',
    '- Packaged installs instead: pair from the tray menu (Pair this computer) or with `aipster-worker pair`;',
    '  the tray starts the sender while serving.',
    '',
    'Step 7 - disconnect and uninstall (I choose when to do this):',
    '- Stop both the sender and daemon terminals with Ctrl+C, then discard the',
    '  worker-local token. In AIPSTER Keys I revoke this resource\'s heartbeat key.',
    '- To forget local pairing I run: ' + pairing[2],
    '  Local unpair does not revoke the server key. Keep it private until revoked.',
    '- Remove only local-worker/.venv and .state if present. Do not delete other',
    '  models, engines or files. There is no automatic update; reinstall only',
    '  from another reviewed pin AIPSTER publishes. Dispatch stays disabled.',
    'Finish by reporting installed revision, inspect/test results and stop steps;',
    'never report tokens, pairing codes or private key-file contents.'
  ].join('\n');
}

let connect = null;
function clearPairingCode() {
  if (!connect || !connect.pair) return;
  Object.assign(connect.pair, { phase: 'idle', code: '', expiresAt: '', error: '', op: (connect.pair.op || 0) + 1 });
}

// Approved installer origins (dormant: no installer is available yet). A
// future available entry renders a download only when its URL is an AIPSTER
// release download and its checksum is a full SHA-256 hex digest.
const INSTALLER_URL_OK = /^https:\/\/github\.com\/synchronic1\/AIPSTER\/releases\/download\//;
const installerUsable = (inst) => !!(inst && inst.available
  && INSTALLER_URL_OK.test(inst.url || '') && /^[0-9a-f]{64}$/.test(inst.sha256 || ''));
const installerPackaged = (inst) => !!(inst && !inst.available && inst.packaged
  && /^[0-9a-f]{64}$/.test(inst.sha256 || ''));

// Progress stage from the tab's inventory snapshot (same row fields
// resourceCard reads). The browser cannot observe an install: "setup"
// covers both not-installed and manual-only rows, "awaiting" covers paired
// rows with no fresh heartbeat, and "reachable" needs a fresh heartbeat —
// reachability only, never readiness.
function connectStage() {
  const items = connect && connect.inv && connect.inv.items;
  if (!items || !items.length) return 'setup';
  if (items.some((r) => r.state && r.state.online && r.heartbeatAt)) return 'reachable';
  if (items.some((r) => r.state && r.state.authenticated)) return 'awaiting';
  return 'setup';
}

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
  const osPackaged = installerPackaged(connect.os ? INSTALLERS[connect.os] : null);
  const installingStage = needsTargetSelection(connect)
    ? 'Choose a target to check installer availability.'
    : osPackaged
    ? 'Pending: the packaged installer predates the API edge-compat fix; a rebuilt installer is pending qualification and there is nothing to download yet.'
    : 'Blocked: no verified installer is packaged yet.';
  const meta = OS_META[connect.os];
  const unpickedTarget = needsTargetSelection(connect);
  const targetLabel = connect.detected === 'mobile' ? 'computer' : 'system';
  const options = (unpickedTarget ? `<option value="" selected>Choose a ${targetLabel}…</option>` : '') + ['windows', 'macos', 'linux'].map((k) =>
    `<option value="${k}"${k === connect.os && !unpickedTarget ? ' selected' : ''}>${esc(OS_META[k].label)}</option>`).join('');
  const detectedNote = connect.detected === 'mobile'
    ? MOBILE_NOTE + (connect.picked ? ` You picked ${esc(meta.label)} as the target computer.` : '')
    : connect.detected
      ? `Detected: ${esc(OS_FAMILY[connect.detected])}. Change it if that is wrong.`
      : 'Detection unavailable in this browser - pick your system to see target-specific steps.';
  const inst = INSTALLERS[connect.os];
  const usable = installerUsable(inst);
  const packaged = installerPackaged(inst);
  const primary = unpickedTarget
    ? `<button type="button" class="btn" disabled>Pick a target ${targetLabel} above</button>`
    : usable
      ? `<a class="btn" href="${esc(inst.url)}">Download installer</a>`
      : packaged
        ? `<button type="button" class="btn" disabled>Installer rebuild pending for ${esc(meta.label)}</button>`
        : `<button type="button" class="btn" disabled>Installer coming soon for ${esc(meta.label)}</button>`;
  const secondary = unpickedTarget ? ''
    : meta.agentQualified
      ? '<button type="button" class="btn secondary" data-action="copy-agent">Set up with my agent</button>'
      : '<button type="button" class="btn secondary" data-action="platforms">View supported platforms</button>';
  // Pairing is platform-independent (a browser code mint), so it stays
  // available even before an OS pick. Demo accounts cannot mint: the server
  // would 403, so the card says so up front instead of failing on click.
  const pairBtn = (me && me.demo)
    ? '<button type="button" class="btn secondary" disabled>Pairing unavailable for demo</button>'
    : connect.pair && connect.pair.phase === 'minting'
      ? '<button type="button" class="btn secondary" data-action="pair" disabled>Minting…</button>'
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
  const installerLine = unpickedTarget
    ? `<p class="muted">Pick a target ${targetLabel} to check installer availability.</p>`
    : usable
      ? `<p class="muted">Installer for ${esc(meta.label)} ${esc(inst.version)}: verify the SHA-256 checksum <code>${esc(inst.sha256)}</code> before running it.</p>`
      : packaged
        ? `<p class="muted">Installer for ${esc(meta.label)} ${esc(inst.version)} is packaged (built from <code>${esc((inst.built_from || '').slice(0, 7))}</code>), but that build predates the API edge-compat fix, so it will not be published; a rebuilt installer is pending qualification and there is nothing to download. The unpublished build's SHA-256 is <code>${esc(inst.sha256)}</code> for reference.</p>`
        : `<p class="muted">Installer for ${esc(meta.label)}: <strong>not available</strong> — ${esc(inst.reason)}, so there is nothing to download. The worker is published as source only.</p>`;
  let status = '';
  if (connect.phase === 'platforms') {
    status = `<p class="notice" role="status"><strong>Supported platforms:</strong> Windows x64 — tested (mock check only). macOS and Linux are not qualified, so agent setup is offered for Windows only. See Advanced for the pinned manual steps.</p>`;
  } else if (connect.phase === 'copied') {
    status = `<p class="notice" role="status"><span class="pill ok">Copied</span> ${esc(COPIED_MESSAGE)} The agent needs authorized access to this computer — a browser-only chat cannot install software by itself.</p>`;
  } else if (connect.phase === 'copy-failed') {
    const saveNote = connect.saveFailed ? ' The file download failed in this browser, so use the selectable text.' : '';
    status = `<p class="notice" role="status"><span class="pill warn">Copy unavailable</span> This browser would not let the page copy automatically. Select the instructions below and copy them yourself, download them as a file, or press "Set up with my agent" to try again.${esc(saveNote)}</p><p class="actions"><button type="button" class="btn secondary" data-action="save-instructions">Download instructions</button></p><label>Setup instructions (select and copy)<textarea class="copy-fallback" readonly rows="18">${esc(connect.fallback)}</textarea></label>`;
  } else if (connect.phase === 'load-error') {
    status = `<p class="notice" role="status"><span class="pill warn">Refresh failed</span> ${esc(connect.loadError || 'The resource list could not be loaded.')} <span class="actions"><button type="button" class="btn secondary" data-action="retry-load">Try again</button></span></p>`;
  }
  // Progress stage: derived from the tab's inventory snapshot (connect.inv),
  // never from the install the browser cannot observe. Authorizing (a mint
  // in flight or a code on screen) highlights Pairing without claiming a
  // link; reachable needs a fresh heartbeat and still claims only
  // reachability.
  const stage = connectStage();
  const authorizing = !!connect.pair && (connect.pair.phase === 'minting' || connect.pair.phase === 'shown');
  const current = stage === 'reachable' ? 3 : (stage === 'awaiting' || authorizing) ? 2 : 0;
  const pairingStage = connect.pair && connect.pair.phase === 'minting'
    ? 'Authorizing: minting a one-time code…'
    : authorizing
      ? "Authorizing: code minted — type it into the worker's pair step."
      : stage === 'awaiting'
        ? 'Paired, awaiting heartbeat: start the sender, then choose Done to refresh.'
        : stage === 'reachable'
          ? 'Linked: the worker is paired and beating.'
          : "Available: mint a one-time code below, then type it into the worker's pair step. Packaged installs start the sender from the tray; source installs use the manual steps below.";
  const connectedStage = stage === 'reachable'
    ? 'Reachable now: fresh heartbeat on file. Reachability only — dispatch stays disabled and nothing can run.'
    : 'Needs verified worker evidence. A download or a running worker is not proof.';
  const setupStage = current === 0 ? 'You are here. Not connected.' : 'Setup evidence on file.';
  const step = (n, title, text) => n === current
    ? `<li class="now" aria-current="step"><strong>${title}</strong><span class="st muted">${text}</span></li>`
    : `<li><strong>${title}</strong><span class="st muted">${text}</span></li>`;
  const progressItems = step(0, 'Setup needed', setupStage)
    + step(1, 'Installing', installingStage)
    + step(2, 'Pairing', pairingStage)
    + step(3, 'Connected', connectedStage);
  const stagePill = stage === 'reachable'
    ? '<p><span class="pill ok">Reachable</span></p>'
    : (stage === 'awaiting' || authorizing)
      ? '<p><span class="pill warn">Pairing</span></p>'
      : '<p><span class="pill warn">Setup needed</span></p>';
  const commands = unpickedTarget ? '' : workerCommands(connect.os).map(esc).join('\n');
  const pairingCommands = workerPairingCommands(connect.os);
  const advanced = unpickedTarget ? '' : `<details><summary>Advanced: manual install, source and troubleshooting</summary>
<h3>Manual install (${esc(meta.label)})</h3>
<p>Prerequisites: Git, <code>uv 0.12.12</code> and Python 3.12.14 (<code>uv python install 3.12.14</code>). Use these pairing-capable commands in ${esc(meta.shell)}. The linked <a href="${esc(L.tested)}">standalone tested installation</a> is background and may name an earlier release. The sparse checkout contains the worker and its root <code>LICENSE</code> only:</p>
<pre tabindex="0" aria-label="${esc(meta.label)} install commands"><code>${commands}</code></pre>
<p class="muted"><code>serve</code> refuses to start without <code>DENDRITE_API_TOKEN</code> (32+ characters), even on loopback. This is a <strong>worker-local</strong> token that you generate on this machine. It is not an AIPSTER API key or heartbeat key. Never reuse it, and never paste it into AIPSTER, a URL or a shared config. Local requests other than <code>/healthz</code> need <code>Authorization: Bearer</code> with that token (see the <a href="${esc(L.quickstart)}">quickstart</a>).</p>
<p class="muted">The mock config returns simulated output only. A native engine (llama-server, built separately) and a GGUF model you obtain yourself are separate prerequisites. See <a href="${esc(L.engine)}">engine preparation</a>.</p>
<h3>Platforms and source</h3>
<ul class="platforms"><li><span class="pill ok">Windows x64: tested</span> <span class="muted">mock check only, from a git clone with CPython 3.12.14 and uv 0.12.12 (<a href="${esc(L.evidence)}">evidence</a>). No real engine or model was tested.</span></li>
<li><span class="pill warn">macOS / Linux: not qualified</span> <span class="muted">commands are for adaptation only (use <code>.venv/bin/</code>). They are untested.</span></li></ul>
<p class="muted">The worker is published as source, pinned to the <a href="${esc(L.securityFix)}">security-fixed revision</a> that requires a local token and checks Host/Origin.</p>
<h3>Connect</h3>
<p>Mint a one-time pairing code above (10-minute expiry, single use). In a second terminal in the same <code>local-worker</code> directory, run <code>${esc(pairingCommands[0])}</code> and type the code locally. Pairing contacts AIPSTER, registers this computer automatically and stores a private heartbeat key. Do not paste the code or key into an agent chat.</p>
<p>Pairing does not start the sender. In that terminal, run <code>${esc(pairingCommands[1])}</code> to post reachability heartbeats. The mock stays <code>usable=false</code>; no inference is enabled. Keep this sender terminal open. See the <a href="${esc(L.pairing)}">pairing and sender details</a>.</p>
<p>Status: <strong>not linked until paired</strong>. Choose Done or reopen My Compute after pairing to load the resource below. Heartbeats prove reachability only, never readiness. Manual entry stays under <strong>Advanced: manual resource registration</strong>. See the <a href="${esc(L.heartbeat)}">heartbeat intake</a> and the <a href="${esc(L.gaps)}">execution gaps</a>.</p>
<p>Packaged install? Open the AIPSTER Worker tray menu and choose Pair this computer (or run <code>aipster-worker pair</code> in a terminal), then type the code above when asked. The tray starts the sender for you while serving; update by reinstalling from a newer reviewed pin AIPSTER publishes (uninstall preserves pairing).</p>
<p class="muted">If the key is revoked or expires, the sender exits asking for a re-pair with a fresh code.</p>
<details><summary>Troubleshooting</summary><ul><li>Existing <code>.venv</code>: use a fresh clone, or stop the worker and remove that local venv.</li><li>uv version mismatch: install uv 0.12.12. Do not update the lock files.</li><li>Hash mismatch: restore the exact public commit and run <code>verify_vendor.py</code>.</li><li><code>serve</code> exits asking for <code>DENDRITE_API_TOKEN</code>: generate a fresh value of 32+ characters as shown above.</li><li>401 from <code>/v1/...</code>: send <code>Authorization: Bearer</code> with the exact token the worker started with.</li><li>400 Host or 403 Origin not allowed: call the worker by its loopback address and port, not another hostname.</li><li>Port 8090 in use: stop the other worker through its own controls (never kill it), or pick a free loopback port in the config. Pairing needs no local port, so it stays available.</li><li>TLS or package index failure: check access to public PyPI.</li></ul><p><a href="${esc(L.troubleshoot)}">Full troubleshooting table</a></p></details>
<details><summary>Disconnect and uninstall</summary><p>Stop both sender and daemon terminals with Ctrl+C, then discard the worker-local token. A paired worker also holds an AIPSTER heartbeat key: revoke this resource's key in AIPSTER Keys. Run <code>${esc(pairingCommands[2])}</code> to forget its local pairing; this does not revoke the server key. Then remove only <code>local-worker/.venv</code> and <code>.state</code> if present. Keep unrelated models and engines. This setup adds no service, startup task, global package or automatic update. Keep the daemon on loopback.</p></details>
</details>`;
  el.innerHTML = `<div class="connect-grid"><div class="connect-rail">
<h2>Connect your computer</h2>
<svg class="connect-illus" viewBox="0 0 220 150" width="220" height="150" role="img" aria-label="A computer connecting to a three-node inference fabric"><g fill="none" stroke-linecap="round"><rect x="14" y="48" width="76" height="54" rx="6" fill="#0b0e12" stroke="#F2B887" stroke-width="4"/><line x1="38" y1="102" x2="38" y2="114" stroke="#F2B887" stroke-width="4"/><line x1="66" y1="102" x2="66" y2="114" stroke="#F2B887" stroke-width="4"/><line x1="28" y1="114" x2="76" y2="114" stroke="#F2B887" stroke-width="4"/><line x1="90" y1="62" x2="140" y2="48" stroke="#7c9787" stroke-width="4" stroke-dasharray="2 8"/><line x1="90" y1="88" x2="140" y2="102" stroke="#7c9787" stroke-width="4" stroke-dasharray="2 8"/><circle cx="162" cy="42" r="20" fill="#0b0e12" stroke="#98c379" stroke-width="4"/><circle cx="162" cy="108" r="20" fill="#0b0e12" stroke="#98c379" stroke-width="4"/><circle cx="198" cy="75" r="14" fill="#0b0e12" stroke="#98c379" stroke-width="4"/><line x1="162" y1="62" x2="162" y2="88" stroke="#98c379" stroke-width="3"/></g></svg>
<p class="benefit">Prepare the computer you are using now for future sharing. Installing the worker never shares anything or enables inference by itself.</p>
<ol class="progress" aria-label="Connection progress">
${progressItems}
</ol>
${stagePill}
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
  } else if (action === 'pair') {
    mintPairingCode(false);
  } else if (action === 'pair-again') {
    mintPairingCode(true);
  } else if (action === 'retry-load') {
    loadCompute();
  } else if (action === 'pair-done') {
    clearPairingCode();
    // Preserve the current peer's Done refresh, with explicit cancellation of
    // any previous mint before replacing its card and inventory snapshot.
    loadCompute();
  }
}

function saveInstructions() {
  if (!connect || needsTargetSelection(connect) || !connect.fallback) return;
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
    clearPairingCode();
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
  if (!OS_META[os] || !OS_META[os].agentQualified || needsTargetSelection(card)) return;
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

async function mintPairingCode(replace) {
  if (!connect || !me || me.demo) return;
  const gen = generation;
  const card = connect;
  // Idempotent clicks: a second Pair press while a mint is in flight starts
  // nothing. An explicit re-mint (pair-again) still supersedes via the op
  // fence below.
  if (!replace && card.pair.phase === 'minting') return;
  const op = (card.pair.op = (card.pair.op || 0) + 1);
  card.pair.phase = 'minting';
  card.pair.error = '';
  card.pair.code = ''; card.pair.expiresAt = '';
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
  clearPairingCode();
  const detected = detectOs();
  const os = detected && detected !== 'mobile' ? detected : 'windows';
  connect = { os, detected, picked: false, phase: 'idle', fallback: '', saveFailed: false, copyOp: 0, inv: null, loadError: '', pair: { phase: 'idle', code: '', expiresAt: '', error: '', op: 0 } };
  paintConnectCard();
  const el = $('connect-card');
  el.onclick = onConnectClick;
  el.onchange = onConnectChange;
}

let computeLoad = 0;
async function loadCompute() {
  // Done can refresh within the same navigation generation. Only the latest
  // inventory request may update either the cards or the grant selector.
  const load = ++computeLoad;
  renderConnectCard();
  const el = $('compute-list'); loading(el);
  try {
    const inv = await api('/api/inventory?limit=50');
    if (load !== computeLoad) return;
    // The card reuses this same snapshot for its progress stage: no second
    // call, and a replaced load never repaints a newer card.
    if (connect) { connect.inv = inv; paintConnectCard(); }
    el.innerHTML = inv.items.length ? inv.items.map(resourceCard).join('') : '';
    if (!inv.items.length) state(el, '', 'No resources yet. Pair a worker above, or register one manually under Advanced.');
    $('grant-resource').innerHTML = inv.items.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  } catch (e) {
    if (isStale(e) || load !== computeLoad) return;
    if (connect) { connect.phase = 'load-error'; connect.loadError = e.message; paintConnectCard(); }
    state(el, 'error', e.message);
  }
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
    // Keys render independently of the inventory walk (Muse W4 round
    // 13): a large inventory could fail the walk, and the old
    // Promise.all discarded the keys response with it — hiding the key
    // list and Revoke. A failed walk now degrades only the dropdown.
    const data = await api('/api/keys?limit=50');
    el.innerHTML = data.items.filter((k) => !k.revokedAt).map((k) =>
      `<div class="card"><h2>${esc(k.name)}</h2><p class="muted">${esc(k.prefix)}… · scope: ${esc(k.scope)}${k.scope === 'heartbeat' && k.resourceId ? ` · resource: ${esc(k.resourceId)}` : ''}</p>
       <p class="muted">created ${esc(k.createdAt)} · expires ${esc(k.expiresAt || 'never')} · last used ${esc(k.lastUsedAt || 'never')}</p>
       <button type="button" class="danger" data-revkey="${esc(k.id)}">Revoke</button></div>`).join('');
    if (!data.items.some((k) => !k.revokedAt)) state(el, '', 'No API keys yet.');
    el.querySelectorAll('[data-revkey]').forEach((b) => b.addEventListener('click', async () => {
      try { await api('/api/keys/' + b.dataset.revkey, { method: 'DELETE' }); banner('Key revoked.'); loadKeys(); }
      catch (e) { if (isStale(e)) return; banner(e.message); }
    }));
    try {
      const inv = await allInventory();
      $('key-resource').innerHTML = inv.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
    } catch (e) {
      if (isStale(e)) return;
      $('key-resource').innerHTML = '<option value="">Resources unavailable — Revoke still works below</option>';
    }
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

// ---- Models & adapters catalog (Phase 1: read-only discovery + compat) ----
// Browsing calls metadata endpoints only: no weight download, no inference,
// no worker change. Model cards are untrusted content and render through
// esc() only — markup, scripts, and embedded instructions stay inert.
// External Hub links open in a new tab, marked, never prefetched.
const fmtBytes = (n) => {
  if (!Number.isSafeInteger(n) || n < 0) return 'unknown size';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[u];
};
const extLink = (href, label) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)} (external)</a>`;
const compatPill = (state) => {
  const cls = state === 'estimated-compatible' ? 'ok' : state === 'blocked' ? 'bad' : 'warn';
  const label = state === 'estimated-compatible' ? 'estimated compatible' : state;
  return `<span class="pill ${cls}">${esc(label)}</span>`;
};
let catalogWired = false;

async function catalogNodes(select, keepEmpty) {
  const inv = await allInventory();
  select.innerHTML = (keepEmpty ? '<option value="">no compatibility filter</option>' : '') + inv.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  return inv;
}

async function runCatalogSearch() {
  const list = $('catalog-list');
  const meta = $('catalog-meta');
  const err = $('catalog-error');
  err.hidden = true;
  loading(list);
  meta.textContent = '';
  try {
    const params = new URLSearchParams();
    for (const [key, id] of [['q', 'cat-q'], ['kind', 'cat-kind'], ['task', 'cat-task'], ['format', 'cat-format'], ['quant', 'cat-quant'], ['license', 'cat-license']]) {
      const v = $(id).value.trim();
      if (v) params.set(key, v);
    }
    const nodeId = $('cat-node').value;
    const compat = $('cat-compat').value;
    if (compat) {
      if (!nodeId) throw new Error('Pick a node to filter by compatibility: compatibility is per-node, never global.');
      params.set('compat', compat);
      params.set('nodeId', nodeId);
    }
    params.set('limit', '20');
    const res = await api('/api/catalog/search?' + params.toString());
    const total = Number.isSafeInteger(res.total) ? `${res.total} result(s)` : 'results';
    meta.textContent = `${total}${res.fixture ? ' · DEMO DATA: fixtures, not live Hub content' : ''}${res.compatFiltered ? ' · filtered by compatibility' : ''}`;
    if (!res.items.length) {
      list.innerHTML = '<div class="card"><p class="muted">No models match these filters. Broaden the search or clear the compatibility filter.</p></div>';
      return;
    }
    list.innerHTML = res.items.map((a) => `<div class="card"><h2>${esc(a.repo)}</h2>
      <p class="muted">${esc(a.kind)} · ${esc(a.task)} · ${esc(a.format)}${a.quant && a.quant !== 'unknown' ? ' · ' + esc(a.quant) : ''} · ${fmtBytes(a.totalBytes)}</p>
      <p class="muted">revision ${esc(a.revision ? a.revision.slice(0, 12) : 'unpinned')} · license: ${esc((a.license.tags || []).join(', ') || 'unstated')}${a.gated ? ' · gated access' : ''}${a.fixture ? ' · DEMO' : ''}</p>
      <div class="actions"><button type="button" class="btn secondary" data-asset="${esc(a.repo)}">Details</button>${extLink('https://huggingface.co/' + a.repo, 'Hub page')}</div></div>`).join('');
    // Host-level delegation (connect-card pattern): survives re-renders and
    // stays drivable in the minimal-DOM UI harness.
    list.onclick = (e) => {
      const repo = e && e.target && e.target.dataset ? e.target.dataset.asset : null;
      if (repo) showAssetDetail(repo);
    };
  } catch (e) { if (isStale(e)) return; err.textContent = e.message; err.hidden = false; state(list, 'error', e.message); }
}

async function showAssetDetail(repo) {
  const host = $('asset-detail');
  loading(host);
  if (host.scrollIntoView) host.scrollIntoView();
  try {
    const a = await api('/api/catalog/assets/' + encodeURIComponent(repo));
    const demo = !!(me && me.demo);
    const files = (a.files || []).map((f) => `<li>${esc(f.relpath)} — ${fmtBytes(f.bytes)}${f.sha256 ? '' : ' · digest pending pinned resolve'}</li>`).join('');
    host.innerHTML = `<div class="card"><h2>${esc(a.repo)}</h2>
      <p class="muted">${esc(a.kind)} · ${esc(a.task)} · ${esc(a.format)}${a.fixture ? ' · DEMO DATA: fixture, not a live model' : ''}</p>
      <p>revision <code>${esc(a.revision || 'unpinned')}</code> · ${fmtBytes(a.totalBytes)} across ${(a.files || []).length} file(s)</p>
      <p class="muted">license tags: ${esc((a.license.tags || []).join(', ') || 'unstated')} — a tag is evidence to review, not a legal conclusion.${a.gated ? ' Gated access: you must complete the grant yourself; nothing is auto-accepted.' : ''}</p>
      <p>${extLink('https://huggingface.co/' + a.repo, 'Hub page')}</p>
      <h3>Files (manifest — nothing is downloaded)</h3><ul>${files}</ul>
      <h3>Model card (untrusted, rendered inert)</h3><pre class="cardtext">${esc(a.card || '(no card text)')}</pre>
      ${demo ? '<p class="muted">Compatibility checks are disabled for the demo account.</p>' : `<form id="compat-form" class="card">
        <h3>Check compatibility</h3>
        <label>Node <select id="compat-node" required></select></label>
        <label>Runtime <input id="compat-runtime" required maxlength="64" value="fixture-llama"></label>
        <label>Context length <input id="compat-context" type="number" min="1" max="1048576" value="4096" required></label>
        <label>Concurrency <input id="compat-concurrency" type="number" min="1" max="1024" value="1" required></label>
        ${a.kind === 'adapter' ? '<label>Adapter repo <input id="compat-adapter" maxlength="200"></label><label>Exact base repo <input id="compat-base" maxlength="200"></label>' : ''}
        <p id="compat-error" class="error" role="alert" hidden></p>
        <button type="submit">Evaluate</button>
      </form><div id="compat-out" role="status"></div>`}</div>`;
    if (!demo) {
      await catalogNodes($('compat-node'), false);
      $('compat-form').addEventListener('submit', (e) => { e.preventDefault(); runCompat(a); });
    }
  } catch (e) { if (isStale(e)) return; state(host, 'error', e.message); }
}

async function runCompat(asset) {
  const out = $('compat-out');
  const err = $('compat-error');
  err.hidden = true;
  loading(out);
  try {
    const body = {
      ...(asset.id.startsWith('priv:') ? { assetId: asset.id } : { repo: asset.repo }),
      nodeId: $('compat-node').value,
      runtime: $('compat-runtime').value.trim(),
      context: Number($('compat-context').value),
      concurrency: Number($('compat-concurrency').value),
    };
    const adapterEl = $('compat-adapter');
    if (adapterEl && adapterEl.value.trim()) {
      if (adapterEl.value.trim().startsWith('priv:')) body.adapterAssetId = adapterEl.value.trim(); else body.adapterRepo = adapterEl.value.trim();
      if ($('compat-base').value.trim().startsWith('priv:')) body.baseAssetId = $('compat-base').value.trim(); else body.baseRepo = $('compat-base').value.trim();
    }
    const dec = await api('/api/catalog/compat', { method: 'POST', body: JSON.stringify(body) });
    const rows = (items) => (items || []).map((r) => `<li><strong>${esc(r.code)}</strong> — ${esc(r.message)}${r.resolve ? ' ' + esc(r.resolve) : ''}</li>`).join('');
    const est = dec.estimate ? `<h4>Resource budget (conservative estimate, not a load test)</h4>
      <ul><li>weights ${fmtBytes(dec.estimate.weightsBytes)}</li><li>KV cache ${fmtBytes(dec.estimate.kvCacheBytes)}</li>
      <li>runtime buffers ${fmtBytes(dec.estimate.runtimeBuffersBytes)}</li><li>adapter ${fmtBytes(dec.estimate.adapterBytes)}</li>
      <li>load workspace ${fmtBytes(dec.estimate.loadWorkspaceBytes)}</li><li>safety reserve ${fmtBytes(dec.estimate.safetyReserveBytes)}</li>
      <li><strong>total ${fmtBytes(dec.estimate.totalBytes)}</strong></li></ul>
      <p class="muted">method: ${esc(dec.estimate.method)} · ${esc(dec.estimate.uncertainty)}</p>` : '';
    out.innerHTML = `<div class="card"><h3 tabindex="-1" id="compat-head">Decision: ${compatPill(dec.state)}</h3>
      <p class="muted">node ${esc(dec.nodeId)} · estimator ${esc(dec.estimator)} · capability-report age ${dec.telemetryAgeMs === null ? 'unknown' : Math.round(dec.telemetryAgeMs / 1000) + 's'} · expires ${esc(dec.expiresAt)}${dec.cached ? ' · cached' : ''}${dec.fixture ? ' · DEMO' : ''} · snapshot only, not a connected node</p>
      ${dec.blocking && dec.blocking.length ? `<h4>Blocking</h4><ul>${rows(dec.blocking)}</ul>` : ''}
      ${dec.unknown && dec.unknown.length ? `<h4>Unknown (missing evidence)</h4><ul>${rows(dec.unknown)}</ul>` : ''}
      ${dec.warnings && dec.warnings.length ? `<h4>Warnings</h4><ul>${rows(dec.warnings)}</ul>` : ''}
      ${est}
      ${dec.state === 'estimated-compatible' ? '<p><button type="button" class="btn" data-plan="1">Plan deployment</button></p>' : '<p><button type="button" class="btn" disabled title="Deployment needs an estimated-compatible decision">Deploy (unavailable)</button></p>'}<div id="deploy-out" role="status"></div></div>`;
    lastCompatInput = { ref: body.repo || body.assetId, nodeId: body.nodeId, runtime: body.runtime, context: body.context, concurrency: body.concurrency };
    out.onclick = (e) => {
      const ds = e && e.target && e.target.dataset ? e.target.dataset : {};
      if (ds.plan) runPlan();
      if (ds.exec) runExecute(false);
      if (ds.execDemo) runExecute(true);
      if (ds.depRefresh) trackRefresh(ds.depRefresh, $('deploy-track'));
      if (ds.depCancel) trackCancel(ds.depCancel, $('deploy-track'));
    };
    const head = $('compat-head');
    if (head && head.focus) head.focus();
  } catch (e) { if (isStale(e)) return; err.textContent = e.message; err.hidden = false; state(out, 'error', e.message); }
}

// ---- qualified deployments (Phase 3: plan -> execute -> track) ----
// Plans pin exact revisions and expire in 15 minutes; execution re-checks
// compatibility, reserves node memory, then dispatches. Each plan mints one
// idempotency key per path (real / walkthrough) so retries and double
// clicks replay the same job instead of duplicating it. The fixture
// walkthrough drives the fake worker through its scripted receipts and is
// labeled DEMO throughout; live environments refuse scripted plans.
let lastCompatInput = null;
let pendingPlan = null;
const depCache = new Map();
const DEPLOY_FINAL = ['ready', 'failed', 'cancelled'];
const WALKTHROUGH = [{ status: 'staging' }, { status: 'verifying' }, { status: 'loading' }, { status: 'ready' }];
const deployPill = (s) => `<span class="pill ${s === 'ready' ? 'ok' : (s === 'failed' || s === 'cancelled') ? 'bad' : 'warn'}">${esc(s)}</span>`;
const mintIdemKey = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'key-' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2));

function renderDeployment(d, events) {
  const ev = (events || []).map((e) => `<li>${esc(e.at)} · ${esc(e.from_state || '—')} → ${esc(e.to_state)} — ${esc(e.detail || '')}</li>`).join('');
  return `<div class="card"><h3>Deployment ${esc(d.id)}</h3>
    ${d.scripted ? '<p class="muted">DEMO: scripted fixture-worker receipts, not live execution.</p>' : ''}
    <p>${deployPill(d.state)} <span class="muted">${esc(d.plan.asset.id)}@${esc(String(d.plan.asset.revision).slice(0, 12))} → node ${esc(d.plan.nodeId)} · ${esc(d.plan.runtime)}</span></p>
    ${d.error ? `<p class="error" role="alert">${esc(d.error.code || 'FAILED')}: ${esc(d.error.detail || '')}</p>` : ''}
    <p class="muted">reservation ${esc(d.reservation ? d.reservation.state : 'none')} · ${fmtBytes(d.estimateTotalBytes)} · updated ${esc(d.updatedAt)}</p>
    <h4>Event trail</h4><ul>${ev || '<li>No events yet.</li>'}</ul>
    ${d.state === 'cancelling' ? '<p class="muted">Cancel requested — awaiting worker acknowledgment. Capacity stays held.</p>' : ''}
    <div class="actions"><button type="button" class="btn secondary" data-dep-refresh="${esc(d.id)}">Refresh status</button>${DEPLOY_FINAL.includes(d.state) || d.state === 'cancelling' ? '' : `<button type="button" class="danger" data-dep-cancel="${esc(d.id)}">Cancel</button>`}</div></div>`;
}

function renderDeploymentLite(d) {
  return `<div class="card"><h3>Deployment ${esc(d.id)}</h3>
    ${d.scripted ? '<p class="muted">DEMO walkthrough.</p>' : ''}
    <p>${deployPill(d.state)} <span class="muted">${esc(d.assetId)}@${esc(String(d.revision).slice(0, 12))} → node ${esc(d.nodeId)}</span></p>
    ${d.error ? `<p class="error" role="alert">${esc(d.error.code || 'FAILED')}: ${esc(d.error.detail || '')}</p>` : ''}
    ${d.state === 'cancelling' ? '<p class="muted">Cancel requested — awaiting worker acknowledgment. Capacity stays held.</p>' : ''}
    <div class="actions"><button type="button" class="btn secondary" data-dep-refresh="${esc(d.id)}">Refresh status</button>${DEPLOY_FINAL.includes(d.state) || d.state === 'cancelling' ? '' : `<button type="button" class="danger" data-dep-cancel="${esc(d.id)}">Cancel</button>`}</div></div>`;
}

async function runPlan() {
  const host = $('deploy-out');
  if (!lastCompatInput) return;
  loading(host);
  pendingPlan = null;
  try {
    const b = lastCompatInput;
    const res = await api('/api/catalog/plans', { method: 'POST', body: JSON.stringify({ assetRef: b.ref, nodeId: b.nodeId, runtime: b.runtime, context: b.context, concurrency: b.concurrency }) });
    pendingPlan = { planToken: res.planToken, plan: res.plan, expiresAt: res.expiresAt, keys: {} };
    host.innerHTML = `<div class="card"><h3>Deployment plan</h3>
      <p class="muted">${esc(res.plan.asset.id)}@${esc(String(res.plan.asset.revision).slice(0, 12))} → node ${esc(res.plan.nodeId)} · ${esc(res.plan.runtime)} · context ${esc(res.plan.context)} · concurrency ${esc(res.plan.concurrency)}</p>
      <p>reserved on execute: <strong>${fmtBytes(res.plan.estimateTotalBytes)}</strong> · plan expires ${esc(res.expiresAt)}</p>
      <p class="muted">Execution re-checks compatibility and access, then reserves node memory before dispatch. Live worker dispatch is not implemented: real execution is refused honestly until a lifecycle transport qualifies.</p>
      <p id="deploy-error" class="error" role="alert" hidden></p>
      <div class="actions"><button type="button" class="btn" data-exec="1">Execute</button><button type="button" class="btn secondary" data-exec-demo="1">Fixture walkthrough (DEMO)</button></div>
      <div id="deploy-track"></div></div>`;
  } catch (e) { if (isStale(e)) return; state(host, 'error', e.message); }
}

async function runExecute(walkthrough) {
  const err = $('deploy-error');
  const track = $('deploy-track');
  if (!pendingPlan || !track) return;
  err.hidden = true;
  loading(track);
  try {
    const slot = walkthrough ? 'demo' : 'real';
    let planToken = pendingPlan.planToken;
    if (walkthrough) {
      const b = lastCompatInput;
      const res = await api('/api/catalog/plans', { method: 'POST', body: JSON.stringify({ assetRef: b.ref, nodeId: b.nodeId, runtime: b.runtime, context: b.context, concurrency: b.concurrency, fixtureScript: WALKTHROUGH }) });
      planToken = res.planToken;
    }
    if (!pendingPlan.keys[slot]) pendingPlan.keys[slot] = mintIdemKey();
    const job = await api('/api/catalog/deployments', { method: 'POST', body: JSON.stringify({ idempotencyKey: pendingPlan.keys[slot], planToken }) });
    depCache.set(job.id, { full: job, events: job.events });
    track.innerHTML = renderDeployment(job, job.events);
    loadDeployments();
  } catch (e) { if (isStale(e)) return; err.textContent = e.message; err.hidden = false; state(track, 'error', e.message); }
}

async function trackRefresh(id, host) {
  if (!host) return;
  loading(host);
  try {
    const s = await api('/api/catalog/deployments/' + encodeURIComponent(id));
    depCache.set(id, { full: s, events: s.events });
    host.innerHTML = renderDeployment(s, s.events);
    loadDeployments();
  } catch (e) { if (isStale(e)) return; state(host, 'error', e.message); }
}

async function trackCancel(id, host) {
  if (!host) return;
  loading(host);
  try {
    const s = await api('/api/catalog/deployments/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: JSON.stringify({}) });
    depCache.set(id, { full: s, events: s.events });
    host.innerHTML = renderDeployment(s, s.events);
    loadDeployments();
  } catch (e) { if (isStale(e)) return; state(host, 'error', e.message); }
}

async function loadDeployments() {
  const host = $('my-deployments');
  if (!host) return;
  loading(host);
  try {
    const res = await api('/api/catalog/deployments?limit=50');
    if (!res.items.length) {
      host.innerHTML = '<div class="card"><p class="muted">No deployments yet. Evaluate compatibility on a model, then plan and execute.</p></div>';
      return;
    }
    host.innerHTML = res.items.map((d) => {
      const c = depCache.get(d.id);
      return c ? renderDeployment(c.full, c.events) : renderDeploymentLite(d);
    }).join('');
    host.onclick = async (e) => {
      const ds = e && e.target && e.target.dataset ? e.target.dataset : {};
      if (ds.depRefresh) {
        try {
          const s = await api('/api/catalog/deployments/' + encodeURIComponent(ds.depRefresh));
          depCache.set(ds.depRefresh, { full: s, events: s.events });
          loadDeployments();
        } catch (err) { if (!isStale(err)) banner(err.message); }
      }
      if (ds.depCancel) {
        try {
          const s = await api('/api/catalog/deployments/' + encodeURIComponent(ds.depCancel) + '/cancel', { method: 'POST', body: JSON.stringify({}) });
          depCache.set(ds.depCancel, { full: s, events: s.events });
          loadDeployments();
        } catch (err) { if (!isStale(err)) banner(err.message); }
      }
    };
  } catch (e) { if (isStale(e)) return; state(host, 'error', e.message); }
}

async function apiBytes(path, buf) {
  const gen = generation;
  let res;
  try {
    res = await fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Aipster-CSRF': '1' }, body: buf });
  } catch (e) { if (gen !== generation) throw staleError(); throw e; }
  if (gen !== generation) throw staleError();
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (gen !== generation) throw staleError();
  if (!res.ok) {
    const code = data && data.code ? ` (${data.code})` : '';
    throw new Error((data && data.error ? data.error : `Request failed: ${res.status}`) + code);
  }
  return data;
}

async function loadMyAssets() {
  const host = $('my-assets');
  loading(host);
  try {
    const res = await api('/api/catalog/my-assets?limit=50');
    if (!res.items.length) {
      host.innerHTML = '<div class="card"><p class="muted">No private assets yet. Uploads appear here after validation.</p></div>';
      return;
    }
    host.innerHTML = res.items.map((a) => `<div class="card"><h2>${esc(a.name)}</h2>
      <p class="muted">${esc(a.kind)} · ${esc(a.task)} · ${esc(a.format)} · ${fmtBytes(a.totalBytes)} across ${a.files} file(s)</p>
      <p><span class="pill ${a.validation === 'validated' ? 'ok' : 'bad'}">${esc(a.validation)}</span> <span class="muted">revision ${esc(String(a.revision).slice(0, 12))}</span></p>
      <div class="actions"><button type="button" class="btn secondary" data-myasset="${esc(a.id)}">Details</button><button type="button" class="btn secondary" data-revalidate="${esc(a.id)}">Revalidate</button></div></div>`).join('');
    host.onclick = async (e) => {
      const ds = e && e.target && e.target.dataset ? e.target.dataset : {};
      if (ds.myasset) showAssetDetail(ds.myasset);
      if (ds.revalidate) {
        const id = ds.revalidate.replace(/^priv:/, '');
        try {
          const r = await api(`/api/catalog/assets/${encodeURIComponent(id)}/validate`, { method: 'POST', body: JSON.stringify({}) });
          state(host, r.ok ? 'ok' : 'warn', `Revalidation: ${r.validation}.`);
          loadMyAssets();
        } catch (err) { if (!isStale(err)) state(host, 'error', err.message); }
      }
    };
  } catch (e) { if (isStale(e)) return; state(host, 'error', e.message); }
}

let uploadWired = false;

async function runUpload() {
  const err = $('upload-error');
  const progress = $('upload-progress');
  err.hidden = true;
  progress.textContent = '';
  try {
    const input = $('up-files');
    const files = Array.from((input && input.files) || []);
    if (!files.length) throw new Error('Choose at least one file.');
    const kind = $('up-kind').value;
    const spec = {
      name: $('up-name').value.trim(),
      kind,
      task: $('up-task').value.trim() || 'unknown',
      format: $('up-format').value.trim() || 'unknown',
      license: $('up-license').value.trim() || 'unstated:rights-reserved',
      files: files.map((f) => ({ relpath: f.webkitRelativePath || f.name, bytes: f.size })),
    };
    if (kind === 'adapter') {
      spec.baseAssetId = $('up-base-id').value.trim().replace(/^priv:/, '');
      spec.baseRevision = $('up-base-rev').value.trim();
      spec.targetModules = $('up-modules').value.split(',').map((s) => s.trim()).filter(Boolean);
      spec.tokenizer = $('up-tokenizer').value.trim();
    }
    const begun = await api('/api/catalog/uploads', { method: 'POST', body: JSON.stringify(spec) });
    const CHUNK = 8 * 1024 * 1024;
    for (const file of files) {
      const relpath = file.webkitRelativePath || file.name;
      let index = 0;
      for (let at = 0; at < file.size; at += CHUNK, index++) {
        const part = await file.slice(at, Math.min(at + CHUNK, file.size)).arrayBuffer();
        await apiBytes(`/api/catalog/uploads/${begun.id}/chunk?path=${encodeURIComponent(relpath)}&index=${index}`, part);
        progress.textContent = `Uploading ${relpath}: ${Math.min(at + CHUNK, file.size)} of ${file.size} bytes`;
      }
    }
    progress.textContent = 'Validating…';
    const fin = await api(`/api/catalog/uploads/${begun.id}/finalize`, { method: 'POST', body: JSON.stringify({}) });
    progress.textContent = `Validated: ${spec.name} (${fin.revision.slice(0, 12)}…).`;
    loadMyAssets();
  } catch (e) { if (isStale(e)) return; err.textContent = e.message; err.hidden = false; }
}

async function loadModels() {
  $('demo-models-note').hidden = !(me && me.demo);
  if (!catalogWired) {
    catalogWired = true;
    $('catalog-form').addEventListener('submit', (e) => { e.preventDefault(); runCatalogSearch(); });
    const demoUpload = !!(me && me.demo);
    $('upload-form').hidden = demoUpload;
    if (!uploadWired && !demoUpload) {
      uploadWired = true;
      $('up-kind').addEventListener('change', () => { $('up-adapter-fields').hidden = $('up-kind').value !== 'adapter'; });
      $('upload-form').addEventListener('submit', (e) => { e.preventDefault(); runUpload(); });
    }
    loadMyAssets();
  }
  try {
    await catalogNodes($('cat-node'), true);
  } catch (e) { if (isStale(e)) return; /* node filter degrades; search still works */ }
  if (!$('catalog-list').innerHTML) runCatalogSearch();
  loadDeployments();
}

const loaders = { overview: loadOverview, compute: loadCompute, shared: loadShared, sharing: () => { loadCompute(); loadGrants(); }, models: loadModels, federation: loadFederation, keys: loadKeys, usage: loadUsage, settings: loadSettings };

// ---- federation ----
const idem = () => ({ 'Idempotency-Key': (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)) });
let fabPreview = null; // { id, digest } — cleared by resetState
const fabNodes = [];

async function loadFederation() {
  const on = $('fab-on'), off = $('fab-off');
  try {
    const nodes = await api('/v1/fabric/nodes');
    on.hidden = false; off.hidden = true; $('fab-error').hidden = true;
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
      <p class="muted">${(g.snapshot || []).length} resource(s) · models ${(g.models || []).map(esc).join(', ')}</p>
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
    // Only the flag-off 404 means "not enabled". Any other failure
    // (auth, server, network) keeps that copy hidden and reports the
    // actionable error instead.
    if (e && e.message && e.message.includes('(NOT_FOUND)')) {
      on.hidden = true; off.hidden = false; $('fab-error').hidden = true;
    } else {
      on.hidden = true; off.hidden = true;
      const box = $('fab-error');
      box.textContent = 'Federation unavailable: ' + (e && e.message ? e.message : 'request failed.');
      box.hidden = false;
    }
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
    const key = prompt('Withdraw your side\u2019s veto: paste YOUR node\u2019s own secret (shown once at registration). A peer secret withdraws nothing.');
    if (!key) return;
    try {
      const out = await api('/v1/fabric/connections/' + id + '/resume', { method: 'POST', headers: idem(), body: JSON.stringify({ expectedVersion: v, nodeKey: key.trim() }) });
      banner(out && out.state === 'active' ? 'Connection resumed.' : 'Your veto is withdrawn; ' + ((out && out.remainingVetoes) || []).length + ' peer veto(s) remain.');
      loadFederation();
    } catch (ex) { if (!isStale(ex)) banner(ex.message); }
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
  statusPollToken++;
  for (const id of ['status-strip', 'ov-cards', 'ov-note', 'compute-list', 'shared-list', 'grant-list', 'key-list', 'usage-totals', 'usage-list', 'audit-list']) $(id).innerHTML = '';
  for (const id of ['fab-node-list', 'fab-inv-out', 'fab-inv-in', 'fab-conn-list', 'fab-grant-out', 'fab-grant-in', 'fab-deny-list', 'fab-authz-out']) $(id).innerHTML = '';
  for (const id of ['fab-inv-issuer', 'fab-accept-node', 'fab-authz-node', 'fab-prev-conn']) $(id).innerHTML = '';
  connect = null;
  $('connect-card').innerHTML = ''; $('connect-card').hidden = true;
  $('grant-resource').innerHTML = '';
  $('key-secret').textContent = ''; $('key-reveal').hidden = true;
  $('fab-node-secret').textContent = ''; $('fab-node-reveal').hidden = true;
  $('fab-inv-secret').textContent = ''; $('fab-inv-reveal').hidden = true;
  $('fab-commit-box').hidden = true; $('fab-commit-text').textContent = ''; $('fab-commit-digest').textContent = '';
  fabPreview = null; fabNodes.length = 0;
  $('fab-on').hidden = true; $('fab-off').hidden = true;
  $('fab-error').textContent = ''; $('fab-error').hidden = true;
  $('key-curl').textContent = ''; $('key-curl-wrap').hidden = true;
  $('key-resource').innerHTML = ''; $('key-resource-wrap').hidden = true;
  $('whoami').textContent = '';
  $('settings-email').textContent = ''; $('settings-via').textContent = '…';
  for (const id of ['res-name', 'res-origin', 'res-cpu', 'res-gpu', 'res-caps', 'grant-user', 'key-name', 'key-expires', 'settings-name', 'demo-username', 'demo-password']) $(id).value = '';
  for (const id of ['cat-q', 'cat-task', 'cat-format', 'cat-quant', 'cat-license']) { const el = $(id); if (el) el.value = ''; }
  for (const id of ['cat-kind', 'cat-node', 'cat-compat']) { const el = $(id); if (el) el.selectedIndex = 0; }
  for (const id of ['catalog-list', 'asset-detail', 'my-deployments', 'compat-out', 'deploy-out', 'deploy-track']) { const el = $(id); if (el) el.innerHTML = ''; }
  for (const id of ['catalog-meta', 'catalog-error', 'upload-progress', 'upload-error', 'deploy-error']) { const el = $(id); if (el) el.textContent = ''; }
  pendingPlan = null;
  lastCompatInput = null;
  depCache.clear();
  for (const id of ['up-name', 'up-task', 'up-format', 'up-license', 'up-base-id', 'up-base-rev', 'up-modules', 'up-tokenizer']) { const el = $(id); if (el) el.value = ''; }
  for (const id of ['my-assets']) { const el = $(id); if (el) el.innerHTML = ''; }
  catalogWired = false;
  uploadWired = false;
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
  clearPairingCode();
  if (connect) paintConnectCard();
  generation++;
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', b === btn ? 'true' : 'false'));
  document.querySelectorAll('[role="tabpanel"]').forEach((p) => { p.hidden = p.id !== 'tab-' + btn.dataset.tab; });
  loaders[btn.dataset.tab]();
}));

// Cross-card navigation (e.g. the Overview catalog card): delegates to the
// real tab buttons so generation fencing and loaders stay identical.
if (document.addEventListener) document.addEventListener('click', (e) => {
  const go = e.target && e.target.closest ? e.target.closest('[data-goto]') : null;
  if (!go) return;
  const tab = document.querySelector(`[data-tab="${go.dataset.goto}"]`);
  if (tab) tab.click();
});

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

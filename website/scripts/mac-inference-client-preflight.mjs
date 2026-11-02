#!/usr/bin/env node
/* Mac REQUEST-ORIGIN lane: read-only preflight for real-inference client work.
 *
 * PRD: AIPSTER Real Fabric Inference Qualification on JJP, v1.0 (2026-11-01).
 * Verifies the Mac origin, pinned source, and every source-known contract
 * fact the PRD depends on. Offline only: local file reads plus local
 * version/help subprocesses. No network, no credentials, no worker run, no
 * inference, no remote access. A failing check BLOCKs offline work; the
 * GPU-path HOLD below is a finding, not a failure: preflight's job is to
 * establish that HOLD from source, not to clear it.
 *
 * Usage: node website/scripts/mac-inference-client-preflight.mjs
 *        [--repo <path>] [--out <report.json>] [--expect-base <sha>]
 *          [--pinned-deps <dir>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = resolve(HERE, '..', '..');
const DEFAULT_BASE = '5bf623c11647c7a5340c37575f56d84ff6f04b4c';
const DEFAULT_PINNED = '/private/tmp/aipster-pr63-repair-20261101/node_modules';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const REPO = resolve(flag('--repo', DEFAULT_REPO));
const EXPECT_BASE = flag('--expect-base', DEFAULT_BASE);
const PINNED = flag('--pinned-deps', DEFAULT_PINNED);
const OUT = flag('--out', null);

const checks = [];
const check = (id, name, fn) => {
  try {
    const detail = fn();
    checks.push({ id, name, status: detail.status || 'pass', detail: detail.text, ref: detail.ref || null });
  } catch (e) {
    checks.push({ id, name, status: 'fail', detail: `error: ${e.message}`, ref: null });
  }
};
const run = (cmd, argv, opts = {}) => {
  try {
    return { ok: true, out: execFileSync(cmd, argv, { encoding: 'utf8', timeout: 30000, ...opts }).trim() };
  } catch (e) {
    return { ok: false, out: String((e && e.message) || e) };
  }
};
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');
const mustContain = (text, needle, what) => {
  if (!text.includes(needle)) throw new Error(`missing ${what}: ${JSON.stringify(needle)}`);
};
const mustLack = (text, needle, what) => {
  if (text.includes(needle)) throw new Error(`forbidden ${what} present: ${JSON.stringify(needle)}`);
};

// ---------------------------------------------------------------- origin
check('origin-mac', 'Mac request origin (read-only OS facts)', () => {
  const vers = run('sw_vers', []);
  const arch = run('uname', ['-m']);
  if (!vers.ok) throw new Error(`sw_vers failed: ${vers.out}`);
  if (!/macOS/i.test(vers.out)) throw new Error(`not macOS: ${vers.out.split('\n')[0]}`);
  return { text: `${vers.out.split('\n').join('; ')}; arch=${arch.ok ? arch.out : 'unknown'}` };
});

check('tool-node', 'Private Node 24 toolchain', () => {
  const v = process.version;
  const major = Number(v.replace(/^v/, '').split('.')[0]);
  if (major !== 24) throw new Error(`requires Node 24, running ${v} at ${process.execPath}`);
  return { text: `${v} at ${process.execPath}` };
});

check('tool-python', 'Python version recorded (no worker run)', () => {
  const r = run('python3', ['--version']);
  if (!r.ok) throw new Error(`python3 --version failed: ${r.out}`);
  return { text: r.out };
});

check('tool-deps', 'Pinned deps available read-only', () => {
  const cand = [join(PINNED, 'better-auth', 'package.json'), join(PINNED, 'parse5', 'package.json')];
  const missing = cand.filter((p) => !existsSync(p));
  if (missing.length) {
    return { status: 'warn', text: `pinned dir lacks: ${missing.join(', ')} (NODE_PATH=${process.env.NODE_PATH || 'unset'}); tests need better-auth+parse5` };
  }
  return { text: `better-auth+parse5 resolvable under ${PINNED} (read-only; nothing installed)` };
});

// ---------------------------------------------------------------- source
check('src-pin', 'Lane based on reviewed PR63 head', () => {
  const head = run('git', ['-C', REPO, 'rev-parse', 'HEAD']);
  if (!head.ok) throw new Error(`git rev-parse failed: ${head.out}`);
  const anc = run('git', ['-C', REPO, 'merge-base', '--is-ancestor', EXPECT_BASE, head.out]);
  if (!anc.ok) throw new Error(`HEAD ${head.out} is not a descendant of ${EXPECT_BASE}`);
  const branch = run('git', ['-C', REPO, 'branch', '--show-current']);
  const dirty = run('git', ['-C', REPO, 'status', '--porcelain']);
  const suffix = dirty.ok && dirty.out ? '; tree DIRTY (uncommitted work present)' : '; tree clean';
  return {
    status: dirty.ok && dirty.out ? 'warn' : 'pass',
    text: `HEAD=${head.out} branch=${branch.ok ? branch.out : '?'} descends ${EXPECT_BASE}${suffix}`,
  };
});

check('src-cpu-only', 'Placement is CPU-only on both sides', () => {
  const worker = read('local-worker/inference_worker.py');
  mustContain(worker, 'placement["device"] != "cpu"', 'worker CPU fence');
  const store = read('website/src/inference/dispatch-store.mjs');
  mustContain(store, "task.placement.device !== 'cpu'", 'store CPU fence');
  const coord = read('website/src/inference/dispatch-coordinator.mjs');
  for (const [text, what] of [[worker, 'worker'], [store, 'store'], [coord, 'coordinator']]) {
    mustContain(text, 'aipster-bound-cpu-internal/1', `${what} protocol`);
  }
  return { text: 'worker + store reject non-cpu placement; protocol aipster-bound-cpu-internal/1 on all three', ref: 'inference_worker.py:368; dispatch-store.mjs:988; dispatch-coordinator.mjs:38' };
});

check('src-no-gpu-cli', 'No GPU/device CLI and no token-file flag', () => {
  const pairing = read('local-worker/pairing.py');
  mustLack(pairing, '--gpu', 'gpu flag');
  mustLack(pairing, '--device', 'device flag');
  mustLack(pairing, 'token-file', 'token-file flag');
  const help = run('python3', [join(REPO, 'local-worker', 'pairing.py'), 'serve-jobs', '--help']);
  if (!help.ok) throw new Error(`serve-jobs --help failed: ${help.out}`);
  mustContain(help.out, '--runtime-id', 'help runtime-id');
  if (/--gpu|--device|token-file/.test(help.out)) throw new Error('help advertises an invented selector');
  const worker = read('local-worker/inference_worker.py');
  mustContain(worker, 'AIPSTER_GANGLION_TOKEN', 'private upstream token env');
  return { text: 'serve-jobs offers interval/upstream-url/allow-non-loopback/runtime-id/models-cache-ttl/once only; upstream auth is env AIPSTER_GANGLION_TOKEN', ref: 'pairing.py:1060-1075; inference_worker.py:85' };
});

check('src-alias', 'runtime_instance/model_fingerprint are echoed aliases', () => {
  const store = read('website/src/inference/dispatch-store.mjs');
  mustContain(store, 'runtime_instance = runtime_id', 'alias doc');
  mustContain(store, 'model_fingerprint = model_id', 'alias doc');
  return { status: 'pass', text: 'aliases, not attestation: must never be described as boot identity or weights digest', ref: 'dispatch-store.mjs:13-14,371-378' };
});

check('src-flag-routes', 'Flag gate, 501, and route surface', () => {
  const w = read('website/src/worker.js');
  mustContain(w, "INFERENCE_ENABLED === '1'", 'flag gate');
  mustContain(w, 'INFERENCE_DISABLED', '501 code');
  mustContain(w, 'Inference dispatch is disabled. No job was created and no compute ran.', 'exact 501 text');
  for (const r of ['/api/inference/admissions', '/api/worker/jobs/next', 'DISPATCH_ROUTE_RE', 'DISPATCH_CANCEL_RE', 'WORKER_RESULT_RE']) {
    mustContain(w, r, `route ${r}`);
  }
  return { text: 'flag-gated admissions/submit/poll/cancel/worker-pull/worker-result; default POST /api/jobs is the exact 501', ref: 'worker.js:108-112,2893,2970-2974,3014' };
});

check('src-contract', 'Contract version, bounds, forged fields, cancel limit', () => {
  const c = read('website/src/inference/dispatch-coordinator.mjs');
  mustContain(c, "CONTRACT_VERSION = 'v1.0.0'", 'contract version');
  mustContain(c, 'MAX_DEADLINE_MS = 180000', 'deadline bound');
  mustContain(c, "'placement'", 'forged placement');
  mustContain(c, "cancel: 'UNSUPPORTED_CAPABILITY'", 'post-start cancel');
  mustContain(c, 'remote never claimed stopped', 'cancel honesty');
  const s = read('website/src/inference/dispatch-store.mjs');
  mustContain(s, 'MAX_TOKENS = 4096', 'token bound');
  mustContain(s, "'ganglion', 'llama-server'", 'runtime allowlist');
  mustContain(s, 'fails closed', 'budget fail-closed');
  return { text: 'v1.0.0; deadline<=180s; max_tokens<=4096; runtimes ganglion|llama-server; placement forged; post-start cancel unsupported', ref: 'dispatch-coordinator.mjs:37-53,452-465; dispatch-store.mjs:90-95,129-133' };
});

check('src-migrations-docs', 'Migrations, runbooks, synthetic e2e labeled', () => {
  for (const f of ['website/migrations/0024_inference_dispatch.sql', 'website/migrations/0025_inference_dispatch_claim_ledger.sql',
    'docs/inference-dispatch-routes.md', 'docs/dispatch-coordinator.md', 'docs/ik-cpu-qualification-runbook.md',
    'website/scripts/e2e-python-worker.mjs']) {
    if (!existsSync(join(REPO, f))) throw new Error(`missing ${f}`);
  }
  const e2e = read('website/scripts/e2e-python-worker.mjs');
  mustContain(e2e, 'fake', 'e2e fake upstream');
  mustContain(e2e, 'no live inference', 'e2e honesty label');
  return { text: '0024/0025 present; runbooks present; e2e-python-worker.mjs self-labels fake upstream, no live inference' };
});

// ------------------------------------------------------- findings, not gates
check('deployed-unknown', 'Deployed state is unknown (no probe performed)', () => ({
  status: 'warn',
  text: 'no network probe: deployed source, migrations, flag, and D1 binding are UNKNOWN; PR63 is draft per PRD-INPUTS; source-known must not be presented as deployed',
}));

check('gpu-path-hold', 'GPU route is unselectable: exact live HOLD', () => ({
  status: 'hold',
  text: 'contract has no device selector (submit placement is FORGED_CLIENT_AUTHORITY; no --gpu CLI) and both sides fence device=cpu: RTX 3090 execution cannot be requested, so live qualification is HOLD pending an explicit reviewed GPU authority/capability decision by the backend owner',
  ref: 'dispatch-coordinator.mjs:49-51,89; inference_worker.py:368; dispatch-store.mjs:988',
}));

const fails = checks.filter((c) => c.status === 'fail');
const report = {
  script: 'website/scripts/mac-inference-client-preflight.mjs',
  generated_at: new Date().toISOString(),
  repo: REPO,
  expect_base: EXPECT_BASE,
  live: fails.length
    ? 'BLOCKED: preflight failures must be resolved before offline work'
    : 'HOLD: offline work may proceed; live inference is HOLD (gpu-path-hold)',
  verdict: fails.length ? 'BLOCKED' : 'READY_FOR_OFFLINE',
  checks,
};

const text = JSON.stringify(report, null, 2);
if (OUT) {
  const dir = dirname(resolve(OUT));
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(OUT), text);
}
console.log(text);
process.exit(fails.length ? 1 : 0);

#!/usr/bin/env node
// Offline production-readiness evidence validator.
//
// Validates explicit, sanitized, operator-supplied JSON evidence of the
// observed production D1 migration journal, fabric_grants columns, the
// non-secret effective feature flags and the target/live identities against
// the reviewed checkout. It performs NO network access, NO Cloudflare calls,
// NO secret reads and NO mutation: it reads only the evidence file, the local
// wrangler.jsonc and the local migrations directory.
//
// Fail closed: any missing, ambiguous or contradictory evidence is a HOLD.
// Desired configuration is never treated as observed fact, and a flag is
// never inferred from its absence in a workflow or config file: every flag
// must be explicitly reported by the operator as observed.
//
// Exit codes: 0 READY, 1 HOLD, 2 usage/unreadable input.
// See docs/production-readiness-evidence.md for the operator read-only steps.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EVIDENCE_SCHEMA = 'aipster.production-readiness-evidence/v1';
export const EVIDENCE_KIND = 'operator-observed-production';
export const REQUIRED_FLAGS = ['DGM_MUSE_LIVE', 'DGM_MUSE_SPEND_CAP_USD', 'DGM_PREVIEW_ENABLED', 'INFERENCE_ENABLED'];
export const REQUIRED_FABRIC_GRANTS_COLUMNS = ['used_tokens', 'used_jobs'];
const BINDINGS = ['unset', 'plain_text', 'secret'];
const SHA = /^[a-f0-9]{40}$/;
const HERE = dirname(fileURLToPath(import.meta.url));

/** Strip // and /* *\/ comments outside strings, then parse (wrangler.jsonc). */
export function parseJsonc(text) {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out);
}

/** Expected identities and migration set from the reviewed local checkout. */
export function loadRepoExpectations(websiteDir = resolve(HERE, '..')) {
  const cfg = parseJsonc(readFileSync(resolve(websiteDir, 'wrangler.jsonc'), 'utf8'));
  const d1 = (cfg.d1_databases || []).filter(d => d.binding === 'DB');
  if (d1.length !== 1) throw new Error('wrangler.jsonc must declare exactly one DB binding');
  const migrations = readdirSync(resolve(websiteDir, d1[0].migrations_dir || 'migrations'))
    .filter(f => /^\d{4}_.+\.sql$/.test(f)).sort();
  return {
    workerName: cfg.name,
    d1DatabaseName: d1[0].database_name,
    d1DatabaseId: d1[0].database_id,
    configVars: Object.keys(cfg.vars || {}),
    keepVars: cfg.keep_vars === true,
    migrations,
  };
}

// Effective value as the runtime code parses it (src/dgm/muse-provider.mjs,
// src/dgm/router.mjs, src/worker.js): flags are on only when exactly '1'; the spend
// cap is a finite non-negative number, otherwise 0.
function flagOn(v) { return v === '1'; }
function capUsd(v) {
  if (v === undefined) return 0;
  const n = v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Pure decision. Returns {verdict: 'READY'|'HOLD', failures, warnings, summary}.
 * `candidateSha` is the exact SHA the operator/integrator intends to release.
 */
export function evaluateReadiness(evidence, { candidateSha, repo }) {
  const failures = [], warnings = [];
  const fail = m => failures.push(m);
  const e = evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence : null;
  if (!e) return { verdict: 'HOLD', failures: ['evidence is not a JSON object'], warnings, summary: null };

  if (e.schema !== EVIDENCE_SCHEMA) fail(`schema must be ${EVIDENCE_SCHEMA}`);
  if (e.evidence_kind !== EVIDENCE_KIND) fail(`evidence_kind must be ${EVIDENCE_KIND} (desired/fixture config is not observed fact)`);
  if (typeof e.observed_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(e.observed_at)
    || Number.isNaN(Date.parse(e.observed_at))) fail('observed_at must be an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)');
  if (typeof e.observer !== 'string' || !e.observer.trim()) fail('observer must name who collected the evidence');

  // Identities.
  if (!SHA.test(candidateSha || '')) fail('expected candidate SHA (--candidate) must be a 40-hex commit');
  if (!SHA.test(e.candidate_sha || '')) fail('candidate_sha missing or not a 40-hex commit');
  else if (candidateSha && e.candidate_sha !== candidateSha) fail(`wrong target: evidence candidate_sha ${e.candidate_sha} != expected ${candidateSha}`);
  if (e.release_mode !== 'auto' && e.release_mode !== 'manual') fail('release_mode must be auto or manual');
  const live = e.live || {};
  if (!SHA.test(live.deployment_git_commit || '')) fail('live.deployment_git_commit missing or not a 40-hex commit (unknown live baseline)');
  const t = e.target || {};
  if (t.worker_name !== repo.workerName) fail(`wrong target worker: ${JSON.stringify(t.worker_name)} != ${repo.workerName}`);
  if (t.d1_database_name !== repo.d1DatabaseName) fail(`wrong target D1 name: ${JSON.stringify(t.d1_database_name)} != ${repo.d1DatabaseName}`);
  if (t.d1_database_id !== repo.d1DatabaseId) fail(`wrong target D1 id: ${JSON.stringify(t.d1_database_id)} != ${repo.d1DatabaseId}`);

  // Schema: the observed journal must contain every reviewed migration, once.
  const d1 = e.d1 || {};
  const journal = d1.migrations_applied;
  if (!Array.isArray(journal) || journal.length === 0 || !journal.every(n => typeof n === 'string')) {
    fail('d1.migrations_applied must be the non-empty observed list of d1_migrations.name');
  } else {
    const seen = new Set(), dups = new Set();
    for (const n of journal) (seen.has(n) ? dups : seen).add(n);
    if (dups.size) fail(`ambiguous journal: duplicate entries ${[...dups].join(', ')}`);
    const missing = repo.migrations.filter(m => !seen.has(m));
    if (missing.length) fail(`migrations not applied in production: ${missing.join(', ')}`);
    const unknown = [...seen].filter(n => !repo.migrations.includes(n));
    if (unknown.length) fail(`ambiguous journal: production has migrations unknown to the candidate: ${unknown.join(', ')}`);
  }
  const cols = d1.fabric_grants_columns;
  if (!Array.isArray(cols) || cols.length === 0 || !cols.every(c => typeof c === 'string')) {
    fail('d1.fabric_grants_columns must be the non-empty observed column-name list of fabric_grants');
  } else {
    for (const c of REQUIRED_FABRIC_GRANTS_COLUMNS)
      if (!cols.includes(c)) fail(`fabric_grants column missing in production: ${c}`);
    if (Array.isArray(journal) && !journal.includes('0029_fabric_dispatch_spend.sql')
      && REQUIRED_FABRIC_GRANTS_COLUMNS.every(c => cols.includes(c)))
      fail('ambiguous schema: 0029 columns present without a 0029 journal entry (out-of-band ALTER)');
  }

  // Flags: every required flag must be explicitly observed; secret values are
  // unobservable read-only, so a secret-bound flag is ambiguous.
  const flags = e.flags && typeof e.flags === 'object' && !Array.isArray(e.flags) ? e.flags : null;
  const effective = {};
  if (!flags) fail('flags object missing: effective flags must be observed, never inferred');
  else {
    const extra = Object.keys(flags).filter(k => !REQUIRED_FLAGS.includes(k));
    if (extra.length) fail(`unexpected flag keys (only the four non-secret flags are accepted): ${extra.join(', ')}`);
    for (const name of REQUIRED_FLAGS) {
      const f = flags[name];
      if (!f || typeof f !== 'object') { fail(`effective flag ${name} not observed`); continue; }
      if (!BINDINGS.includes(f.binding)) { fail(`flag ${name}.binding must be one of ${BINDINGS.join('|')}`); continue; }
      if (f.binding === 'secret') { fail(`ambiguous flag ${name}: bound as a secret, value is not observable read-only`); continue; }
      if (f.binding === 'unset') {
        if ('value' in f) { fail(`ambiguous flag ${name}: binding unset but a value was supplied`); continue; }
        effective[name] = undefined;
      } else {
        if (typeof f.value !== 'string') { fail(`flag ${name}.value must be the observed string value`); continue; }
        effective[name] = f.value;
        if (!repo.configVars.includes(name) && !repo.keepVars)
          warnings.push(`${name} is a dashboard plain-text var absent from wrangler.jsonc; wrangler deploy without keep_vars is expected to remove it (post-deploy value: unset). Re-observe after deploy.`);
      }
    }
  }
  const observedFlags = flags && REQUIRED_FLAGS.every(n => n in effective || (flags[n] && flags[n].binding === 'unset'));
  let summary = null;
  if (observedFlags) {
    const dgmLive = flagOn(effective.DGM_MUSE_LIVE);
    const cap = capUsd(effective.DGM_MUSE_SPEND_CAP_USD);
    if (dgmLive) fail('DGM_MUSE_LIVE is enabled; release policy requires DGM live generation off');
    if (cap !== 0) fail(`DGM_MUSE_SPEND_CAP_USD is ${cap}; release policy requires a zero cap`);
    if (effective.DGM_MUSE_SPEND_CAP_USD !== undefined && !/^\s*0+(\.0+)?\s*$/.test(effective.DGM_MUSE_SPEND_CAP_USD))
      if (cap === 0) fail(`ambiguous DGM_MUSE_SPEND_CAP_USD ${JSON.stringify(effective.DGM_MUSE_SPEND_CAP_USD)}: parses to 0 only by fallback; set it unset or literal 0`);
    summary = {
      dgm_muse_live: dgmLive,
      dgm_muse_spend_cap_usd: cap,
      dgm_preview_enabled: flagOn(effective.DGM_PREVIEW_ENABLED),
      inference_enabled: flagOn(effective.INFERENCE_ENABLED),
    };
    if (!summary.inference_enabled)
      warnings.push('INFERENCE_ENABLED is off: inference/fabric dispatch routes (the 0029 column consumers) are disabled; schema is still required before deploy.');
  }

  if (e.release_mode === 'manual')
    warnings.push('manual dispatch skips the workflow migration-hold step; this validator is the schema evidence for manual mode.');
  if (e.release_mode === 'auto' && SHA.test(live.deployment_git_commit || '') && live.deployment_git_commit !== e.candidate_sha)
    warnings.push('auto mode: the workflow holds on any migration diff since the live baseline; a schema-changing release must ship via reviewed manual dispatch.');

  return {
    verdict: failures.length ? 'HOLD' : 'READY',
    candidate_sha: e.candidate_sha || null,
    live_sha: live.deployment_git_commit || null,
    release_mode: e.release_mode || null,
    observed_at: e.observed_at || null,
    expected_migrations: repo.migrations.length,
    effective_flags: summary,
    failures, warnings,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--evidence' || a === '--candidate') out[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let args, evidence, repo;
  try {
    args = parseArgs(process.argv.slice(2));
    if (!args.evidence || !args.candidate) throw new Error('usage: verify-production-readiness.mjs --evidence <file.json> --candidate <40-hex sha>');
    evidence = JSON.parse(readFileSync(args.evidence, 'utf8'));
    repo = loadRepoExpectations();
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(2);
  }
  const result = evaluateReadiness(evidence, { candidateSha: args.candidate, repo });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === 'READY' ? 0 : 1);
}

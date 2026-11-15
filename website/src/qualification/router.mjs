/* Built with Meta Muse. Meta-qualification lane (meta-qual). */
/* Owner + worker qualification routes. Session/CSRF enforced by worker.js; */
/* heartbeat-key binding, revocation and current ownership enforced here. */
import { first, rid } from '../lib/store.js';
import { httpError } from '../lib/validate.js';
import {
  BENCH_DEADLINE_MS, BENCH_MAX_TOKENS, BENCH_RUNTIMES,
  QUAL_CATALOG_VERSION, QUAL_CLAIM_BY_MS, QUAL_OUTPUT_MAX_TOKENS,
  QUAL_PROMPT_VERSION, QUAL_RESULT_GRACE_MS, QUAL_SCHEMA,
} from './constants.mjs';
import { qualificationLiveEnabled } from './constants.mjs';
import { canonicalProfileDigest, eligibleCatalog, normalizeProfile } from './profile.mjs';
import { checkQualificationBody, validateProviderAdvice, validateWorkerResultReport } from './validate.mjs';
import {
  assertQualKeyNotRetired, claimQualOp, findCache, findUncertain, markQualOp, qualSpendCapUsd,
  saveCache, sweepQualStale,
} from './admission.mjs';
import { preflightLiveRequest, runFixture, runLive } from './provider.mjs';
import { worstCaseSpendMicroUsd } from './constants.mjs';

function receiptFor({ key, live, out, elapsedMs, replay, env }) {
  return {
    opKey: key,
    mode: live ? 'live' : 'fixture',
    model: live ? out.model : 'fixture',
    responseId: live ? out.responseId : null,
    usage: live ? out.usage : null,
    spendUsdEst: live ? out.spendUsdEst : 0,
    elapsedMs,
    schemaVersion: QUAL_SCHEMA,
    validation: 'pass',
    replay: !!replay,
    deliveredAt: new Date().toISOString(),
    sourceSha: (env && typeof env.QUAL_SOURCE_SHA === 'string' && env.QUAL_SOURCE_SHA) || 'unknown',
  };
}

async function getOp(db, tenant, opKey) {
  const row = await first(db, 'SELECT input_digest, state, advice_json, receipt_json FROM qualification_recommendations WHERE owner_id = ? AND op_key = ?', tenant, opKey);
  if (!row) return null;
  let receipt = null;
  try { receipt = row.receipt_json ? JSON.parse(row.receipt_json) : null; } catch { receipt = null; }
  let advice = null;
  try { advice = row.advice_json ? JSON.parse(row.advice_json) : null; } catch { advice = null; }
  return { digest: row.input_digest, state: row.state, receipt, advice };
}

/**
 * Owner POST /api/resources/:id/qualification. Resolves node + latest
 * capability snapshot under authoritative ownership; serves the stable
 * cache (same owner/node/profile/catalog/prompt/mode) without spending or
 * calling; persists recommendation + one benchmark assignment on delivery.
 */
export async function handleQualificationPost({ db, env, ownerId, resourceId, body, now = new Date(), clock = null, fetchImpl, demo = false } = {}) {
  const { opKey } = checkQualificationBody(body);
  const key = opKey || rid('qop_');
  const resource = await first(db, 'SELECT * FROM resources WHERE id = ? AND owner_id = ?', resourceId, ownerId);
  if (!resource) throw httpError(404, 'Resource not found or not yours.', 'RESOURCE_NOT_FOUND');
  await assertQualKeyNotRetired(db, ownerId, key);
  const caps = await first(db, 'SELECT * FROM node_capabilities WHERE node_id = ?', resourceId);
  if (!caps) throw httpError(409, 'No capability snapshot for this node yet; the worker must report first.', 'QUAL_NO_SNAPSHOT');
  const profile = normalizeProfile(caps);
  const eligible = eligibleCatalog(profile);
  const live = qualificationLiveEnabled(env, { demo });
  const mode = live ? 'live' : 'fixture';
  // The digest binds node + stable profile + catalog/prompt + mode: the same
  // hardware on another node, or a fixture row for a live lookup, never hits.
  const digest = await canonicalProfileDigest(profile, { nodeId: resourceId, mode });
  const identity = { nodeId: resourceId, profileDigest: digest, catalogVersion: QUAL_CATALOG_VERSION, promptVersion: QUAL_PROMPT_VERSION, mode };
  await sweepQualStale(db, ownerId, now);
  // Same-key replay first: no spend, no provider contact.
  const same = await getOp(db, ownerId, key);
  if (same) {
    if (same.digest !== digest) throw httpError(409, 'Idempotency key was already used with a different request.', 'CHANGED_REPLAY');
    if (same.state === 'delivered') {
      const assignment = await existingAssignment(db, ownerId, resourceId, digest);
      return { status: 200, body: { advice: same.advice, assignment, receipt: { ...same.receipt, replay: true }, replay: true } };
    }
    if (same.state === 'failed') {
      const err = (same.receipt && same.receipt.error) || 'PROVIDER_ERROR';
      const saved = Number.isSafeInteger(same.receipt && same.receipt.status) ? same.receipt.status : 0;
      throw httpError(saved >= 400 && saved <= 599 ? saved : 502, 'The original qualification call failed; this replay makes no new provider call. Use a new key to retry.', err);
    }
    if (same.state === 'uncertain') throw httpError(409, 'This operation lost its provider response: outcome uncertain, no duplicate was sent. Use of this key is retained for reconciliation.', 'QUAL_UNCERTAIN');
    throw httpError(409, 'This operation is already running. Retry shortly with the same key.', 'OP_IN_PROGRESS');
  }
  // An uncertain outcome for this identity blocks new keys: no bypass.
  const blocked = await findUncertain(db, ownerId, identity);
  if (blocked) throw httpError(409, 'This node profile has an uncertain qualification outcome; it is retained for reconciliation and no duplicate call is sent. Resolve it before retrying.', 'QUAL_UNCERTAIN');
  // Stable cache: replay the saved advice without spending or calling. The
  // saved receipt is returned with replay marked; spend stays untouched.
  const cached = await findCache(db, ownerId, identity);
  if (cached) {
    let advice = null;
    try { advice = cached.advice_json ? JSON.parse(cached.advice_json) : null; } catch { advice = null; }
    let receipt = null;
    try { receipt = cached.receipt_json ? JSON.parse(cached.receipt_json) : null; } catch { receipt = null; }
    if (advice) {
      validateProviderAdvice(advice);
      const assignment = await existingAssignment(db, ownerId, resourceId, digest);
      return { status: 200, body: { advice, assignment, receipt: { ...receipt, replay: true }, replay: true, cached: true } };
    }
  }
  let inputTokens = 0;
  let spendMicro = 0;
  if (live) {
    const pre = preflightLiveRequest(profile, eligible, qualSpendCapUsd(env));
    inputTokens = pre.inputTokens;
    spendMicro = worstCaseSpendMicroUsd();
  }
  const clockFn = typeof clock === 'function' ? clock : () => new Date();
  const claim = await claimQualOp(db, ownerId, resourceId, digest, key, digest, {
    inputTokens, outputTokens: live ? QUAL_OUTPUT_MAX_TOKENS : 0, spendMicro, mode, env, clock: clockFn,
  });
  if (claim.outcome !== 'claimed') {
    // A first completion landed between our pre-checks and the reservation:
    // replay it without spending again. A delivered row without its cache
    // row (crash window) heals the cache on replay.
    if (claim.outcome === 'settled-replay' && claim.adviceJson) {
      let advice = null;
      try { advice = JSON.parse(claim.adviceJson); } catch { advice = null; }
      let receipt = null;
      try { receipt = claim.receiptJson ? JSON.parse(claim.receiptJson) : null; } catch { receipt = null; }
      if (advice) {
        validateProviderAdvice(advice);
        if (claim.from === 'delivered') {
          await saveCache(db, ownerId, { ...identity, adviceJson: claim.adviceJson, receiptJson: claim.receiptJson });
        }
        const assignment = await existingAssignment(db, ownerId, resourceId, digest);
        return { status: 200, body: { advice, assignment, receipt: { ...receipt, replay: true }, replay: true, cached: claim.from === 'cached' } };
      }
    }
    // A same-key race landed first: replay it without spending again.
    const raced = await getOp(db, ownerId, key);
    if (raced && raced.digest === digest && raced.state === 'delivered') {
      const assignment = await existingAssignment(db, ownerId, resourceId, digest);
      return { status: 200, body: { advice: raced.advice, assignment, receipt: { ...raced.receipt, replay: true }, replay: true } };
    }
    if (claim.outcome === 'uncertain') throw httpError(409, 'This operation lost its provider response: outcome uncertain, no duplicate was sent.', 'QUAL_UNCERTAIN');
    throw httpError(409, 'This operation is already running. Retry shortly with the same key.', 'OP_IN_PROGRESS');
  }
  const t0 = Date.now();
  if (!await markQualOp(db, ownerId, key, ['reserved'], 'fetching')) {
    await assertQualKeyNotRetired(db, ownerId, key);
    throw httpError(409, 'Qualification admission is no longer active.', 'OP_IN_PROGRESS');
  }
  try {
    let advice;
    let out = {};
    if (live) {
      if (typeof fetchImpl !== 'function') throw httpError(500, 'Live provider is not wired on this deployment.', 'PROVIDER_UNWIRED');
      out = await runLive({ fetchImpl, key: env.MODEL_API_KEY, profileFacts: profile, eligibleCatalog: eligible });
      advice = out.advice;
    } else {
      advice = runFixture(profile, eligible);
      validateProviderAdvice(advice);
    }
    const elapsedMs = Date.now() - t0;
    const receipt = receiptFor({ key, live, out, elapsedMs, replay: false, env });
    const delivered = await db.prepare(
      "UPDATE qualification_recommendations SET state = ?, advice_json = ?, receipt_json = ?, updated_at = ? WHERE owner_id = ? AND op_key = ? AND state = 'fetching'",
    ).bind('delivered', JSON.stringify(advice), JSON.stringify(receipt), new Date().toISOString(), ownerId, key).run();
    if (Number(delivered.meta.changes) !== 1) {
      await assertQualKeyNotRetired(db, ownerId, key);
      throw httpError(409, 'Qualification admission is no longer active.', 'OP_IN_PROGRESS');
    }
    await saveCache(db, ownerId, { ...identity, adviceJson: JSON.stringify(advice), receiptJson: JSON.stringify(receipt) });
    const assignment = await ensureAssignment(db, { ownerId, resourceId, digest, advice, mode });
    return { status: 200, body: { advice, assignment, receipt, replay: false } };
  } catch (e) {
    const status = Number.isSafeInteger(e?.status) ? e.status : 502;
    const code = typeof e?.code === 'string' ? e.code : 'PROVIDER_ERROR';
    if (live) {
      // Any live-path error is uncertain: a sent call may still bill.
      // The reservation is retained, nothing auto-retries, no new-key bypass.
      await markQualOp(db, ownerId, key, ['fetching'], 'uncertain', {
        error: code, status, billing: 'unknown', providerContact: e?.providerDiagnostic ? 'responded' : 'unknown',
        ...(code === 'PROVIDER_INCOMPLETE' && e?.providerDiagnostic ? { provider: e.providerDiagnostic } : {}),
      });
    } else {
      await markQualOp(db, ownerId, key, ['fetching'], 'failed', { error: code, status });
    }
    throw e;
  }
}

async function existingAssignment(db, ownerId, nodeId, digest) {
  return first(db, 'SELECT run_id, node_id, profile_digest, catalog_version, catalog_id, lease_id, state, assignment_json FROM qualification_runs WHERE owner_id = ? AND node_id = ? AND profile_digest = ? ORDER BY created_at DESC LIMIT 1', ownerId, nodeId, digest);
}

async function ensureAssignment(db, { ownerId, resourceId, digest, advice, mode = 'fixture' }) {
  const prior = await existingAssignment(db, ownerId, resourceId, digest);
  if (prior) return prior;
  if (!advice || advice.benchmarkCatalogId === 'unsupported') return null;
  const runId = rid('qrun_');
  const leaseId = rid('qlease_');
  const nowMs = Date.now();
  // deadlineAt here is queue freshness (claim-by), NOT the execution window:
  // the execution deadline is set when the worker lease is claimed.
  const assignment = {
    runId, nodeId: resourceId, profileDigest: digest,
    catalogVersion: QUAL_CATALOG_VERSION, catalogId: advice.benchmarkCatalogId,
    leaseId, deadlineAt: new Date(nowMs + QUAL_CLAIM_BY_MS).toISOString(),
    runtimeAllowlist: [...BENCH_RUNTIMES], maxTokens: BENCH_MAX_TOKENS,
  };
  const now = new Date().toISOString();
  // Conditional insert: concurrent deliveries for one identity converge on
  // a single assignment row instead of inserting duplicates.
  const inserted = await db.prepare(
    'INSERT INTO qualification_runs (run_id, owner_id, node_id, profile_digest, catalog_version, catalog_id, lease_id, state, mode, claim_by, execution_deadline, assignment_json, result_json, created_at, updated_at) '
    + 'SELECT ?, ?, ?, ?, ?, ?, ?, \'assigned\', ?, ?, NULL, ?, NULL, ?, ? '
    + 'WHERE NOT EXISTS (SELECT 1 FROM qualification_runs WHERE owner_id = ? AND node_id = ? AND profile_digest = ?)',
  ).bind(runId, ownerId, resourceId, digest, QUAL_CATALOG_VERSION, advice.benchmarkCatalogId, leaseId, mode, assignment.deadlineAt, JSON.stringify(assignment), now, now,
    ownerId, resourceId, digest).run();
  if (Number(inserted.meta.changes) === 1) {
    return { run_id: runId, node_id: resourceId, profile_digest: digest, catalog_version: QUAL_CATALOG_VERSION, catalog_id: advice.benchmarkCatalogId, lease_id: leaseId, state: 'assigned', assignment_json: JSON.stringify(assignment) };
  }
  return existingAssignment(db, ownerId, resourceId, digest);
}

/**
 * Owner GET /api/qualifications: owner-scoped report only. Rows re-check the
 * current authoritative resource owner, so a previous owner sees nothing
 * after a transfer. The stable cache is returned per node (so a pruned op
 * row never reads as "no recommendation"), plus each owned node's current
 * profile digest for honest stale computation.
 */
export async function handleQualificationsGet({ db, env = null, ownerId, demo = false } = {}) {
  const recs = await allRows(db, 'SELECT r.node_id, r.profile_digest, r.catalog_version, r.mode, r.state, r.advice_json, r.receipt_json, r.created_at, r.updated_at FROM qualification_recommendations r WHERE r.owner_id = ? AND EXISTS (SELECT 1 FROM resources WHERE id = r.node_id AND owner_id = ?) ORDER BY r.updated_at DESC LIMIT 50', ownerId, ownerId);
  const runs = await allRows(db, 'SELECT r.run_id, r.node_id, r.profile_digest, r.catalog_version, r.catalog_id, r.mode, r.state, r.result_json, r.created_at, r.updated_at FROM qualification_runs r WHERE r.owner_id = ? AND EXISTS (SELECT 1 FROM resources WHERE id = r.node_id AND owner_id = ?) ORDER BY r.updated_at DESC LIMIT 50', ownerId, ownerId);
  const cached = await allRows(db, 'SELECT c.node_id, c.profile_digest, c.catalog_version, c.prompt_version, c.mode, c.advice_json, c.receipt_json, c.updated_at FROM qualification_cache c WHERE c.owner_id = ? AND EXISTS (SELECT 1 FROM resources WHERE id = c.node_id AND owner_id = ?) ORDER BY c.updated_at DESC LIMIT 50', ownerId, ownerId);
  const nodes = await allRows(db, 'SELECT id AS node_id FROM resources WHERE owner_id = ? LIMIT 100', ownerId);
  const profiles = [];
  for (const n of nodes) {
    const caps = await first(db, 'SELECT * FROM node_capabilities WHERE node_id = ?', n.node_id);
    if (!caps) {
      profiles.push({ node_id: n.node_id, profile_digest: null, has_snapshot: false });
      continue;
    }
    const profile = normalizeProfile(caps);
    // Current digests for both modes: the fixture digest is the panel
    // default, the live digest lets live rows prove currency too.
    const digest = await canonicalProfileDigest(profile, { nodeId: n.node_id, mode: 'fixture' });
    const digestLive = await canonicalProfileDigest(profile, { nodeId: n.node_id, mode: 'live' });
    profiles.push({ node_id: n.node_id, profile_digest: digest, profile_digest_live: digestLive, has_snapshot: true });
  }
  // Live flag so the panel can offer a live fetch when only fixture advice
  // exists; the request button always runs the server's current mode. Demo
  // sessions always get fixtures, so they never see a live offer.
  return { status: 200, body: { recommendations: recs, runs, cached, profiles, live: qualificationLiveEnabled(env, { demo }) } };
}

async function allRows(db, sql, ...params) {
  if (db && typeof db.prepare === 'function') {
    const stmt = db.prepare(sql).bind(...params);
    if (typeof stmt.all === 'function') {
      const out = await stmt.all();
      return out.results || [];
    }
  }
  return [];
}

/**
 * Check the heartbeat key is still valid and the resource is still owned by
 * the key's owner: transfer or revocation refuses closed.
 */
async function checkWorkerBinding(db, ownerId, resourceId, keyId) {
  if (keyId) {
    const keyRow = await first(db, 'SELECT revoked_at FROM key_verifiers WHERE id = ?', keyId);
    if (!keyRow || keyRow.revoked_at) throw httpError(401, 'API key revoked.', 'KEY_REVOKED');
  }
  const resource = await first(db, 'SELECT owner_id FROM resources WHERE id = ?', resourceId);
  if (!resource || resource.owner_id !== ownerId) throw httpError(404, 'Resource not found or not yours.', 'NOT_FOUND');
  return resource;
}

/**
 * Worker GET next assignment: heartbeat-key identity {ownerId, resourceId}.
 * Rechecks revocation, current ownership and capability freshness before
 * leasing. The execution deadline is set at claim time.
 */
export async function handleWorkerNext({ db, ownerId, resourceId, keyId = null } = {}) {
  await checkWorkerBinding(db, ownerId, resourceId, keyId);
  const row = await first(db, 'SELECT * FROM qualification_runs WHERE owner_id = ? AND node_id = ? AND state = \'assigned\' ORDER BY created_at ASC LIMIT 1', ownerId, resourceId);
  if (!row) {
    // Recovery poll: a leased run past its execution deadline gets one more
    // delivery so the worker can settle it. The worker posts uncertain when
    // its ledger shows a prior handoff, or timed_out when the window elapsed
    // before execution. The result handler still enforces deadline+grace and
    // binding on that post; a late arrival becomes retained-uncertain. Runs
    // inside their window are never double-dispatched. Recovery never
    // executes: the worker ledger decides.
    const stale = await first(db, 'SELECT * FROM qualification_runs WHERE owner_id = ? AND node_id = ? AND state = \'leased\' AND execution_deadline IS NOT NULL AND execution_deadline < ? ORDER BY updated_at ASC LIMIT 1', ownerId, resourceId, new Date().toISOString());
    if (!stale) return { status: 204, body: null };
    let assignment = null;
    try { assignment = stale.assignment_json ? JSON.parse(stale.assignment_json) : null; } catch { assignment = null; }
    return { status: 200, body: { assignment, leaseId: stale.lease_id, runId: stale.run_id, executionDeadline: stale.execution_deadline, deadlineMs: BENCH_DEADLINE_MS, recovered: true } };
  }
  if (row.claim_by && Date.parse(row.claim_by) < Date.now()) {
    await db.prepare('UPDATE qualification_runs SET state = \'uncertain\', result_json = ?, updated_at = ? WHERE run_id = ? AND state = \'assigned\'')
      .bind(JSON.stringify({ reason: 'assignment queue window elapsed before lease; never executed' }), new Date().toISOString(), row.run_id).run();
    throw httpError(409, 'Assignment queue window elapsed; the run is retained as uncertain, never executed.', 'QUAL_STALE_QUEUE');
  }
  const caps = await first(db, 'SELECT * FROM node_capabilities WHERE node_id = ?', resourceId);
  if (!caps) throw httpError(409, 'Capability snapshot missing; refusing lease.', 'QUAL_STALE_SNAPSHOT');
  const mode = row.mode === 'live' ? 'live' : 'fixture';
  const digest = await canonicalProfileDigest(normalizeProfile(caps), { nodeId: resourceId, mode });
  if (digest !== row.profile_digest) {
    await db.prepare('UPDATE qualification_runs SET state = \'uncertain\', result_json = ?, updated_at = ? WHERE run_id = ? AND state = \'assigned\'')
      .bind(JSON.stringify({ reason: 'profile changed before lease; assignment invalidated' }), new Date().toISOString(), row.run_id).run();
    throw httpError(409, 'Node inventory changed; assignment invalidated.', 'QUAL_PROFILE_CHANGED');
  }
  const executionDeadline = new Date(Date.now() + BENCH_DEADLINE_MS).toISOString();
  const leased = await db.prepare('UPDATE qualification_runs SET state = \'leased\', execution_deadline = ?, updated_at = ? WHERE run_id = ? AND state = \'assigned\'')
    .bind(executionDeadline, new Date().toISOString(), row.run_id).run();
  if (Number(leased.meta.changes) !== 1) throw httpError(409, 'Assignment already claimed.', 'QUAL_ALREADY_LEASED');
  let assignment = null;
  try { assignment = row.assignment_json ? JSON.parse(row.assignment_json) : null; } catch { assignment = null; }
  return { status: 200, body: { assignment, leaseId: row.lease_id, runId: row.run_id, executionDeadline, deadlineMs: BENCH_DEADLINE_MS } };
}

/**
 * Ready model ids for one worker transport from a capability snapshot, or
 * null when no evidence exists (unknown, never a refusal). Lookup is keyed
 * by MODE, never merged across modes: the attach transport (`ganglion`)
 * unions ready models across attach entries only, and the managed transport
 * (`llama-server`) across managed llama-server entries only. Accepts the
 * flat id list and the {model_id, ready} shapes.
 */
export function snapshotReadyModels(capsRow, runtimeId) {
  const wantMode = runtimeId === 'ganglion' ? 'attach' : runtimeId === 'llama-server' ? 'managed' : null;
  if (!wantMode) return null;
  try {
    const raw = capsRow && (capsRow.runtimes_json ?? capsRow.runtimes);
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(list)) return null;
    const ids = new Set();
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.mode === 'attach' || entry.mode === 'managed') {
        if (entry.mode !== wantMode) continue;
        if (wantMode === 'managed' && entry.name !== 'llama-server') continue;
      } else if (entry.name !== runtimeId && entry.runtime_id !== runtimeId) {
        continue;
      }
      if (!Array.isArray(entry.models)) continue;
      for (const m of entry.models) {
        if (typeof m === 'string' && m) ids.add(m);
        else if (m && typeof m === 'object' && typeof m.model_id === 'string' && m.model_id && m.ready !== false) ids.add(m.model_id);
      }
    }
    return ids.size ? ids : null;
  } catch {
    return null;
  }
}

/**
 * Worker POST result: strict lease/node/owner/profile/catalog/runtime/
 * deadline binding. Only leased runs accept results; late or changed-profile
 * results become uncertain (retained, never auto-rerun). An old lease never
 * reports as the current benchmark: any non-leased state replays or refuses.
 */
export async function handleWorkerResult({ db, ownerId, resourceId, runId, body, keyId = null } = {}) {
  const report = validateWorkerResultReport(body);
  await checkWorkerBinding(db, ownerId, resourceId, keyId);
  const row = await first(db, 'SELECT * FROM qualification_runs WHERE run_id = ? AND owner_id = ? AND node_id = ?', runId, ownerId, resourceId);
  if (!row) throw httpError(404, 'Benchmark run not found.', 'NOT_FOUND');
  if (row.lease_id !== report.leaseId) throw httpError(403, 'Lease binding mismatch.', 'QUAL_LEASE_MISMATCH');
  if (['succeeded', 'failed', 'timed_out', 'unsupported'].includes(row.state)) {
    return { status: 200, body: { runId, state: row.state, replay: true } };
  }
  if (row.state === 'uncertain') {
    throw httpError(409, 'This run already reached an uncertain terminal state; it is retained for reconciliation and never auto-rerun.', 'QUAL_UNCERTAIN');
  }
  if (row.state !== 'leased') throw httpError(409, 'Run is not leased; an old or unclaimed assignment never accepts results.', 'QUAL_NOT_LEASED');
  if (row.execution_deadline && Date.now() > Date.parse(row.execution_deadline) + QUAL_RESULT_GRACE_MS) {
    await db.prepare('UPDATE qualification_runs SET state = \'uncertain\', result_json = ?, updated_at = ? WHERE run_id = ? AND state = \'leased\'')
      .bind(JSON.stringify({ reason: 'result arrived after the execution deadline plus grace; not accepted as current' }), new Date().toISOString(), runId).run();
    throw httpError(409, 'Result arrived after the execution deadline; retained as uncertain, never accepted as current.', 'QUAL_LATE_RESULT');
  }
  // No result binds without a current snapshot: a vanished snapshot leaves
  // the run retained-uncertain, never silently accepted.
  const caps = await first(db, 'SELECT * FROM node_capabilities WHERE node_id = ?', resourceId);
  if (!caps) {
    await db.prepare('UPDATE qualification_runs SET state = \'uncertain\', result_json = ?, updated_at = ? WHERE run_id = ? AND state = \'leased\'')
      .bind(JSON.stringify({ reason: 'capability snapshot missing at result; measurement unbound' }), new Date().toISOString(), runId).run();
    throw httpError(409, 'Capability snapshot missing at result; measurement retained as uncertain.', 'QUAL_STALE_SNAPSHOT');
  }
  {
    const mode = row.mode === 'live' ? 'live' : 'fixture';
    const digest = await canonicalProfileDigest(normalizeProfile(caps), { nodeId: resourceId, mode });
    if (digest !== row.profile_digest) {
      await db.prepare('UPDATE qualification_runs SET state = \'uncertain\', result_json = ?, updated_at = ? WHERE run_id = ? AND state = \'leased\'')
        .bind(JSON.stringify({ reason: 'profile changed between lease and result; measurement is stale' }), new Date().toISOString(), runId).run();
      throw httpError(409, 'Node inventory changed between lease and result; measurement retained as uncertain.', 'QUAL_PROFILE_CHANGED');
    }
  }
  if (report.status === 'succeeded') {
    let assignment = null;
    try { assignment = row.assignment_json ? JSON.parse(row.assignment_json) : null; } catch { assignment = null; }
    const allow = assignment && Array.isArray(assignment.runtimeAllowlist) ? assignment.runtimeAllowlist : [];
    if (!allow.includes(report.result.runtimeId)) throw httpError(403, 'Result runtime is outside the assignment binding.', 'QUAL_RUNTIME_MISMATCH');
    // Model echo: the snapshot must carry ready-model evidence for this
    // runtime and the reported model must be among it. Absent evidence
    // cannot bind a succeeded result to an unknown snapshot: fail closed
    // as explicit unsupported, never silent acceptance.
    const ready = snapshotReadyModels(caps, report.result.runtimeId);
    if (!ready) {
      await db.prepare('UPDATE qualification_runs SET state = \'unsupported\', result_json = ?, updated_at = ? WHERE run_id = ? AND state = \'leased\'')
        .bind(JSON.stringify({ reason: 'snapshot carries no ready-model evidence; unverifiable measurement' }), new Date().toISOString(), runId).run();
      return { status: 200, body: { runId, state: 'unsupported', replay: false } };
    }
    if (!ready.has(report.result.modelId)) throw httpError(403, 'Result model is not in the snapshot ready-model evidence.', 'QUAL_MODEL_MISMATCH');
  }
  const terminal = report.status === 'succeeded' ? 'succeeded'
    : report.status === 'failed' ? 'failed'
      : report.status === 'timed_out' ? 'timed_out'
        : report.status === 'unsupported' ? 'unsupported' : 'uncertain';
  const out = await db.prepare('UPDATE qualification_runs SET state = ?, result_json = ?, updated_at = ? WHERE run_id = ? AND state = \'leased\'')
    .bind(terminal, JSON.stringify(report.result), new Date().toISOString(), runId).run();
  if (Number(out.meta.changes) !== 1) {
    const cur = await first(db, 'SELECT state FROM qualification_runs WHERE run_id = ?', runId);
    return { status: 200, body: { runId, state: cur?.state || terminal, replay: true } };
  }
  return { status: 200, body: { runId, state: terminal, replay: false } };
}

export { QUAL_PROMPT_VERSION };

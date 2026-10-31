/* Built with Meta Muse. */
// Fabric adviser routes: GET descriptor + POST advice. Session-gated,
// CSRF-gated, flag-gated; demo sessions get fixtures only. Owned resources
// resolve to a redacted snapshot; admission (budgets + op machine) runs
// before any provider contact; outputs validate strictly before delivery.
// Inference dispatch stays untouched: advice is text, never execution.
import { first, rid } from '../lib/store.js';
import { httpError } from '../lib/validate.js';
import {
  ADVISOR_SCHEMA, ADVISOR_TASK_MAX, ADVISOR_REFS_MAX, ADVISOR_BODY_MAX,
  ADVISOR_RESTRICTIONS, checkAdvisorBody, buildSnapshot, validateAdvice, canonicalDigest,
} from './validate.mjs';
import { claimOp, markOp, advisorSpendCapUsd } from './admission.mjs';
import {
  ADVISOR_MODEL, ADVISOR_OUTPUT_MAX_TOKENS, ADVISOR_INPUT_TOKEN_BOUND,
  liveEnabled, runFixture, runLive, preflightLiveRequest,
} from './provider.mjs';

export function advisorEnabled(env) {
  return !!env && env.ADVISOR_ENABLED === '1';
}

/** Read-only contract descriptor: the opt-in preview renders from this, never from client constants. */
export function advisorDescriptor(env, { demo = false } = {}) {
  const live = liveEnabled(env, { demo });
  return {
    schema: ADVISOR_SCHEMA,
    mode: live ? 'live' : 'fixture',
    bounds: {
      taskMax: ADVISOR_TASK_MAX, refsMax: ADVISOR_REFS_MAX, bodyMaxBytes: ADVISOR_BODY_MAX,
      inputTokenBound: ADVISOR_INPUT_TOKEN_BOUND, outputTokensMax: ADVISOR_OUTPUT_MAX_TOKENS,
    },
    outboundFields: [
      'task', 'snapshot.entries[].ref', 'snapshot.entries[].kind', 'snapshot.entries[].liveness',
      'snapshot.entries[].telemetry', 'snapshot.entries[].caps', 'snapshot.entries[].usable',
      'snapshot.restrictions',
    ],
    restrictions: [...ADVISOR_RESTRICTIONS],
    model: live ? ADVISOR_MODEL : 'fixture',
    inferenceDispatch: 'disabled',
    spendCapUsd: advisorSpendCapUsd(env),
  };
}

function receiptFor({ key, live, out, elapsedMs, replay, env }) {
  return {
    opKey: key,
    mode: live ? 'live' : 'fixture',
    model: live ? out.model : 'fixture',
    responseId: live ? out.responseId : null,
    usage: live ? out.usage : null,
    spendUsdEst: live ? out.spendUsdEst : 0,
    elapsedMs,
    schemaVersion: ADVISOR_SCHEMA,
    validation: 'pass',
    replay: !!replay,
    deliveredAt: new Date().toISOString(),
    sourceSha: (env && typeof env.ADVISOR_SOURCE_SHA === 'string' && env.ADVISOR_SOURCE_SHA) || 'unknown',
  };
}

export async function handleAdvisorPost({ db, env, actor, demo = false, body, now = new Date(), admissionNow = null, fetchImpl } = {}) {
  const tenant = actor.user.id;
  const { task, refs, opKey } = checkAdvisorBody(body);
  const key = opKey || rid('op_');
  // Owned-only resolution. Unknown and foreign ids answer identically.
  const rows = [];
  for (const id of refs) {
    const row = await first(db, 'SELECT * FROM resources WHERE id = ? AND owner_id = ?', id, tenant);
    if (!row) throw httpError(404, 'Resource not found or not yours.', 'RESOURCE_NOT_FOUND');
    rows.push(row);
  }
  const snapshot = buildSnapshot(rows, now.getTime());
  const aliases = snapshot.entries.map((e) => e.ref);
  // The digest binds task + refs + redacted entries only: generatedAt is
  // volatile by design and must never split an idempotent retry.
  const digest = await canonicalDigest({ task, refs, entries: snapshot.entries });
  const live = liveEnabled(env, { demo });
  // Pre-claim fail-closed checks: bounds and spend are verified before any
  // budget is touched, so rejections charge nothing and write nothing.
  let inputTokens = 0;
  if (live) {
    inputTokens = preflightLiveRequest(snapshot, task, advisorSpendCapUsd(env)).inputTokens;
  }
  // Admission uses the DECISION instant, never arrival time: the async
  // resource reads above can stall across a UTC-hour boundary, and a new
  // hour's claim prunes older buckets immediately. Judging a delayed
  // request against its arrival hour would read pruned (zero) counters for
  // exhausted budgets and admit a provider call it must not make. The
  // decision instant feeds bucket selection, charging, pruning and op
  // timestamps from one value, so the admission operation and the selected
  // bucket cannot disagree. Tests pin the clock via admissionNow.
  const atDecision = admissionNow instanceof Date && !Number.isNaN(admissionNow.getTime()) ? admissionNow : new Date();
  const claim = await claimOp(db, tenant, key, digest, {
    inputTokens, outputTokens: live ? ADVISOR_OUTPUT_MAX_TOKENS : 0, env, now: atDecision,
  });
  if (claim.outcome === 'replay') {
    if (!live) {
      // Fixtures are deterministic and free: recompute the identical advice.
      const advice = runFixture(snapshot, task);
      validateAdvice(advice, { refs: aliases });
      return { status: 200, body: { advice, receipt: receiptFor({ key, live, out: {}, elapsedMs: 0, replay: true, env }), replay: true } };
    }
    if (claim.state === 'failed') {
      // A failed op replays its stored failure, never a success-shaped
      // receipt: no new provider call, and the caller keeps the actionable
      // error and code. Status/code come from our own stored receipt.
      const err = claim.receipt && typeof claim.receipt.error === 'string' && claim.receipt.error ? claim.receipt.error : 'PROVIDER_ERROR';
      const saved = claim.receipt && Number.isSafeInteger(claim.receipt.status) ? claim.receipt.status : 0;
      const status = saved >= 400 && saved <= 599 ? saved : 502;
      throw httpError(status, `The original advice call failed (${err}); this replay makes no new provider call. Use a new key to retry.`, err);
    }
    return { status: 200, body: { advice: null, receipt: { ...claim.receipt, replay: true }, replay: true, note: 'Advice outputs are not stored; this replay returns the original receipt only.' } };
  }
  if (claim.outcome === 'in-progress') {
    throw httpError(409, 'This operation is already running. Retry shortly with the same key.', 'OP_IN_PROGRESS');
  }
  if (claim.outcome === 'uncertain') {
    throw httpError(409, 'This operation lost its provider response: outcome uncertain, no duplicate was sent, no automatic refund. Use a new key to retry.', 'ADVISOR_UNCERTAIN');
  }
  const t0 = Date.now();
  const marked = await markOp(db, tenant, key, ['reserved'], 'fetching');
  if (!marked.ok) throw httpError(500, 'Advice operation changed state unexpectedly.', 'ADVISOR_STATE');
  if (!live) {
    const advice = runFixture(snapshot, task);
    validateAdvice(advice, { refs: aliases });
    const receipt = receiptFor({ key, live, out: {}, elapsedMs: Date.now() - t0, replay: false, env });
    await markOp(db, tenant, key, ['fetching'], 'delivered', receipt);
    return { status: 200, body: { advice, receipt, replay: false } };
  }
  try {
    const out = await runLive({ fetchImpl, apiKey: env.MODEL_API_KEY, snapshot, task, refs: aliases, spendCapUsd: advisorSpendCapUsd(env) });
    const receipt = receiptFor({ key, live, out, elapsedMs: Date.now() - t0, replay: false, env });
    await markOp(db, tenant, key, ['fetching'], 'delivered', receipt);
    return { status: 200, body: { advice: out.advice, receipt, replay: false } };
  } catch (e) {
    // A lost response (timeout, unreachable) leaves the outcome uncertain:
    // never a silent duplicate, never an automatic refund. Definitive
    // failures (rejections, malformed output, exhausted caps) close failed.
    const uncertain = e && (e.code === 'PROVIDER_TIMEOUT' || e.code === 'PROVIDER_UNREACHABLE');
    await markOp(db, tenant, key, ['fetching'], uncertain ? 'uncertain' : 'failed', {
      opKey: key, mode: 'live', error: e && e.code ? e.code : 'PROVIDER_ERROR',
      status: e && Number.isSafeInteger(e.status) ? e.status : 502, at: new Date().toISOString(),
    });
    throw e;
  }
}

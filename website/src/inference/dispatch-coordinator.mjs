// INTERNAL server-side admitted-dispatch coordinator (offline slice).
//
// Not a route, not a deployed endpoint and not authority. worker.js does not
// import it, and POST /api/jobs stays 501. Every dependency is injected:
//   resolvePrincipal(authContext) - trusted server resolver over the existing
//                                   session/API-key boundary (never client data)
//   authority                     - ONE atomic authority store boundary: admission
//                                   records, live grants, principal-scoped
//                                   operations, budget holds, the final admission
//                                   CAS, start redemption, fencing and settlement
//   transport                     - bound CPU task dispatch/poll by job id
// The production default (no arguments) has none of them and refuses.
//
// Invariants (docs/eif-atomic-admission-contract.md, rc3 bf5b5b7 NOT FROZEN):
// - The principal comes only from the injected resolver. Client fields that
//   claim authority (authenticated, receipts, grants, placement...) are forged.
// - One grant covers the whole operation (fabric/policy.mjs matchGrant, no
//   stitching), with strict status === 'enforced' && revoked === false and an
//   exact revision.
// - Idempotency is principal-scoped: op_key = JSON.stringify([principal, key]).
//   Same key + same digest reconciles; a changed digest conflicts.
// - The admission CAS is the linearization point and must attest every exact
//   operation-owned hold and the live authority revision in the same store
//   step. Separate check calls are advisory pre-checks only.
// - Start redemption serializes with revoke in that same store.
// - Any unknown admission/start/dispatch/result outcome is retained as
//   uncertain, with holds, and is never replayed automatically. Cancellation,
//   deadline or connection loss never claims the remote stopped.
// - Pre-start release happens only after the start is fenced.
// - The current nonstreaming contract has no execution cancel; cancel after
//   start is reported as an unsupported capability.
import { encodeBoundCpuTask, encodeCpuTask, decodeCpuTask } from './eif-task-contract.mjs';
import { matchGrant } from '../fabric/policy.mjs';
import { digestJson } from '../fabric/canonical.mjs';

export const DISPATCH_COORDINATOR_INTERFACE = 'aipster-dispatch-coordinator/1';
export const CONTRACT_VERSION = 'v1.0.0';
export const TRANSPORT_PROTOCOL = 'aipster-bound-cpu-internal/1';
export const MAX_DEADLINE_MS = 180000;
const MIN_EPOCH_MS = 1700000000000;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const ALLOWED_FIELDS = new Set(['contract_version', 'admission_ref', 'idempotency_key', 'model_id',
  'prompt', 'max_tokens', 'deadline_at']);
// Fields through which a client could try to assert identity, admission,
// grants, budget or placement. The target comes only from durable admitted
// state resolved server-side; it is never taken from the request body.
const FORGED_FIELDS = new Set(['authenticated', 'principal', 'principal_id', 'tenant_id', 'actor',
  'admission', 'admission_receipt', 'receipt', 'server_admission_receipt', 'grant', 'grant_id',
  'grant_revision', 'server_context', 'serverContext', 'context', 'placement', 'node_id', 'runtime_id',
  'runtime_instance', 'model_fingerprint', 'pools', 'holds', 'budget', 'operation_id', 'op_id', 'generation']);
const UNSUPPORTED_PARAMETERS = new Set(['temperature', 'top_p', 'top_k', 'seed', 'stop']);
const UNSUPPORTED_CAPABILITIES = new Set(['stream', 'cancel', 'tools', 'tool_choice']);

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string' && x.length > 0 && x.length <= 256;
const isGen = (x) => Number.isSafeInteger(x) && x >= 1;

function result(status, fields = {}) {
  return { status, remote_stopped: false, automatic_retry: false, ...fields };
}
const reject = (code, http, extra = {}) => result('rejected', { code, http, ...extra });
const uncertain = (phase, code, extra = {}) => result('uncertain', { phase, code, http: 503, ...extra });

class Unknown extends Error {
  // Keep the store's stable code/status so a defined refusal (for example the
  // DISPATCH_LIMIT cap) can reach the route instead of becoming uncertain.
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
// Await a store/transport call; any throw is an unknown outcome, never success.
async function call(fn, ...args) {
  try {
    return await fn(...args);
  } catch (err) {
    throw new Unknown(err && err.message ? err.message : 'unknown outcome',
      err && err.code, err && err.status);
  }
}

function validateBody(body) {
  if (!isObj(body)) return reject('INVALID_REQUEST', 400);
  const keys = Object.keys(body);
  if (keys.some((k) => FORGED_FIELDS.has(k))) return reject('FORGED_CLIENT_AUTHORITY', 400);
  if (body.contract_version !== CONTRACT_VERSION) return reject('UNSUPPORTED_CONTRACT_VERSION', 400);
  if (keys.some((k) => UNSUPPORTED_PARAMETERS.has(k))) return reject('UNSUPPORTED_PARAMETER', 400);
  if (keys.some((k) => UNSUPPORTED_CAPABILITIES.has(k))) return reject('UNSUPPORTED_CAPABILITY', 400);
  if (keys.some((k) => !ALLOWED_FIELDS.has(k))) return reject('UNSUPPORTED_FIELD', 400);
  if (typeof body.admission_ref !== 'string' || !REF_RE.test(body.admission_ref)) return reject('INVALID_REQUEST', 400);
  if (typeof body.idempotency_key !== 'string' || !KEY_RE.test(body.idempotency_key)) return reject('INVALID_REQUEST', 400);
  try {
    // Reuse the codec's own task validation (model, prompt, token bounds).
    encodeCpuTask({ modelId: body.model_id, prompt: body.prompt, maxTokens: body.max_tokens,
      operationKey: body.idempotency_key });
  } catch {
    return reject('INVALID_REQUEST', 400);
  }
  return null;
}

function validateDeadline(deadline, now) {
  return Number.isSafeInteger(deadline) && deadline >= MIN_EPOCH_MS && deadline > now
    && deadline - now <= MAX_DEADLINE_MS;
}

function validatePrincipal(p) {
  if (!isObj(p) || !isStr(p.principal_id) || !isStr(p.tenant_id)) return reject('AUTH_REQUIRED', 401);
  if (p.actor_kind === 'session') return null;
  if (p.actor_kind === 'key') {
    // Mirrors worker.js needAuthz('inference') semantics for a resolved key;
    // it does not replace or weaken the worker's own checks.
    if (p.expired === true) return reject('KEY_EXPIRED', 401);
    if (p.key_scope === 'inference') return null;
    return reject('KEY_SCOPE', 403);
  }
  return reject('AUTH_REQUIRED', 401);
}

const ADMISSION_FIELDS = ['admission_ref', 'principal_id', 'tenant_id', 'grant_id', 'resource_id',
  'incarnation', 'peer_node', 'peer_workspace', 'route', 'node_id', 'runtime_id', 'runtime_instance',
  'model_id', 'model_fingerprint'];

function validAdmission(a) {
  return isObj(a) && ADMISSION_FIELDS.every((k) => isStr(a[k])) && isGen(a.grant_revision)
    && Number.isSafeInteger(a.max_tokens) && a.max_tokens >= 1 && Number.isSafeInteger(a.expires_at)
    && Array.isArray(a.pools) && a.pools.length >= 1
    && a.pools.every((p) => isObj(p) && isStr(p.pool_id) && Number.isSafeInteger(p.amount) && p.amount > 0)
    && new Set(a.pools.map((p) => p.pool_id)).size === a.pools.length;
}

function validOp(op) {
  return isObj(op) && typeof op.op_id === 'string' && KEY_RE.test(op.op_id) && isGen(op.generation)
    && typeof op.request_digest === 'string' && isObj(op.binding) && typeof op.phase === 'string';
}

// Server-private binding: derived only from the resolved admission record.
function bindingOf(admission, principal, deadlineAt) {
  return {
    admission_ref: admission.admission_ref, principal_id: principal.principal_id, tenant_id: principal.tenant_id,
    grant_id: admission.grant_id, grant_revision: admission.grant_revision,
    resource_id: admission.resource_id, incarnation: admission.incarnation,
    node_id: admission.node_id, runtime_id: admission.runtime_id, runtime_instance: admission.runtime_instance,
    model_id: admission.model_id, model_fingerprint: admission.model_fingerprint,
    pools: admission.pools.map((p) => ({ pool_id: p.pool_id, amount: p.amount })),
    deadline_at: deadlineAt,
  };
}

export function createDispatchCoordinator({ resolvePrincipal = null, authority = null, transport = null,
  now = () => Date.now() } = {}) {
  const blockedBy = [
    ...(typeof resolvePrincipal === 'function' ? [] : ['NO_PRINCIPAL_RESOLVER']),
    ...(isObj(authority) ? [] : ['NO_AUTHORITY_STORE']),
    ...(isObj(transport) ? [] : ['NO_TRANSPORT']),
  ];
  const unavailable = () => reject('DISPATCH_UNAVAILABLE', 503, { blocked_by: [...blockedBy] });

  async function principalFor(authContext) {
    let p;
    try { p = await resolvePrincipal(authContext); } catch { return { refusal: reject('AUTH_REQUIRED', 401) }; }
    const refusal = validatePrincipal(p);
    return refusal ? { refusal } : { principal: { principal_id: p.principal_id, tenant_id: p.tenant_id } };
  }

  function transportSupported() {
    const c = transport && transport.capabilities;
    return isObj(c) && c.protocol === TRANSPORT_PROTOCOL && c.instance_pin === true && c.deadline === true;
  }

  async function markUncertain(op, phase, detail) {
    try {
      await authority.markUncertain({ op_id: op.op_id, generation: op.generation, phase, detail: String(detail).slice(0, 200) });
    } catch { /* the operation stays uncertain in this response regardless */ }
  }

  // Fence the start, then release only this operation's holds. Without a
  // confirmed fence nothing is released.
  async function fenceAndRelease(op, reason) {
    let fence;
    try { fence = await call(authority.fenceStart, { op_id: op.op_id, generation: op.generation }); }
    catch (e) { await markUncertain(op, 'fence', e.message); return false; }
    if (!isObj(fence) || fence.outcome !== 'fenced') {
      await markUncertain(op, 'fence', isObj(fence) ? String(fence.outcome) : 'malformed');
      return false;
    }
    try { await call(authority.releaseHolds, { op_id: op.op_id, generation: op.generation, reason }); }
    catch (e) { await markUncertain(op, 'release', e.message); return false; }
    return true;
  }

  async function releaseUnadmitted(op, reason) {
    try { await call(authority.releaseHolds, { op_id: op.op_id, generation: op.generation, reason }); return true; }
    catch (e) { await markUncertain(op, 'release', e.message); return false; }
  }

  // Read-only view of a recorded operation. Never advances an unknown step.
  function viewOf(op) {
    const base = { op_id: op.op_id, job_id: op.job_id || undefined, store_phase: op.phase };
    if (op.settled && isObj(op.settled)) return result('settled', { ...base, outcome: { finish: op.settled.outcome } });
    if (op.uncertain) return uncertain(op.uncertain.phase, 'OUTCOME_UNCERTAIN', base);
    if (op.phase === 'dispatched') return result('dispatched', base);
    if (op.phase === 'released') return result('released', { ...base, code: 'NOT_ADMITTED' });
    return result('pending', { ...base, code: 'OPERATION_IN_PROGRESS', http: 409 });
  }

  async function submit(authContext, body) {
    if (blockedBy.length) return unavailable();
    const { principal, refusal } = await principalFor(authContext);
    if (refusal) return refusal;
    const invalid = validateBody(body);
    if (invalid) return invalid;
    const t0 = now();
    if (!validateDeadline(body.deadline_at, t0)) return reject('INVALID_DEADLINE', 400);
    if (!transportSupported()) return reject('TARGET_CAPABILITY_UNSUPPORTED', 501);

    // Server-stored admission lookup (opaque reference; never client data).
    let admission;
    try { admission = await call(authority.resolveAdmission, { principal, admission_ref: body.admission_ref }); }
    catch { return uncertain('lookup', 'AUTHORITY_UNAVAILABLE', { http: 503 }); }
    if (!validAdmission(admission) || admission.admission_ref !== body.admission_ref
      || admission.principal_id !== principal.principal_id || admission.tenant_id !== principal.tenant_id) {
      return reject('ADMISSION_NOT_AVAILABLE', 403);
    }
    if (admission.expires_at <= t0 || body.deadline_at > admission.expires_at) return reject('ADMISSION_EXPIRED', 403);
    if (body.model_id !== admission.model_id || body.max_tokens > admission.max_tokens) {
      return reject('BINDING_MISMATCH', 403);
    }

    // Advisory live pre-check with the existing no-stitching matcher. It is
    // not the admission decision; the CAS re-pins the same revision.
    let grant;
    try { grant = await call(authority.readGrant, { grant_id: admission.grant_id }); }
    catch { return uncertain('lookup', 'AUTHORITY_UNAVAILABLE', { http: 503 }); }
    const grantRequest = {
      resourceId: admission.resource_id, incarnation: admission.incarnation, action: 'inference',
      model: admission.model_id, peerNode: admission.peer_node, peerWorkspace: admission.peer_workspace,
      consumer: principal.principal_id, maxTokens: body.max_tokens, route: admission.route,
      at: new Date(t0).toISOString(), expectedRevision: admission.grant_revision,
    };
    if (!isObj(grant) || grant.id !== admission.grant_id || grant.revoked !== false
      || !matchGrant(grantRequest, grant, [])) {
      return reject('NO_MATCHING_GRANT', 403);
    }

    const binding = bindingOf(admission, principal, body.deadline_at);
    const request_digest = await digestJson({ v: DISPATCH_COORDINATOR_INTERFACE, binding, body });
    const op_key = JSON.stringify([principal.principal_id, body.idempotency_key]);

    // Principal-scoped operation claim.
    let claim;
    try {
      claim = await call(authority.claimOperation, { op_key, request_digest, principal_id: principal.principal_id,
        tenant_id: principal.tenant_id, binding });
    } catch (e) {
      if (e && e.code === 'DISPATCH_LIMIT') return reject('DISPATCH_LIMIT', 429);
      return uncertain('claim', 'OUTCOME_UNCERTAIN');
    }
    if (!isObj(claim) || typeof claim.claimed !== 'boolean' || !validOp(claim.op)) {
      return uncertain('claim', 'OUTCOME_UNCERTAIN');
    }
    const op = claim.op;
    if (op.request_digest !== request_digest) {
      return reject('IDEMPOTENCY_CONFLICT', 409, { op_id: op.op_id });
    }
    if (!claim.claimed) return viewOf(op); // same operation: reconcile, never redispatch

    // Conservative per-pool holds. Partial holds are pending and non-dispatchable.
    const holdIds = [];
    for (const pool of binding.pools) {
      let hold;
      try {
        hold = await call(authority.acquireHold, { op_id: op.op_id, generation: op.generation,
          pool_id: pool.pool_id, amount: pool.amount });
      } catch (e) {
        await markUncertain(op, 'holds', e.message);
        return uncertain('holds', 'OUTCOME_UNCERTAIN', { op_id: op.op_id });
      }
      if (isObj(hold) && hold.held === true && isStr(hold.hold_id)) { holdIds.push(hold.hold_id); continue; }
      if (isObj(hold) && hold.held === false) {
        await releaseUnadmitted(op, 'budget_exhausted');
        return reject('BUDGET_EXHAUSTED', 429, { op_id: op.op_id });
      }
      await markUncertain(op, 'holds', 'malformed hold response');
      return uncertain('holds', 'OUTCOME_UNCERTAIN', { op_id: op.op_id });
    }

    // Linearization point: every exact hold + live authority in one store step.
    let admitted;
    try {
      admitted = await call(authority.admit, { op_id: op.op_id, generation: op.generation, holds: holdIds,
        authority: { grant_id: binding.grant_id, grant_revision: binding.grant_revision, incarnation: binding.incarnation } });
    } catch (e) {
      await markUncertain(op, 'admission', e.message);
      return uncertain('admission', 'OUTCOME_UNCERTAIN', { op_id: op.op_id });
    }
    if (isObj(admitted) && admitted.outcome === 'rejected') {
      await releaseUnadmitted(op, 'admission_rejected');
      return reject('ADMISSION_REJECTED', 409, { op_id: op.op_id, reason: String(admitted.reason || '') });
    }
    if (!isObj(admitted) || admitted.outcome !== 'admitted') {
      await markUncertain(op, 'admission', 'malformed admission response');
      return uncertain('admission', 'OUTCOME_UNCERTAIN', { op_id: op.op_id });
    }

    // Deadline before start: fence, then release this operation's holds.
    if (now() >= body.deadline_at) {
      if (await fenceAndRelease(op, 'deadline_before_start')) {
        return result('expired_before_start', { op_id: op.op_id, code: 'DEADLINE_EXCEEDED', http: 504 });
      }
      return uncertain('fence', 'OUTCOME_UNCERTAIN', { op_id: op.op_id });
    }

    // Issuer-owned one-time start redemption, serialized with revoke.
    let redeemed;
    try {
      redeemed = await call(authority.redeemStart, { op_id: op.op_id, generation: op.generation,
        worker: { node_id: binding.node_id, runtime_instance: binding.runtime_instance } });
    } catch (e) {
      await markUncertain(op, 'start', e.message);
      return uncertain('start', 'OUTCOME_UNCERTAIN', { op_id: op.op_id });
    }
    if (isObj(redeemed) && redeemed.outcome === 'refused') {
      const fencedAlready = redeemed.reason === 'fenced';
      const released = await fenceAndRelease(op, fencedAlready ? 'cancelled_before_start' : 'start_refused');
      if (!released) return uncertain('fence', 'OUTCOME_UNCERTAIN', { op_id: op.op_id });
      if (fencedAlready) return result('cancelled_before_start', { op_id: op.op_id, code: 'START_FENCED', http: 409 });
      return reject('START_REFUSED', 409, { op_id: op.op_id, reason: String(redeemed.reason || '') });
    }
    if (!isObj(redeemed) || redeemed.outcome !== 'redeemed') {
      await markUncertain(op, 'start', 'malformed redemption response');
      return uncertain('start', 'OUTCOME_UNCERTAIN', { op_id: op.op_id });
    }

    // Bound dispatch. The legacy codec carries the CPU placement; the exact
    // instance, fingerprint and deadline travel in the internal binding and
    // are only sent to a transport that declares support for them.
    const envelope = {
      protocol: TRANSPORT_PROTOCOL,
      task: encodeBoundCpuTask(
        { modelId: binding.model_id, prompt: body.prompt, maxTokens: body.max_tokens, operationKey: op.op_id },
        { device: 'cpu', nodeId: binding.node_id, runtimeId: binding.runtime_id }),
      binding: { op_id: op.op_id, generation: op.generation, runtime_instance: binding.runtime_instance,
        model_fingerprint: binding.model_fingerprint, deadline_at: body.deadline_at },
    };
    let sent;
    try { sent = await call(transport.dispatch, envelope); }
    catch (e) {
      await markUncertain(op, 'dispatch', e.message);
      return uncertain('dispatch', 'OUTCOME_UNCERTAIN', { op_id: op.op_id });
    }
    // After redemption there is no proof of non-execution: any non-accept is
    // uncertain, holds retained.
    if (!isObj(sent) || sent.accepted !== true || !isStr(sent.job_id)) {
      await markUncertain(op, 'dispatch', isObj(sent) ? `not accepted: ${String(sent.reason || '')}` : 'malformed');
      return uncertain('dispatch', 'OUTCOME_UNCERTAIN', { op_id: op.op_id });
    }
    let recorded;
    try { recorded = await call(authority.recordDispatch, { op_id: op.op_id, generation: op.generation, job_id: sent.job_id }); }
    catch (e) {
      await markUncertain(op, 'dispatch', e.message);
      return uncertain('dispatch', 'OUTCOME_UNCERTAIN', { op_id: op.op_id, job_id: sent.job_id });
    }
    if (!isObj(recorded) || recorded.recorded !== true) {
      await markUncertain(op, 'dispatch', 'dispatch not recorded');
      return uncertain('dispatch', 'OUTCOME_UNCERTAIN', { op_id: op.op_id, job_id: sent.job_id });
    }
    return result('dispatched', { op_id: op.op_id, job_id: sent.job_id, http: 202 });
  }

  async function lookup(authContext, idempotencyKey) {
    if (blockedBy.length) return { refusal: unavailable() };
    const { principal, refusal } = await principalFor(authContext);
    if (refusal) return { refusal };
    if (typeof idempotencyKey !== 'string' || !KEY_RE.test(idempotencyKey)) return { refusal: reject('INVALID_REQUEST', 400) };
    let op;
    try { op = await call(authority.getOperation, { op_key: JSON.stringify([principal.principal_id, idempotencyKey]) }); }
    catch { return { refusal: uncertain('lookup', 'AUTHORITY_UNAVAILABLE') }; }
    if (op === null) return { refusal: reject('OPERATION_NOT_FOUND', 404) };
    if (!validOp(op) || op.principal_id !== principal.principal_id) return { refusal: uncertain('lookup', 'OUTCOME_UNCERTAIN') };
    return { op };
  }

  // Read-only reconciliation by the same identity: polls a recorded job and
  // settles a verified terminal result exactly once. Never redispatches.
  async function reconcile(authContext, idempotencyKey) {
    const { op, refusal } = await lookup(authContext, idempotencyKey);
    if (refusal) return refusal;
    if (op.settled || op.uncertain || op.phase !== 'dispatched' || !isStr(op.job_id)) return viewOf(op);
    const b = op.binding;
    let job;
    try { job = await call(transport.poll, { job_id: op.job_id }); }
    catch (e) { return uncertain('result', 'RESULT_UNAVAILABLE', { op_id: op.op_id, job_id: op.job_id, detail: e.message }); }

    let decoded;
    try {
      decoded = decodeCpuTask(job, { id: op.job_id, node_id: b.node_id, runtime_id: b.runtime_id, model_id: b.model_id });
      if (decoded.status === 'succeeded'
        && (job.result.runtime_instance !== b.runtime_instance || job.result.model_fingerprint !== b.model_fingerprint)) {
        throw new Error('instance/fingerprint binding mismatch');
      }
    } catch {
      await markUncertain(op, 'result', 'malformed or foreign result');
      return uncertain('result', 'RESULT_REJECTED', { op_id: op.op_id, job_id: op.job_id });
    }

    if (decoded.status === 'running') {
      if (!Number.isSafeInteger(b.deadline_at) || now() >= b.deadline_at) {
        await markUncertain(op, 'deadline', 'deadline passed while running');
        return uncertain('deadline', 'OUTCOME_UNCERTAIN', { op_id: op.op_id, job_id: op.job_id });
      }
      return result('dispatched', { op_id: op.op_id, job_id: op.job_id, http: 202 });
    }

    const result_digest = await digestJson({ job_id: op.job_id, status: decoded.status,
      content: decoded.content === undefined ? null : decoded.content });
    let settled;
    try {
      settled = await call(authority.settle, { op_id: op.op_id, generation: op.generation, job_id: op.job_id,
        outcome: decoded.status, result_digest });
    } catch (e) {
      await markUncertain(op, 'settlement', e.message);
      return uncertain('settlement', 'OUTCOME_UNCERTAIN', { op_id: op.op_id, job_id: op.job_id });
    }
    if (!isObj(settled) || (settled.settled !== true && settled.reason !== 'already_settled')) {
      await markUncertain(op, 'settlement', isObj(settled) ? String(settled.reason) : 'malformed');
      return uncertain('settlement', 'OUTCOME_UNCERTAIN', { op_id: op.op_id, job_id: op.job_id });
    }
    const outcome = { finish: decoded.status, released: false };
    if (decoded.status === 'succeeded') {
      // Release rechecks live authority and the exact binding (above).
      let check;
      try { check = await call(authority.recheckRelease, { op_id: op.op_id, generation: op.generation }); }
      catch { check = { ok: false, reason: 'authority_unavailable_at_release' }; }
      if (isObj(check) && check.ok === true) {
        outcome.released = true;
        outcome.content = decoded.content;
        outcome.provenance = { ...decoded.provenance, runtime_instance: b.runtime_instance,
          model_fingerprint: b.model_fingerprint, simulated: false };
      } else {
        outcome.withheld_reason = isObj(check) && typeof check.reason === 'string' ? check.reason : 'release_not_authorized';
      }
    }
    return result('settled', { op_id: op.op_id, job_id: op.job_id, outcome });
  }

  // Cancel intent. Before start: fence the start, then release this
  // operation's holds. After start: unsupported capability, holds retained,
  // remote never claimed stopped (no execution-cancel frame exists).
  async function cancel(authContext, idempotencyKey) {
    const { op, refusal } = await lookup(authContext, idempotencyKey);
    if (refusal) return refusal;
    if (op.settled) return viewOf(op);
    if (['claimed', 'holding', 'admitted'].includes(op.phase) && !op.uncertain) {
      if (await fenceAndRelease(op, 'cancelled_before_start')) {
        return result('cancelled_before_start', { op_id: op.op_id, code: 'CANCELLED', http: 200 });
      }
      return uncertain('fence', 'OUTCOME_UNCERTAIN', { op_id: op.op_id });
    }
    try { await call(authority.recordCancelIntent, { op_id: op.op_id, generation: op.generation }); }
    catch { /* intent not recorded; nothing is released either way */ }
    return { ...viewOf(op), cancel: 'UNSUPPORTED_CAPABILITY' };
  }

  return Object.freeze({ interface: DISPATCH_COORDINATOR_INTERFACE, submit, reconcile, cancel });
}

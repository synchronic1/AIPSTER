// TEST DOUBLE ONLY. In-memory model of the L1 dispatch-store interface
// (docs/dispatch-coordinator.md + DS-INFERENCE-LANES-20261101.md):
//   authority methods (resolveAdmission .. settle)
//   issueAdmission, enqueueJob, leaseNextJob, completeJob, readJob
// It is NOT D1, NOT durable, NOT authority and NOT a transport, and nothing
// imports it from production code. Atomicity is modeled as one synchronous
// mutation after the optional async resource read: on a single-threaded event
// loop each method call is one indivisible step.
//
// The owner "grant" is resource- and admission-scoped on purpose: the
// coordinator pre-checks readGrant({grant_id}) against the exact resource,
// incarnation and model, and readGrant receives only the grant id, so a bare
// "owner" id cannot resolve which resource is being authorized.

const DAY_MS = 86400000;
const ADMISSION_TTL_MS = 10 * 60 * 1000;

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const iso = (ms) => new Date(ms).toISOString();
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isGen = (x) => Number.isSafeInteger(x) && x >= 1;

function randomHex(bytes) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
}

function ownerDailyCeiling(env) {
  const raw = env && env.INFERENCE_OWNER_DAILY_TOKENS;
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : (typeof raw === 'number' ? raw : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : 0; // missing/invalid = 0 = fail closed
}

export function createFakeDispatchStore(db, { now = () => Date.now(), env = {} } = {}) {
  const state = {
    seq: 0,
    admissions: {}, // admission_ref -> record
    grants: {},     // grant_id -> fabric/policy.mjs-shaped snapshot
    pools: {},      // pool_id -> { ceiling, used, held }
    holds: {},      // hold_id -> { op_id, generation, pool_id, amount, state }
    operations: {}, // op_id -> op record
    byKey: {},      // op_key -> op_id
    fenced: {},     // `${op_id}:${generation}` -> true
    jobs: {},       // job_id -> job row
  };

  const opFor = (opId) => state.operations[opId];

  function poolFor(poolId) {
    if (!state.pools[poolId]) {
      let ceiling = 0;
      if (poolId.startsWith('owner:')) ceiling = ownerDailyCeiling(env);
      else if (poolId.startsWith('grant:')) ceiling = state.grants[poolId.slice('grant:'.length)]?.ceilings?.maxTokens || 0;
      state.pools[poolId] = { ceiling, used: 0, held: 0 };
    }
    return state.pools[poolId];
  }

  // ---- authority -------------------------------------------------------

  async function resolveAdmission({ principal, admission_ref }) {
    const a = state.admissions[admission_ref];
    // Foreign and unknown references look the same to the caller.
    if (!a || !principal || a.principal_id !== principal.principal_id || a.tenant_id !== principal.tenant_id) return null;
    return clone(a);
  }

  async function readGrant({ grant_id }) {
    return state.grants[grant_id] ? clone(state.grants[grant_id]) : null;
  }

  async function claimOperation({ op_key, request_digest, principal_id, tenant_id, binding }) {
    const existing = state.byKey[op_key];
    if (existing) return { claimed: false, op: clone(opFor(existing)) };
    state.seq += 1;
    const op_id = `dispatch-op-${String(state.seq).padStart(6, '0')}`;
    state.operations[op_id] = {
      op_id, op_key, principal_id, tenant_id, request_digest, binding: clone(binding),
      generation: 1, phase: 'claimed', job_id: null, uncertain: null, cancel_intent: false, settled: null,
    };
    state.byKey[op_key] = op_id;
    return { claimed: true, op: clone(state.operations[op_id]) };
  }

  async function getOperation({ op_key }) {
    const id = state.byKey[op_key];
    return id ? clone(opFor(id)) : null;
  }

  async function acquireHold({ op_id, generation, pool_id, amount }) {
    const op = opFor(op_id);
    if (!op || op.generation !== generation) return { held: false, reason: 'fenced' };
    const pool = poolFor(pool_id);
    if (!Number.isSafeInteger(amount) || amount <= 0 || pool.used + pool.held + amount > pool.ceiling) {
      return { held: false, reason: 'insufficient' };
    }
    const hold_id = `hold-${op_id}-${pool_id}`;
    if (state.holds[hold_id]) return { held: true, hold_id }; // idempotent per (op, pool)
    pool.held += amount;
    state.holds[hold_id] = { op_id, generation, pool_id, amount, state: 'held' };
    if (op.phase === 'claimed') op.phase = 'holding';
    return { held: true, hold_id };
  }

  // Modeled linearization point: exact operation-owned holds AND the live
  // grant revision/incarnation are checked in one step.
  async function admit({ op_id, generation, holds, authority }) {
    const op = opFor(op_id);
    if (!op || op.generation !== generation) return { outcome: 'rejected', reason: 'fenced' };
    if (op.phase === 'admitted') return { outcome: 'admitted' };
    if (state.fenced[`${op_id}:${generation}`]) return { outcome: 'rejected', reason: 'fenced' };
    const g = state.grants[authority.grant_id];
    if (!g || g.status !== 'enforced' || g.revoked !== false || g.revision !== authority.grant_revision
      || g.incarnation !== authority.incarnation) return { outcome: 'rejected', reason: 'authority_changed' };
    const owned = Object.entries(state.holds)
      .filter(([, h]) => h.op_id === op_id && h.generation === generation && h.state === 'held')
      .map(([id]) => id).sort();
    if (JSON.stringify(owned) !== JSON.stringify([...holds].sort())) return { outcome: 'rejected', reason: 'holds_mismatch' };
    for (const h of Object.values(state.holds)) {
      if (h.op_id === op_id && h.generation === generation && h.state === 'held') h.state = 'committed';
    }
    op.phase = 'admitted';
    return { outcome: 'admitted' };
  }

  async function redeemStart({ op_id, generation, worker }) {
    const op = opFor(op_id);
    if (!op || op.generation !== generation) return { outcome: 'refused', reason: 'fenced' };
    if (state.fenced[`${op_id}:${generation}`]) return { outcome: 'refused', reason: 'fenced' };
    if (op.phase === 'redeemed' || op.phase === 'dispatched') return { outcome: 'redeemed' };
    if (op.phase !== 'admitted') return { outcome: 'refused', reason: 'not_admitted' };
    const g = state.grants[op.binding.grant_id];
    if (!g || g.revoked !== false || g.status !== 'enforced' || g.revision !== op.binding.grant_revision) {
      return { outcome: 'refused', reason: 'revoked' };
    }
    if (worker.node_id !== op.binding.node_id || worker.runtime_instance !== op.binding.runtime_instance) {
      return { outcome: 'refused', reason: 'worker_mismatch' };
    }
    op.phase = 'redeemed';
    return { outcome: 'redeemed' };
  }

  async function fenceStart({ op_id, generation }) {
    const op = opFor(op_id);
    if (op && ['redeemed', 'dispatched', 'settled'].includes(op.phase)) return { outcome: 'already_redeemed' };
    state.fenced[`${op_id}:${generation}`] = true;
    return { outcome: 'fenced' };
  }

  async function releaseHolds({ op_id, generation }) {
    const op = opFor(op_id);
    const startable = op && op.phase === 'admitted' && !state.fenced[`${op_id}:${generation}`];
    if (!op || op.generation !== generation || startable || ['redeemed', 'dispatched', 'settled'].includes(op.phase)) {
      return { released: 0 };
    }
    let released = 0;
    for (const h of Object.values(state.holds)) {
      if (h.op_id === op_id && h.generation === generation && (h.state === 'held' || h.state === 'committed')) {
        state.pools[h.pool_id].held -= h.amount;
        h.state = 'released';
        released += 1;
      }
    }
    op.phase = 'released';
    return { released };
  }

  async function recordDispatch({ op_id, generation, job_id }) {
    const op = opFor(op_id);
    if (!op || op.generation !== generation || op.phase !== 'redeemed') return { recorded: false };
    op.job_id = job_id;
    op.phase = 'dispatched';
    return { recorded: true };
  }

  async function markUncertain({ op_id, generation, phase, detail }) {
    const op = opFor(op_id);
    if (!op || op.generation !== generation) return { recorded: false };
    if (!op.uncertain) op.uncertain = { phase, detail };
    return { recorded: true };
  }

  async function recordCancelIntent({ op_id, generation }) {
    const op = opFor(op_id);
    if (!op || op.generation !== generation) return { recorded: false };
    op.cancel_intent = true;
    return { recorded: true };
  }

  async function recheckRelease({ op_id }) {
    const op = opFor(op_id);
    if (!op) return { ok: false, reason: 'unknown_operation' };
    const g = state.grants[op.binding.grant_id];
    if (!g || g.status !== 'enforced' || g.revoked !== false || g.revision !== op.binding.grant_revision) {
      return { ok: false, reason: 'authority_revoked_before_release' };
    }
    return { ok: true };
  }

  async function settle({ op_id, generation, job_id, outcome, result_digest }) {
    const op = opFor(op_id);
    if (!op) return { settled: false, reason: 'unknown_operation' };
    if (op.generation !== generation) return { settled: false, reason: 'generation_mismatch' };
    if (op.job_id !== job_id) return { settled: false, reason: 'job_mismatch' };
    if (op.settled) return { settled: false, reason: 'already_settled' };
    for (const h of Object.values(state.holds)) {
      if (h.op_id === op_id && h.generation === generation && h.state === 'committed') {
        const pool = state.pools[h.pool_id];
        pool.held -= h.amount;
        pool.used += h.amount;
        h.state = 'charged';
      }
    }
    op.settled = { outcome, result_digest };
    op.phase = 'settled';
    return { settled: true };
  }

  // ---- admission issuance ----------------------------------------------

  async function issueAdmission({ principal, resource_id, model_id, max_tokens, grant = null }) {
    if (!isObj(principal) || typeof principal.principal_id !== 'string' || typeof principal.tenant_id !== 'string') {
      throw new Error('principal required');
    }
    if (!Number.isSafeInteger(max_tokens) || max_tokens < 1 || max_tokens > 4096) throw new Error('max_tokens out of range');
    const resource = await db.prepare('SELECT id, owner_id, incarnation FROM resources WHERE id = ?').bind(resource_id).first();
    if (!resource) throw new Error('resource missing');
    const at = now();
    const expires_at = at + ADMISSION_TTL_MS;
    const admission_ref = `adm-${randomHex(16)}`;
    const node_id = resource_id;
    const runtime_id = 'ganglion';
    const runtime_instance = `${node_id}#ganglion`;
    const model_fingerprint = `sha256:${randomHex(32)}`;

    let snapshot;
    if (isObj(grant) && typeof grant.id === 'string' && grant.id) {
      snapshot = { ...clone(grant), revoked: false };
    } else {
      const grant_id = `owner:${principal.principal_id}:${resource_id}:${admission_ref}`;
      snapshot = {
        id: grant_id, status: 'enforced', revoked: false, revision: 1,
        recipientNode: node_id, recipientWorkspace: 'default', consumers: [principal.principal_id],
        resourceId: resource_id, incarnation: resource.incarnation,
        actions: ['inference'], models: [model_id],
        notBefore: iso(at), expiry: iso(at + 365 * DAY_MS),
        ceilings: { maxTokens: max_tokens }, route: 'internal',
      };
    }
    state.grants[snapshot.id] = clone(snapshot);
    const pool_id = grant ? `grant:${snapshot.id}` : `owner:${principal.principal_id}:${iso(at).slice(0, 10)}`;

    const record = {
      admission_ref, principal_id: principal.principal_id, tenant_id: principal.tenant_id,
      grant_id: snapshot.id, grant_revision: isGen(snapshot.revision) ? snapshot.revision : 1,
      resource_id, incarnation: snapshot.incarnation || resource.incarnation,
      peer_node: snapshot.recipientNode, peer_workspace: snapshot.recipientWorkspace, route: snapshot.route,
      node_id, runtime_id, runtime_instance, model_fingerprint,
      model_id, max_tokens, expires_at,
      pools: [{ pool_id, amount: max_tokens }],
    };
    state.admissions[admission_ref] = record;
    return { admission_ref, expires_at, model_id, max_tokens };
  }

  // ---- job queue / worker transport ------------------------------------

  async function enqueueJob(envelope) {
    if (!isObj(envelope) || !isObj(envelope.task) || !isObj(envelope.task.placement) || !isObj(envelope.binding)) {
      return { accepted: false, reason: 'malformed_envelope' };
    }
    state.seq += 1;
    const job_id = `job-${String(state.seq).padStart(4, '0')}`;
    state.jobs[job_id] = {
      job_id, resource_id: envelope.task.placement.node_id,
      node_id: envelope.task.placement.node_id, runtime_id: envelope.task.placement.runtime_id,
      model_id: envelope.task.model_id, op_id: envelope.binding.op_id, generation: envelope.binding.generation,
      status: 'queued', envelope: clone(envelope), lease_id: null, result: null,
      deadline_at: envelope.binding.deadline_at, created_at: now(),
    };
    return { accepted: true, job_id };
  }

  async function leaseNextJob({ resource_id, now: nowMs = now() }) {
    const job = Object.values(state.jobs).find((j) => {
      if (j.resource_id !== resource_id || j.status !== 'queued') return false;
      if (!Number.isSafeInteger(j.deadline_at) || nowMs >= j.deadline_at) return false;
      const op = opFor(j.op_id);
      if (!op || op.uncertain || !['redeemed', 'dispatched'].includes(op.phase)) return false;
      return !state.fenced[`${j.op_id}:${j.generation}`];
    });
    if (!job) return null;
    job.status = 'leased';
    job.lease_id = `lease-${job.job_id}-${randomHex(4)}`;
    return { job_id: job.job_id, lease_id: job.lease_id, envelope: clone(job.envelope), deadline_at: job.deadline_at };
  }

  async function completeJob({ job_id, lease_id, resource_id, status, result }) {
    const job = state.jobs[job_id];
    if (!job) return { accepted: false, reason: 'unknown_job' };
    if (job.resource_id !== resource_id) return { accepted: false, reason: 'resource_mismatch' };
    if (job.status !== 'leased') return { accepted: false, reason: 'already_completed' };
    if (job.lease_id !== lease_id) return { accepted: false, reason: 'lease_mismatch' };
    job.status = status;
    job.result = clone(result);
    return { accepted: true };
  }

  async function readJob({ job_id }) {
    const job = state.jobs[job_id];
    if (!job) return null;
    return {
      id: job.job_id, node_id: job.node_id, runtime_id: job.runtime_id, model_id: job.model_id,
      status: job.status === 'queued' || job.status === 'leased' ? 'running' : job.status,
      result: job.result ? clone(job.result) : undefined,
    };
  }

  return Object.freeze({
    // authority
    resolveAdmission, readGrant, claimOperation, getOperation, acquireHold, admit,
    redeemStart, fenceStart, releaseHolds, recordDispatch, markUncertain, recordCancelIntent,
    recheckRelease, settle,
    // L1 additions
    issueAdmission, enqueueJob, leaseNextJob, completeJob, readJob,
    // test-only introspection
    state,
  });
}

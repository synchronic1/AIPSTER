// Shared fixture for the real D1 dispatch store tests (lane L1).
// Builds an in-memory SQLite database with every repo migration, a D1 shim,
// two users/resources and one grant, an injectable clock, and the real store.
// No worker.js import, no network.
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, createD1Shim } from '../d1-shim.mjs';
import { createD1DispatchStore } from '../../src/inference/dispatch-store.mjs';
import { createDispatchCoordinator } from '../../src/inference/dispatch-coordinator.mjs';

export const T0 = Date.parse('2026-03-01T12:00:00.000Z');
export const RES_1 = 'res-1';
export const RES_2 = 'res-2';

export const alice = Object.freeze({ principal_id: 'user-alice', tenant_id: 'tenant-a', actor_kind: 'session' });
export const bob = Object.freeze({ principal_id: 'user-bob', tenant_id: 'tenant-b', actor_kind: 'session' });

export function createClock(start = T0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; return t; },
    set: (ms) => { t = ms; return t; },
  };
}

function seed(sqlite, start) {
  const at = new Date(start).toISOString();
  const created = new Date(start - 60 * 60 * 1000).toISOString();
  for (const [id, name, email] of [['user-alice', 'Alice', 'alice@example.com'],
    ['user-bob', 'Bob', 'bob@example.com']]) {
    sqlite.prepare(`INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt, demo)
      VALUES (?, ?, ?, 1, NULL, ?, ?, 0)`).run(id, name, email, created, created);
  }
  const resources = [
    ['res-1', 'node-cpu-1', 'inc-1'],
    ['res-2', 'node-cpu-2', 'inc-2'],
  ];
  for (const [id, nodeId, incarnation] of resources) {
    sqlite.prepare(`INSERT INTO resources
      (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated,
       online, usable, heartbeat_at, limits_json, scope, verification_json, created_at, node_id, incarnation)
      VALUES (?, 'user-alice', ?, 'local', 'synthetic', 'x86', 'none', '[]', 1, 1, 1, 1, ?, '{}',
        'owner only', '{}', ?, ?, ?)`).run(id, id, at, created, nodeId, incarnation);
  }
  sqlite.prepare(`INSERT INTO grants
    (id, resource_id, owner_id, grantee_id, max_jobs, max_tokens, used_jobs, used_tokens, inference_only, created_at)
    VALUES ('grant-1', 'res-1', 'user-alice', 'user-bob', 10, 1000, 0, 0, 1, ?)`).run(created);
}

// `ownerDaily: null` omits INFERENCE_OWNER_DAILY_TOKENS entirely.
export function createStoreHarness({ start = T0, ownerDaily = '10000', env = {} } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(sqlite);
  seed(sqlite, start);
  const db = createD1Shim(sqlite);
  const clock = createClock(start);
  const store = createD1DispatchStore(db, {
    now: clock.now,
    env: { ...(ownerDaily === null ? {} : { INFERENCE_OWNER_DAILY_TOKENS: ownerDaily }), ...env },
  });
  return { sqlite, db, clock, store };
}

// The server-private binding the coordinator derives from an admission
// (bindingOf in dispatch-coordinator.mjs). Tests construct it only to call the
// store directly; the coordinator builds its own from durable state.
export function bindingFor(admission, { principal = alice, deadline_at = T0 + 60000 } = {}) {
  return {
    admission_ref: admission.admission_ref,
    principal_id: principal.principal_id,
    tenant_id: principal.tenant_id,
    grant_id: admission.grant_id,
    grant_revision: admission.grant_revision,
    resource_id: admission.resource_id,
    incarnation: admission.incarnation,
    node_id: admission.node_id,
    runtime_id: admission.runtime_id,
    runtime_instance: admission.runtime_instance,
    model_id: admission.model_id,
    model_fingerprint: admission.model_fingerprint,
    pools: admission.pools.map((p) => ({ pool_id: p.pool_id, amount: p.amount })),
    deadline_at,
  };
}

// NESTED wire envelope the coordinator builds (Addendum A), from a resolved
// admission and its binding.
export function envelopeFor(admission, binding, { prompt = 'hello', maxTokens = admission.max_tokens } = {}) {
  return {
    protocol: 'aipster-bound-cpu-internal/1',
    task: {
      capability: 'complete', model_id: admission.model_id, prompt, max_tokens: maxTokens,
      temperature: 0, allow_simulated: false, idempotency_key: binding.op_id,
      placement: { device: 'cpu', node_id: admission.node_id, runtime_id: admission.runtime_id },
    },
    binding: {
      op_id: binding.op_id, generation: binding.generation ?? 1,
      runtime_instance: admission.runtime_instance, model_fingerprint: admission.model_fingerprint,
      deadline_at: binding.deadline_at,
    },
  };
}

let opSeq = 0;
export function nextOpKey(prefix = 'op') {
  opSeq += 1;
  return `${prefix}-key-${String(opSeq).padStart(4, '0')}`;
}

// Drive the store to an admitted operation (claim -> hold -> admit).
export async function admittedOperation(harness, {
  principal = alice, resource_id = RES_1, model_id = 'model-x', max_tokens = 128,
  grant = null, runtime_id, deadline_at = T0 + 60000, op_key = nextOpKey(),
} = {}) {
  const admission = await harness.store.issueAdmission({
    principal, resource_id, model_id, max_tokens, grant, ...(runtime_id ? { runtime_id } : {}),
  });
  const resolved = await harness.store.resolveAdmission({ principal, admission_ref: admission.admission_ref });
  const claim = await harness.store.claimOperation({
    op_key, request_digest: `sha256:${'a'.repeat(64)}`, principal_id: principal.principal_id,
    tenant_id: principal.tenant_id, binding: bindingFor(resolved, { principal, deadline_at }),
  });
  const bound = { ...bindingFor(resolved, { principal, deadline_at }), op_id: claim.op.op_id };
  const holdIds = [];
  for (const pool of bound.pools) {
    const hold = await harness.store.acquireHold({
      op_id: claim.op.op_id, generation: claim.op.generation, pool_id: pool.pool_id, amount: pool.amount,
    });
    if (hold.held !== true) return { admission, resolved, binding: bound, op: claim.op, holdIds, admitted: hold };
    holdIds.push(hold.hold_id);
  }
  const admitted = await harness.store.admit({
    op_id: claim.op.op_id, generation: claim.op.generation, holds: holdIds,
    authority: { grant_id: bound.grant_id, grant_revision: bound.grant_revision, incarnation: bound.incarnation },
  });
  return { admission, resolved, binding: bound, op: claim.op, holdIds, admitted };
}

// Drive the store through redeem -> enqueue and return the lease frame.
export async function dispatchedOperation(harness, options = {}) {
  const flow = await admittedOperation(harness, options);
  if (!flow.admitted || flow.admitted.outcome !== 'admitted') {
    throw new Error(`operation was not admitted: ${JSON.stringify(flow.admitted)}`);
  }
  const redeemed = await harness.store.redeemStart({
    op_id: flow.op.op_id, generation: 1,
    worker: { node_id: flow.binding.node_id, runtime_instance: flow.binding.runtime_instance },
  });
  if (redeemed.outcome !== 'redeemed') throw new Error(`redeem refused: ${JSON.stringify(redeemed)}`);
  const envelope = envelopeFor(flow.resolved, flow.binding);
  const queued = await harness.store.enqueueJob(envelope);
  if (queued.accepted !== true) throw new Error(`enqueue refused: ${JSON.stringify(queued)}`);
  // The coordinator records the durable dispatch immediately after transport
  // acceptance; mirror that so direct-store tests exercise the same phase.
  const recorded = await harness.store.recordDispatch({
    op_id: flow.op.op_id, generation: 1, job_id: queued.job_id,
  });
  if (recorded.recorded !== true) throw new Error(`dispatch not recorded: ${JSON.stringify(recorded)}`);
  return { ...flow, envelope, job_id: queued.job_id };
}

export function workerResult(frame, overrides = {}) {
  const task = frame.envelope.task;
  const binding = frame.envelope.binding;
  return {
    request_id: frame.job_id,
    node_id: task.placement.node_id,
    runtime_id: task.placement.runtime_id,
    model_id: task.model_id,
    runtime_instance: binding.runtime_instance,
    model_fingerprint: binding.model_fingerprint,
    simulated: false,
    content: 'hello from the worker',
    elapsed_ms: 12,
    usage: { output_tokens: 1 },
    cache: {},
    ...overrides,
  };
}

// Coordinator wired to the real store. resolvePrincipal is a plain map; the
// transport is the durable queue, not inference.
export function coordinatorOverStore(harness, { principals = { 'ctx-alice': alice, 'ctx-bob': bob } } = {}) {
  const transport = {
    capabilities: {
      protocol: 'aipster-bound-cpu-internal/1', instance_pin: true, deadline: true, execution_cancel: false,
    },
    dispatch: (envelope) => harness.store.enqueueJob(envelope),
    poll: ({ job_id }) => harness.store.readJob({ job_id }),
  };
  const coordinator = createDispatchCoordinator({
    resolvePrincipal: async (ctx) => (ctx in principals ? { ...principals[ctx] } : null),
    authority: harness.store,
    transport,
    now: harness.clock.now,
  });
  return { coordinator, transport };
}

export function submitBody(admission, overrides = {}) {
  return {
    contract_version: 'v1.0.0',
    admission_ref: admission.admission_ref,
    idempotency_key: nextOpKey('idem'),
    model_id: admission.model_id,
    prompt: 'hello',
    max_tokens: admission.max_tokens,
    deadline_at: T0 + 60000,
    ...overrides,
  };
}

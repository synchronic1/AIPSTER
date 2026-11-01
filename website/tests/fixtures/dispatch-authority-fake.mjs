// TEST DOUBLE ONLY. Models the contract the dispatch coordinator requires of
// an authority store, a trusted principal resolver and a transport. It is
// NOT authority, NOT an issuer, NOT D1 and NOT a transport: nothing here is
// imported by production code. "Persistence" across a restart is modeled by
// handing the same plain `state` object to a new fake; it is not durability.
//
// Atomicity model: every store method mutates state synchronously after its
// optional async fault hook, so each call is one indivisible step on the
// single-threaded event loop. admit() checks every exact operation-owned hold
// AND the live grant revision in that same step (the modeled linearization
// point). redeemStart() and revoke() serialize in the same store.

export const nowBase = 1767225600000; // 2026-01-01T00:00:00Z

export function createClock(start = nowBase) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; return t; } };
}

export function baseState() {
  return {
    seq: 0,
    principals: {
      'ctx-alice': { principal_id: 'user-alice', tenant_id: 'tenant-a', actor_kind: 'session' },
      'ctx-alice-key': { principal_id: 'user-alice', tenant_id: 'tenant-a', actor_kind: 'key', key_scope: 'inference' },
      'ctx-alice-read': { principal_id: 'user-alice', tenant_id: 'tenant-a', actor_kind: 'key', key_scope: 'read' },
      'ctx-heartbeat': { principal_id: 'user-alice', tenant_id: 'tenant-a', actor_kind: 'key', key_scope: 'heartbeat' },
      'ctx-expired': { principal_id: 'user-alice', tenant_id: 'tenant-a', actor_kind: 'key', key_scope: 'inference', expired: true },
      'ctx-bob': { principal_id: 'user-bob', tenant_id: 'tenant-b', actor_kind: 'session' },
    },
    grants: {
      'grant-1': {
        id: 'grant-1', status: 'enforced', revoked: false, revision: 3,
        recipientNode: 'node-cpu-1', recipientWorkspace: 'ws-a', consumers: ['user-alice'],
        resourceId: 'res-1', incarnation: 'inc-1', actions: ['inference'], models: ['model-x'],
        notBefore: '2025-01-01T00:00:00.000Z', expiry: '2027-01-01T00:00:00.000Z',
        ceilings: { maxTokens: 256 }, route: 'route-1',
      },
    },
    admissions: {
      'adm-alice-1': {
        admission_ref: 'adm-alice-1', principal_id: 'user-alice', tenant_id: 'tenant-a',
        grant_id: 'grant-1', grant_revision: 3, resource_id: 'res-1', incarnation: 'inc-1',
        peer_node: 'node-cpu-1', peer_workspace: 'ws-a', route: 'route-1',
        node_id: 'node-cpu-1', runtime_id: 'ik-runtime-1', runtime_instance: 'ik-runtime-1#7',
        model_id: 'model-x', model_fingerprint: 'sha256:model-x-q4',
        max_tokens: 128, expires_at: nowBase + 600000,
        pools: [{ pool_id: 'pool-tokens', amount: 128 }, { pool_id: 'pool-slots', amount: 1 }],
      },
      'adm-bob-1': {
        admission_ref: 'adm-bob-1', principal_id: 'user-bob', tenant_id: 'tenant-b',
        grant_id: 'grant-1', grant_revision: 3, resource_id: 'res-1', incarnation: 'inc-1',
        peer_node: 'node-cpu-1', peer_workspace: 'ws-a', route: 'route-1',
        node_id: 'node-cpu-1', runtime_id: 'ik-runtime-1', runtime_instance: 'ik-runtime-1#7',
        model_id: 'model-x', model_fingerprint: 'sha256:model-x-q4',
        max_tokens: 128, expires_at: nowBase + 600000,
        pools: [{ pool_id: 'pool-tokens', amount: 128 }],
      },
    },
    pools: {
      'pool-tokens': { ceiling: 1000, used: 0, held: 0 },
      'pool-slots': { ceiling: 1, used: 0, held: 0 },
    },
    holds: {},       // hold_id -> { op_id, generation, pool_id, amount, state: held|committed|released|charged }
    operations: {},  // op_id -> record
    byKey: {},       // op_key -> op_id
    fenced: {},      // `${op_id}:${generation}` -> true (start tombstone)
  };
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// faults: { [method]: 'throw' | 'malformed' | 'lost_after_apply' | fn }
// hooks:  { before: { [method]: async fn }, after: { [method]: async fn } }
export function createFakeAuthority(state = baseState(), { faults = {}, hooks = {} } = {}) {
  const calls = [];
  const live = (opId) => state.operations[opId];

  async function step(name, args, apply) {
    calls.push(name);
    if (hooks.before && hooks.before[name]) await hooks.before[name](args);
    const fault = faults[name];
    if (fault === 'throw') throw new Error(`fake ${name}: transport lost before apply`);
    if (fault === 'malformed') return { outcome: 'definitely-maybe' };
    const result = apply();
    if (hooks.after && hooks.after[name]) await hooks.after[name](args, result);
    if (fault === 'lost_after_apply') throw new Error(`fake ${name}: response lost after apply`);
    if (typeof fault === 'function') return fault(result, args);
    return result;
  }

  const authority = {
    calls,
    state,
    revoke(grantId) { // control-plane action, serialized in the same store
      const g = state.grants[grantId];
      g.revoked = true; g.status = 'revoked'; g.revision += 1;
    },
    bumpRevision(grantId) { state.grants[grantId].revision += 1; },
    assertInvariants() {
      for (const [id, p] of Object.entries(state.pools)) {
        if (p.used < 0 || p.held < 0) throw new Error(`negative counter in ${id}`);
        if (p.used + p.held > p.ceiling) throw new Error(`ceiling exceeded in ${id}`);
      }
    },

    resolveAdmission: ({ principal, admission_ref }) => step('resolveAdmission', { principal, admission_ref }, () => {
      const a = state.admissions[admission_ref];
      return a ? clone(a) : null;
    }),

    readGrant: ({ grant_id }) => step('readGrant', { grant_id }, () => {
      const g = state.grants[grant_id];
      return g ? clone(g) : null;
    }),

    claimOperation: (args) => step('claimOperation', args, () => {
      const existing = state.byKey[args.op_key];
      if (existing) return { claimed: false, op: clone(live(existing)) };
      state.seq += 1;
      const op_id = `dispatch-op-${String(state.seq).padStart(6, '0')}`;
      state.operations[op_id] = {
        op_id, op_key: args.op_key, principal_id: args.principal_id, tenant_id: args.tenant_id,
        request_digest: args.request_digest, binding: clone(args.binding), generation: 1,
        phase: 'claimed', job_id: null, uncertain: null, cancel_intent: false, settled: null,
      };
      state.byKey[args.op_key] = op_id;
      return { claimed: true, op: clone(state.operations[op_id]) };
    }),

    getOperation: ({ op_key }) => step('getOperation', { op_key }, () => {
      const id = state.byKey[op_key];
      return id ? clone(live(id)) : null;
    }),

    acquireHold: (args) => step('acquireHold', args, () => {
      const op = live(args.op_id);
      if (!op || op.generation !== args.generation) return { held: false, reason: 'fenced' };
      const pool = state.pools[args.pool_id];
      if (!pool || pool.used + pool.held + args.amount > pool.ceiling) return { held: false, reason: 'insufficient' };
      const hold_id = `hold-${args.op_id}-${args.pool_id}`;
      if (state.holds[hold_id]) return { held: true, hold_id }; // idempotent per (op, pool)
      pool.held += args.amount;
      state.holds[hold_id] = { op_id: args.op_id, generation: args.generation, pool_id: args.pool_id, amount: args.amount, state: 'held' };
      op.phase = 'holding';
      return { held: true, hold_id };
    }),

    // Modeled linearization point: every exact operation-owned hold AND the
    // live grant revision/state are checked and committed in ONE step.
    admit: (args) => step('admit', args, () => {
      const op = live(args.op_id);
      if (!op || op.generation !== args.generation) return { outcome: 'rejected', reason: 'fenced' };
      if (op.phase === 'admitted') return { outcome: 'admitted' };
      const g = state.grants[args.authority.grant_id];
      if (!g || g.status !== 'enforced' || g.revoked !== false || g.revision !== args.authority.grant_revision
        || g.incarnation !== args.authority.incarnation) return { outcome: 'rejected', reason: 'authority_changed' };
      const owned = Object.entries(state.holds).filter(([, h]) => h.op_id === args.op_id && h.generation === args.generation && h.state === 'held');
      const ownedIds = owned.map(([id]) => id).sort();
      if (JSON.stringify(ownedIds) !== JSON.stringify([...args.holds].sort())) return { outcome: 'rejected', reason: 'holds_mismatch' };
      for (const [, h] of owned) h.state = 'committed';
      op.phase = 'admitted';
      return { outcome: 'admitted' };
    }),

    redeemStart: (args) => step('redeemStart', args, () => {
      const op = live(args.op_id);
      if (!op || op.generation !== args.generation) return { outcome: 'refused', reason: 'fenced' };
      if (state.fenced[`${args.op_id}:${args.generation}`]) return { outcome: 'refused', reason: 'fenced' };
      if (op.phase === 'redeemed' || op.phase === 'dispatched') return { outcome: 'redeemed' };
      if (op.phase !== 'admitted') return { outcome: 'refused', reason: 'not_admitted' };
      const g = state.grants[op.binding.grant_id];
      if (!g || g.revoked !== false || g.status !== 'enforced' || g.revision !== op.binding.grant_revision) {
        return { outcome: 'refused', reason: 'revoked' };
      }
      if (args.worker.node_id !== op.binding.node_id || args.worker.runtime_instance !== op.binding.runtime_instance) {
        return { outcome: 'refused', reason: 'worker_mismatch' };
      }
      op.phase = 'redeemed';
      return { outcome: 'redeemed' };
    }),

    fenceStart: (args) => step('fenceStart', args, () => {
      const op = live(args.op_id);
      if (op && (op.phase === 'redeemed' || op.phase === 'dispatched' || op.phase === 'settled')) return { outcome: 'already_redeemed' };
      state.fenced[`${args.op_id}:${args.generation}`] = true;
      return { outcome: 'fenced' };
    }),

    // Releases only this operation's own uncharged holds, and only when no
    // start can still be redeemed (fenced or never admitted).
    releaseHolds: (args) => step('releaseHolds', args, () => {
      const op = live(args.op_id);
      const startable = op && op.phase === 'admitted' && !state.fenced[`${args.op_id}:${args.generation}`];
      if (!op || op.generation !== args.generation || startable
        || ['redeemed', 'dispatched', 'settled'].includes(op.phase)) return { released: 0 };
      let released = 0;
      for (const h of Object.values(state.holds)) {
        if (h.op_id === args.op_id && h.generation === args.generation && (h.state === 'held' || h.state === 'committed')) {
          state.pools[h.pool_id].held -= h.amount; h.state = 'released'; released += 1;
        }
      }
      op.phase = 'released';
      return { released };
    }),

    recordDispatch: (args) => step('recordDispatch', args, () => {
      const op = live(args.op_id);
      if (!op || op.generation !== args.generation || op.phase !== 'redeemed') return { recorded: false };
      op.job_id = args.job_id; op.phase = 'dispatched';
      return { recorded: true };
    }),

    markUncertain: (args) => step('markUncertain', args, () => {
      const op = live(args.op_id);
      if (!op || op.generation !== args.generation) return { recorded: false };
      if (!op.uncertain) op.uncertain = { phase: args.phase, detail: args.detail };
      return { recorded: true };
    }),

    recordCancelIntent: (args) => step('recordCancelIntent', args, () => {
      const op = live(args.op_id);
      if (!op || op.generation !== args.generation) return { recorded: false };
      op.cancel_intent = true;
      return { recorded: true };
    }),

    recheckRelease: (args) => step('recheckRelease', args, () => {
      const op = live(args.op_id);
      if (!op) return { ok: false, reason: 'unknown_operation' };
      const g = state.grants[op.binding.grant_id];
      if (!g || g.status !== 'enforced' || g.revoked !== false || g.revision !== op.binding.grant_revision) {
        return { ok: false, reason: 'authority_revoked_before_release' };
      }
      return { ok: true };
    }),

    // Charges the full admitted envelope exactly once, generation-owned.
    settle: (args) => step('settle', args, () => {
      const op = live(args.op_id);
      if (!op) return { settled: false, reason: 'unknown_operation' };
      if (op.generation !== args.generation) return { settled: false, reason: 'generation_mismatch' };
      if (op.job_id !== args.job_id) return { settled: false, reason: 'job_mismatch' };
      if (op.settled) return { settled: false, reason: 'already_settled' };
      for (const h of Object.values(state.holds)) {
        if (h.op_id === args.op_id && h.generation === args.generation && h.state === 'committed') {
          const pool = state.pools[h.pool_id];
          pool.held -= h.amount; pool.used += h.amount; h.state = 'charged';
        }
      }
      op.settled = { outcome: args.outcome, result_digest: args.result_digest };
      op.phase = 'settled';
      return { settled: true };
    }),
  };
  return authority;
}

export function createResolver(state) {
  const calls = [];
  const resolve = async (authContext) => {
    calls.push(authContext);
    const p = state.principals[authContext];
    return p ? { ...p } : null;
  };
  resolve.calls = calls;
  return resolve;
}

// Fake transport. Models dispatch/poll of a bound CPU task; it is not
// inference and opens no socket. `script` maps job polls to job records.
export function createFakeTransport({ capabilities, dispatchFault = null, jobFor = null } = {}) {
  const sent = [];
  const polls = [];
  let n = 0;
  const transport = {
    capabilities: capabilities || {
      protocol: 'aipster-bound-cpu-internal/1', instance_pin: true, deadline: true, execution_cancel: false,
    },
    sent, polls,
    jobs: {},
    async dispatch(envelope) {
      sent.push(JSON.parse(JSON.stringify(envelope)));
      if (dispatchFault === 'throw') throw new Error('fake transport: connection lost after send');
      if (dispatchFault === 'rejected') return { accepted: false, reason: 'busy' };
      n += 1;
      const job_id = `job-${String(n).padStart(4, '0')}`;
      transport.jobs[job_id] = { envelope, status: 'running' };
      return { accepted: true, job_id };
    },
    async poll({ job_id }) {
      polls.push(job_id);
      const rec = transport.jobs[job_id];
      if (!rec) throw new Error('fake transport: unknown job');
      if (jobFor) return jobFor(job_id, rec.envelope, rec);
      return succeededJob(job_id, rec.envelope);
    },
  };
  return transport;
}

export function succeededJob(job_id, envelope, overrides = {}) {
  const p = envelope.task.placement;
  return {
    id: job_id, node_id: p.node_id, runtime_id: p.runtime_id, model_id: envelope.task.model_id,
    status: 'succeeded',
    result: {
      request_id: job_id, node_id: p.node_id, runtime_id: p.runtime_id, model_id: envelope.task.model_id,
      runtime_instance: envelope.binding.runtime_instance, model_fingerprint: envelope.binding.model_fingerprint,
      simulated: false, content: 'hello', elapsed_ms: 12, usage: { output_tokens: 1 }, cache: {},
      ...overrides,
    },
  };
}

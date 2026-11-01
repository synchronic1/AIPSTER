// Internal admitted-dispatch coordinator: offline lifecycle tests.
// Fake authority/transport only (tests/fixtures/dispatch-authority-fake.mjs);
// nothing here is live inference, a deployed endpoint or real authority.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  baseState, createClock, createFakeAuthority, createFakeTransport, createResolver, nowBase, succeededJob,
} from './fixtures/dispatch-authority-fake.mjs';
import {
  T0 as STORE_T0, RES_1 as STORE_RES, alice as storeAlice, bob as storeBob, createStoreHarness,
  coordinatorOverStore, submitBody as storeBody, workerResult, admittedOperation,
  nextOpKey as storeOpKey,
} from './fixtures/dispatch-store-fixture.mjs';
import { ADMISSION_TTL_MS } from '../src/inference/dispatch-store.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// ---- zero network guard: any real socket/fetch/WebSocket attempt is counted.
const network = { fetch: 0, ws: 0, socket: 0 };
const realFetch = globalThis.fetch;
const realWs = globalThis.WebSocket;
const realConnect = net.Socket.prototype.connect;
globalThis.fetch = async () => { network.fetch += 1; throw new Error('network forbidden in coordinator tests'); };
globalThis.WebSocket = class { constructor() { network.ws += 1; throw new Error('WebSocket forbidden'); } };
net.Socket.prototype.connect = function () { network.socket += 1; throw new Error('socket forbidden'); };
after(() => {
  globalThis.fetch = realFetch; globalThis.WebSocket = realWs; net.Socket.prototype.connect = realConnect;
});
const noNetwork = () => assert.deepEqual(network, { fetch: 0, ws: 0, socket: 0 });

async function load() {
  return import('../src/inference/dispatch-coordinator.mjs');
}

async function setup({ faults, hooks, transport: topts, state = baseState(), clock = createClock() } = {}) {
  const mod = await load();
  const authority = createFakeAuthority(state, { faults, hooks });
  const resolvePrincipal = createResolver(state);
  const transport = createFakeTransport(topts);
  const coord = mod.createDispatchCoordinator({ resolvePrincipal, authority, transport, now: clock.now });
  return { mod, coord, authority, resolvePrincipal, transport, clock, state };
}

const body = (o = {}) => ({
  contract_version: 'v1.0.0', admission_ref: 'adm-alice-1', idempotency_key: 'alice-op-00000001',
  model_id: 'model-x', prompt: 'Reply with exactly: hello', max_tokens: 64, deadline_at: nowBase + 60000, ...o,
});
const pools = (state) => JSON.parse(JSON.stringify(state.pools));
const UNTOUCHED = { 'pool-tokens': { ceiling: 1000, used: 0, held: 0 }, 'pool-slots': { ceiling: 1, used: 0, held: 0 } };

// ------------------------------------------------------------------ default

test('production default supplies no authority/transport and refuses without side effects', async () => {
  const mod = await load();
  const coord = mod.createDispatchCoordinator();
  const out = await coord.submit('ctx-alice', body());
  assert.equal(out.status, 'rejected');
  assert.equal(out.code, 'DISPATCH_UNAVAILABLE');
  assert.deepEqual(out.blocked_by, ['NO_PRINCIPAL_RESOLVER', 'NO_AUTHORITY_STORE', 'NO_TRANSPORT']);
  assert.equal(out.remote_stopped, false);
  assert.equal(mod.DISPATCH_COORDINATOR_INTERFACE, 'aipster-dispatch-coordinator/1');
  noNetwork();
});

test('/api/jobs stays 501 and worker.js does not import the coordinator', async () => {
  const src = readFileSync(path.join(SRC, 'worker.js'), 'utf8');
  assert.ok(!src.includes('dispatch-coordinator'), 'worker.js must not wire the coordinator');
  const { createTestEnv, readJson } = await import('./d1-shim.mjs');
  const t = await createTestEnv();
  const out = await readJson(await t.call('/api/jobs', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { model: 'demo', prompt: 'hi' } }));
  assert.equal(out.status, 501);
  assert.equal(out.json.code, 'INFERENCE_DISABLED');
  noNetwork();
});

// ------------------------------------------------------------------ positive

test('positive admitted fake lifecycle: admit, redeem, bound dispatch, verified result, single charge', async () => {
  const { coord, authority, transport, state } = await setup();
  const out = await coord.submit('ctx-alice', body());
  assert.equal(out.status, 'dispatched', JSON.stringify(out));
  assert.match(out.op_id, /^dispatch-op-/);
  assert.equal(transport.sent.length, 1);
  const env = transport.sent[0];
  assert.equal(env.protocol, 'aipster-bound-cpu-internal/1');
  assert.deepEqual(env.task.placement, { device: 'cpu', node_id: 'node-cpu-1', runtime_id: 'ik-runtime-1' });
  assert.equal(env.task.model_id, 'model-x');
  assert.equal(env.task.allow_simulated, false);
  assert.equal(env.task.idempotency_key, out.op_id);
  assert.deepEqual(env.binding, { op_id: out.op_id, generation: 1, runtime_instance: 'ik-runtime-1#7',
    model_fingerprint: 'sha256:model-x-q4', deadline_at: nowBase + 60000 });
  assert.equal(state.pools['pool-tokens'].held, 128);
  const order = authority.calls.filter((c) => !['getOperation'].includes(c));
  assert.deepEqual(order, ['resolveAdmission', 'readGrant', 'claimOperation', 'acquireHold', 'acquireHold',
    'admit', 'redeemStart', 'recordDispatch']);

  const done = await coord.reconcile('ctx-alice', 'alice-op-00000001');
  assert.equal(done.status, 'settled', JSON.stringify(done));
  assert.equal(done.outcome.finish, 'succeeded');
  assert.equal(done.outcome.released, true);
  assert.equal(done.outcome.content, 'hello');
  assert.deepEqual(done.outcome.provenance, { id: 'job-0001', node_id: 'node-cpu-1', runtime_id: 'ik-runtime-1',
    model_id: 'model-x', runtime_instance: 'ik-runtime-1#7', model_fingerprint: 'sha256:model-x-q4', simulated: false });
  assert.deepEqual(pools(state), { 'pool-tokens': { ceiling: 1000, used: 128, held: 0 }, 'pool-slots': { ceiling: 1, used: 1, held: 0 } });

  // Duplicate/late result: settles once; counters unchanged.
  const again = await coord.reconcile('ctx-alice', 'alice-op-00000001');
  assert.equal(again.status, 'settled');
  assert.deepEqual(pools(state), { 'pool-tokens': { ceiling: 1000, used: 128, held: 0 }, 'pool-slots': { ceiling: 1, used: 1, held: 0 } });
  assert.equal(transport.sent.length, 1);
  authority.assertInvariants();
  noNetwork();
});

// ------------------------------------------------------------- principal/auth

for (const [ctx, code, http] of [
  ['ctx-unknown', 'AUTH_REQUIRED', 401],
  ['ctx-heartbeat', 'KEY_SCOPE', 403],
  ['ctx-alice-read', 'KEY_SCOPE', 403],
  ['ctx-expired', 'KEY_EXPIRED', 401],
]) {
  test(`principal ${ctx} is refused (${code}) before any store or transport call`, async () => {
    const { coord, authority, transport } = await setup();
    const out = await coord.submit(ctx, body());
    assert.equal(out.status, 'rejected');
    assert.equal(out.code, code);
    assert.equal(out.http, http);
    assert.deepEqual(authority.calls, []);
    assert.equal(transport.sent.length, 0);
    noNetwork();
  });
}

test('inference-scoped API key principal is accepted', async () => {
  const { coord } = await setup();
  const out = await coord.submit('ctx-alice-key', body());
  assert.equal(out.status, 'dispatched');
});

test('client-supplied authority is forged and never consulted', async () => {
  const { coord, authority, resolvePrincipal } = await setup();
  for (const forged of [{ authenticated: true }, { admission: { grant_id: 'grant-1' } }, { receipt: {} },
    { grant_id: 'grant-1' }, { principal_id: 'user-alice' }, { tenant_id: 'tenant-a' },
    { placement: { node_id: 'node-cpu-1' } }, { runtime_instance: 'x' }, { server_context: {} }]) {
    const out = await coord.submit('ctx-alice', body(forged));
    assert.equal(out.code, 'FORGED_CLIENT_AUTHORITY', JSON.stringify(forged));
    assert.equal(out.http, 400);
  }
  // A client cannot even become authenticated by claiming it.
  const anon = await coord.submit('ctx-unknown', body({ authenticated: true }));
  assert.equal(anon.code, 'AUTH_REQUIRED');
  assert.deepEqual(authority.calls, []);
  assert.ok(resolvePrincipal.calls.length >= 1);
});

test('foreign-tenant admission and unknown admission are indistinguishable refusals', async () => {
  const { coord, transport } = await setup();
  const foreign = await coord.submit('ctx-bob', body({ admission_ref: 'adm-alice-1' }));
  const missing = await coord.submit('ctx-alice', body({ admission_ref: 'adm-nope' }));
  for (const out of [foreign, missing]) {
    assert.equal(out.status, 'rejected');
    assert.equal(out.code, 'ADMISSION_NOT_AVAILABLE');
    assert.equal(out.http, 403);
  }
  assert.equal(transport.sent.length, 0);
});

// --------------------------------------------------------- request validation

test('versions are distinct: unsupported contract version or field is refused, never stripped', async () => {
  const { coord, authority } = await setup();
  assert.equal((await coord.submit('ctx-alice', body({ contract_version: 'v0.9.0' }))).code, 'UNSUPPORTED_CONTRACT_VERSION');
  const { contract_version: _drop, ...noVersion } = body();
  assert.equal((await coord.submit('ctx-alice', noVersion)).code, 'UNSUPPORTED_CONTRACT_VERSION');
  assert.equal((await coord.submit('ctx-alice', body({ temperature: 0 }))).code, 'UNSUPPORTED_PARAMETER');
  assert.equal((await coord.submit('ctx-alice', body({ stream: true }))).code, 'UNSUPPORTED_CAPABILITY');
  assert.equal((await coord.submit('ctx-alice', body({ extra_field: 1 }))).code, 'UNSUPPORTED_FIELD');
  assert.deepEqual(authority.calls, []);
});

test('deadline must be integer Unix ms, in the future and within 180 s', async () => {
  const { coord, authority } = await setup();
  for (const deadline_at of [nowBase, nowBase - 1, nowBase + 180001, 1.5, '1767225660000', 1600000000000]) {
    const out = await coord.submit('ctx-alice', body({ deadline_at }));
    assert.equal(out.code, 'INVALID_DEADLINE', String(deadline_at));
  }
  assert.deepEqual(authority.calls, []);
});

test('legacy transport without instance pin/deadline is refused before any side effect', async () => {
  const { coord, authority, transport } = await setup({ transport: { capabilities: {
    protocol: 'legacy-eif-execute', instance_pin: false, deadline: false, execution_cancel: false } } });
  const out = await coord.submit('ctx-alice', body());
  assert.equal(out.code, 'TARGET_CAPABILITY_UNSUPPORTED');
  assert.ok(!authority.calls.includes('claimOperation'));
  assert.equal(transport.sent.length, 0);
});

// ------------------------------------------------------- no-stitching/binding

test('no-stitching: the admission grant must cover principal, resource, model and ceiling', async () => {
  for (const mutate of [
    (s) => { s.grants['grant-1'].consumers = ['user-carol']; },
    (s) => { s.grants['grant-1'].models = ['model-y']; },
    (s) => { s.grants['grant-1'].incarnation = 'inc-2'; },
    (s) => { s.grants['grant-1'].ceilings.maxTokens = 32; },
    (s) => { s.grants['grant-1'].status = 'paused'; },
    (s) => { s.grants['grant-1'].revoked = true; },
    (s) => { s.grants['grant-1'].revision = 4; },
    (s) => { delete s.grants['grant-1'].revoked; },
  ]) {
    const state = baseState(); mutate(state);
    const { coord, authority, transport } = await setup({ state });
    const out = await coord.submit('ctx-alice', body());
    assert.equal(out.status, 'rejected', mutate.toString());
    assert.equal(out.code, 'NO_MATCHING_GRANT', mutate.toString());
    assert.ok(!authority.calls.includes('claimOperation'));
    assert.equal(transport.sent.length, 0);
  }
});

test('request must match the admitted binding (model, token ceiling, expiry)', async () => {
  const { coord } = await setup();
  assert.equal((await coord.submit('ctx-alice', body({ model_id: 'model-y' }))).code, 'BINDING_MISMATCH');
  assert.equal((await coord.submit('ctx-alice', body({ max_tokens: 129 }))).code, 'BINDING_MISMATCH');
  const state = baseState(); state.admissions['adm-alice-1'].expires_at = nowBase;
  const s2 = await setup({ state });
  assert.equal((await s2.coord.submit('ctx-alice', body())).code, 'ADMISSION_EXPIRED');
});

test('result binding: foreign or malformed results are never settled', async () => {
  for (const jobFor of [
    (id, env) => succeededJob(id, env, { runtime_instance: 'ik-runtime-1#8' }),
    (id, env) => succeededJob(id, env, { model_fingerprint: 'sha256:other' }),
    (id, env) => ({ ...succeededJob(id, env), node_id: 'node-other' }),
    (id, env) => succeededJob(id, env, { simulated: true }),
    (id, env) => succeededJob(id, env, { request_id: 'job-9999' }),
    () => ({ status: 'succeeded' }),
    () => null,
  ]) {
    const { coord, state } = await setup({ transport: { jobFor } });
    assert.equal((await coord.submit('ctx-alice', body())).status, 'dispatched');
    const out = await coord.reconcile('ctx-alice', 'alice-op-00000001');
    assert.equal(out.status, 'uncertain', jobFor.toString());
    assert.equal(out.code, 'RESULT_REJECTED');
    assert.equal(state.pools['pool-tokens'].used, 0);
    assert.equal(state.pools['pool-tokens'].held, 128); // retained, not released
  }
});

// ------------------------------------------------------- idempotency/replay

test('same key + same operation reconciles without a second dispatch; changed body conflicts', async () => {
  const { coord, transport, state } = await setup();
  const first = await coord.submit('ctx-alice', body());
  const replay = await coord.submit('ctx-alice', body());
  assert.equal(replay.status, 'dispatched');
  assert.equal(replay.op_id, first.op_id);
  assert.equal(transport.sent.length, 1);
  const conflict = await coord.submit('ctx-alice', body({ prompt: 'different' }));
  assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(conflict.http, 409);
  assert.equal(transport.sent.length, 1);
  assert.equal(state.pools['pool-tokens'].held, 128);
});

test('idempotency is principal-scoped: another principal with the same key is a different operation', async () => {
  const state = baseState(); state.grants['grant-1'].consumers.push('user-bob'); // Bob covered by the grant
  const { coord } = await setup({ state });
  const a = await coord.submit('ctx-alice', body());
  const b = await coord.submit('ctx-bob', body({ admission_ref: 'adm-bob-1' }));
  assert.equal(b.status, 'dispatched');
  assert.notEqual(a.op_id, b.op_id);
  // Bob cannot reconcile or cancel Alice's operation by guessing her key.
  assert.equal((await coord.reconcile('ctx-bob', 'alice-op-00000001')).op_id, b.op_id);
});

test('concurrent same-key submissions dispatch exactly once', async () => {
  const { coord, transport, authority } = await setup();
  const outs = await Promise.all([1, 2, 3, 4].map(() => coord.submit('ctx-alice', body())));
  assert.equal(transport.sent.length, 1);
  assert.equal(new Set(outs.map((o) => o.op_id)).size, 1);
  authority.assertInvariants();
});

test('concurrent different operations cannot oversubscribe a single-slot pool', async () => {
  const { coord, transport, state, authority } = await setup();
  const outs = await Promise.all([1, 2, 3].map((n) => coord.submit('ctx-alice', body({ idempotency_key: `alice-op-0000000${n}` }))));
  assert.equal(outs.filter((o) => o.status === 'dispatched').length, 1);
  assert.deepEqual(outs.filter((o) => o.status !== 'dispatched').map((o) => o.code), ['BUDGET_EXHAUSTED', 'BUDGET_EXHAUSTED']);
  assert.equal(transport.sent.length, 1);
  assert.equal(state.pools['pool-slots'].held, 1);
  assert.equal(state.pools['pool-tokens'].held, 128); // losers compensated their own token holds
  authority.assertInvariants();
});

// ------------------------------------------------------------ partial holds

test('partial hold failure compensates only this operation\'s holds', async () => {
  const state = baseState(); state.pools['pool-slots'].ceiling = 0;
  const { coord, transport } = await setup({ state });
  const out = await coord.submit('ctx-alice', body());
  assert.equal(out.code, 'BUDGET_EXHAUSTED');
  assert.deepEqual(pools(state), { 'pool-tokens': { ceiling: 1000, used: 0, held: 0 }, 'pool-slots': { ceiling: 0, used: 0, held: 0 } });
  assert.equal(transport.sent.length, 0);
});

test('unknown hold outcome is uncertain: retained, no compensation guess, no dispatch', async () => {
  const { coord, transport, state } = await setup({ faults: { acquireHold: 'lost_after_apply' } });
  const out = await coord.submit('ctx-alice', body());
  assert.equal(out.status, 'uncertain');
  assert.equal(out.phase, 'holds');
  assert.equal(state.pools['pool-tokens'].held, 128);
  assert.equal(transport.sent.length, 0);
});

// --------------------------------------------------------- CAS outcomes

for (const fault of ['throw', 'malformed', 'lost_after_apply']) {
  test(`admission CAS ${fault}: uncertain, holds retained, no redemption or dispatch`, async () => {
    const { coord, transport, state, authority } = await setup({ faults: { admit: fault } });
    const out = await coord.submit('ctx-alice', body());
    assert.equal(out.status, 'uncertain');
    assert.equal(out.phase, 'admission');
    assert.equal(out.automatic_retry, false);
    assert.ok(!authority.calls.includes('redeemStart'));
    assert.equal(transport.sent.length, 0);
    assert.equal(state.pools['pool-tokens'].held, 128);
    // A retry with the same key reconciles read-only: still no dispatch.
    const again = await coord.submit('ctx-alice', body());
    assert.equal(again.status, 'uncertain');
    assert.equal(transport.sent.length, 0);
    assert.equal(authority.calls.filter((c) => c === 'admit').length, 1);
  });
}

// ------------------------------------------------- revoke in both orders

test('revoke before the admission CAS: admission fails and own holds are compensated', async () => {
  let authority;
  const hooks = { before: { admit: async () => authority.revoke('grant-1') } };
  const s = await setup({ hooks }); authority = s.authority;
  const out = await s.coord.submit('ctx-alice', body());
  assert.equal(out.code, 'ADMISSION_REJECTED');
  assert.deepEqual(pools(s.state), UNTOUCHED);
  assert.equal(s.transport.sent.length, 0);
});

test('admission first, revoke before start redemption: no start, fenced, released, zero sends', async () => {
  let authority;
  const hooks = { before: { redeemStart: async () => authority.revoke('grant-1') } };
  const s = await setup({ hooks }); authority = s.authority;
  const out = await s.coord.submit('ctx-alice', body());
  assert.equal(out.code, 'START_REFUSED');
  assert.ok(s.authority.calls.includes('fenceStart'));
  assert.deepEqual(pools(s.state), UNTOUCHED);
  assert.equal(s.transport.sent.length, 0);
});

test('redemption first, revoke after: work proceeds but the result is withheld at release', async () => {
  let authority;
  const hooks = { after: { redeemStart: async () => authority.revoke('grant-1') } };
  const s = await setup({ hooks }); authority = s.authority;
  assert.equal((await s.coord.submit('ctx-alice', body())).status, 'dispatched');
  const out = await s.coord.reconcile('ctx-alice', 'alice-op-00000001');
  assert.equal(out.status, 'settled');
  assert.equal(out.outcome.released, false);
  assert.equal(out.outcome.content, undefined);
  assert.equal(out.outcome.withheld_reason, 'authority_revoked_before_release');
  assert.equal(s.state.pools['pool-tokens'].used, 128); // compute may have run: charged once
});

test('unknown start redemption: uncertain, holds retained, no dispatch', async () => {
  const { coord, transport, state } = await setup({ faults: { redeemStart: 'lost_after_apply' } });
  const out = await coord.submit('ctx-alice', body());
  assert.equal(out.status, 'uncertain');
  assert.equal(out.phase, 'start');
  assert.equal(transport.sent.length, 0);
  assert.equal(state.pools['pool-tokens'].held, 128);
});

// ---------------------------------------------- deadline/cancel

test('deadline passes before redemption: start fenced, holds released, nothing sent', async () => {
  const clock = createClock();
  const hooks = { after: { admit: async () => { clock.advance(61000); } } };
  const s = await setup({ hooks, clock });
  const out = await s.coord.submit('ctx-alice', body());
  assert.equal(out.status, 'expired_before_start');
  assert.deepEqual(pools(s.state), UNTOUCHED);
  assert.equal(s.transport.sent.length, 0);
});

test('cancel before redemption fences the start; the in-flight submit cannot start', async () => {
  let coordRef;
  let cancelOut;
  const hooks = { before: { redeemStart: async () => { cancelOut = await coordRef.cancel('ctx-alice', 'alice-op-00000001'); } } };
  const s = await setup({ hooks }); coordRef = s.coord;
  const out = await s.coord.submit('ctx-alice', body());
  assert.equal(cancelOut.status, 'cancelled_before_start');
  assert.equal(cancelOut.remote_stopped, false);
  assert.equal(out.status, 'cancelled_before_start');
  assert.deepEqual(pools(s.state), UNTOUCHED);
  assert.equal(s.transport.sent.length, 0);
});

test('cancel after dispatch is an unsupported capability; holds retained, remote not stopped', async () => {
  const { coord, state, authority } = await setup();
  await coord.submit('ctx-alice', body());
  const out = await coord.cancel('ctx-alice', 'alice-op-00000001');
  assert.equal(out.status, 'dispatched');
  assert.equal(out.cancel, 'UNSUPPORTED_CAPABILITY');
  assert.equal(out.remote_stopped, false);
  assert.equal(state.pools['pool-tokens'].held, 128);
  assert.ok(authority.calls.includes('recordCancelIntent'));
  assert.equal(state.operations[out.op_id].cancel_intent, true);
});

test('deadline passes while running: uncertain, holds retained, remote not claimed stopped', async () => {
  const clock = createClock();
  const s = await setup({ clock, transport: { jobFor: (id, env) => ({ ...succeededJob(id, env), status: 'running', result: undefined }) } });
  await s.coord.submit('ctx-alice', body());
  assert.equal((await s.coord.reconcile('ctx-alice', 'alice-op-00000001')).status, 'dispatched');
  clock.advance(61000);
  const out = await s.coord.reconcile('ctx-alice', 'alice-op-00000001');
  assert.equal(out.status, 'uncertain');
  assert.equal(out.phase, 'deadline');
  assert.equal(out.remote_stopped, false);
  assert.equal(s.state.pools['pool-tokens'].held, 128);
});

test('terminal failed job settles once with the full envelope charged and no content', async () => {
  const { coord, state } = await setup({ transport: { jobFor: (id, env) => ({ ...succeededJob(id, env), status: 'failed' }) } });
  await coord.submit('ctx-alice', body());
  const out = await coord.reconcile('ctx-alice', 'alice-op-00000001');
  assert.equal(out.status, 'settled');
  assert.equal(out.outcome.finish, 'failed');
  assert.equal(out.outcome.content, undefined);
  assert.equal(state.pools['pool-tokens'].used, 128);
});

// ---------------------------------------- lost responses and restart

test('dispatch connection lost: uncertain, no automatic resend, holds retained', async () => {
  const { coord, transport, state } = await setup({ transport: { dispatchFault: 'throw' } });
  const out = await coord.submit('ctx-alice', body());
  assert.equal(out.status, 'uncertain');
  assert.equal(out.phase, 'dispatch');
  assert.equal(out.remote_stopped, false);
  assert.equal((await coord.submit('ctx-alice', body())).status, 'uncertain');
  assert.equal((await coord.reconcile('ctx-alice', 'alice-op-00000001')).status, 'uncertain');
  assert.equal(transport.sent.length, 1);
  assert.equal(state.pools['pool-tokens'].held, 128);
});

test('lost claim response: the same key later reconciles to the one recorded operation', async () => {
  const s = await setup({ faults: { claimOperation: 'lost_after_apply' } });
  const out = await s.coord.submit('ctx-alice', body());
  assert.equal(out.status, 'uncertain');
  assert.equal(out.phase, 'claim');
  const mod = await load();
  const authority = createFakeAuthority(s.state);
  const coord2 = mod.createDispatchCoordinator({ resolvePrincipal: createResolver(s.state), authority, transport: s.transport, now: s.clock.now });
  const again = await coord2.submit('ctx-alice', body());
  assert.notEqual(again.status, 'dispatched'); // never resumes an unknown step automatically
  assert.equal(Object.keys(s.state.operations).length, 1);
  assert.equal(s.transport.sent.length, 0);
});

test('restart with retained store state: dispatched op reconciles and settles; no redispatch', async () => {
  const s = await setup();
  await s.coord.submit('ctx-alice', body());
  const mod = await load();
  const coord2 = mod.createDispatchCoordinator({
    resolvePrincipal: createResolver(s.state), authority: createFakeAuthority(s.state), transport: s.transport, now: s.clock.now });
  assert.equal((await coord2.submit('ctx-alice', body())).status, 'dispatched');
  const out = await coord2.reconcile('ctx-alice', 'alice-op-00000001');
  assert.equal(out.status, 'settled');
  assert.equal(s.transport.sent.length, 1);
  assert.equal(s.state.pools['pool-tokens'].used, 128);
});

test('restart during uncertain dispatch keeps holds and never redispatches', async () => {
  const s = await setup({ transport: { dispatchFault: 'throw' } });
  await s.coord.submit('ctx-alice', body());
  const mod = await load();
  const transport2 = createFakeTransport();
  const coord2 = mod.createDispatchCoordinator({
    resolvePrincipal: createResolver(s.state), authority: createFakeAuthority(s.state), transport: transport2, now: s.clock.now });
  assert.equal((await coord2.submit('ctx-alice', body())).status, 'uncertain');
  assert.equal(transport2.sent.length, 0);
  assert.equal(s.state.pools['pool-tokens'].held, 128);
});

test('late settlement from a superseded generation cannot charge', async () => {
  const { coord, state, authority } = await setup();
  await coord.submit('ctx-alice', body());
  const op = Object.values(state.operations)[0];
  const r = await authority.settle({ op_id: op.op_id, generation: 2, job_id: op.job_id, outcome: 'succeeded', result_digest: 'x' });
  assert.equal(r.settled, false);
  assert.equal(state.pools['pool-tokens'].used, 0);
  assert.equal((await coord.reconcile('ctx-alice', 'alice-op-00000001')).status, 'settled');
  assert.equal(state.pools['pool-tokens'].used, 128);
  authority.assertInvariants();
});

test('malformed store responses never read as success', async () => {
  const s = await setup({ faults: { claimOperation: () => ({ claimed: 'yes' }) } });
  assert.equal((await s.coord.submit('ctx-alice', body())).status, 'uncertain');
  const s2 = await setup({ faults: { redeemStart: () => ({ outcome: 'REDEEMED' }) } });
  const out = await s2.coord.submit('ctx-alice', body());
  assert.equal(out.status, 'uncertain');
  assert.equal(s2.transport.sent.length, 0);
});

// ---- parameterized run 2: the SAME coordinator object against the real D1
// store (migration 0024 + src/inference/dispatch-store.mjs). The fake suite
// above remains the exhaustive contract test; this section proves the store
// implements the same boundary for the flows the fake only models, and runs
// under the same zero-network guard.

test('real store: positive lifecycle via the coordinator, settle once, no redispatch', async () => {
  const h = createStoreHarness();
  const { coordinator } = coordinatorOverStore(h);
  const admission = await h.store.issueAdmission({
    principal: storeAlice, resource_id: STORE_RES, model_id: 'model-x', max_tokens: 64,
  });
  const b = storeBody(admission);
  const sent = await coordinator.submit('ctx-alice', b);
  assert.equal(sent.status, 'dispatched');
  assert.equal(sent.automatic_retry, false);

  const replay = await coordinator.submit('ctx-alice', b);
  assert.equal(replay.status, 'dispatched');
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').get().n, 1);

  const frame = await h.store.leaseNextJob({ resource_id: STORE_RES });
  assert.equal(frame.job_id, sent.job_id);
  assert.equal(frame.envelope.binding.op_id, sent.op_id);
  assert.equal(frame.envelope.binding.deadline_at, b.deadline_at);
  assert.deepEqual(await h.store.completeJob({
    job_id: frame.job_id, lease_id: frame.lease_id, resource_id: STORE_RES, status: 'succeeded',
    result: workerResult(frame),
  }), { accepted: true });

  const settled = await coordinator.reconcile('ctx-alice', b.idempotency_key);
  assert.equal(settled.status, 'settled');
  assert.equal(settled.outcome.finish, 'succeeded');
  assert.equal(settled.outcome.released, true);
  assert.equal(settled.outcome.content, 'hello from the worker');
  assert.equal((await coordinator.reconcile('ctx-alice', b.idempotency_key)).status, 'settled');
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_settlements').get().n, 1);
  assert.equal(h.sqlite.prepare("SELECT used_tokens FROM dispatch_pool_usage").get().used_tokens, 64);
  noNetwork();
});

test('real store: expiry, foreign principal and changed body are refusals, not dispatches', async () => {
  const h = createStoreHarness();
  const { coordinator } = coordinatorOverStore(h);
  const admission = await h.store.issueAdmission({
    principal: storeAlice, resource_id: STORE_RES, model_id: 'model-x', max_tokens: 64,
  });
  const b = storeBody(admission);
  assert.equal((await coordinator.submit('ctx-alice', b)).status, 'dispatched');

  assert.equal((await coordinator.submit('ctx-alice', { ...b, prompt: 'changed' })).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await coordinator.submit('ctx-bob', b)).code, 'ADMISSION_NOT_AVAILABLE');
  h.clock.advance(ADMISSION_TTL_MS);
  const expired = await coordinator.submit('ctx-alice', {
    ...storeBody(admission), deadline_at: h.clock.now() + 60000,
  });
  assert.equal(expired.code, 'ADMISSION_EXPIRED');
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').get().n, 1);
  noNetwork();
});

test('real store: revoke before redemption refuses the start and releases the hold', async () => {
  const h = createStoreHarness();
  const admission = await h.store.issueAdmission({
    principal: storeBob, resource_id: STORE_RES, model_id: 'model-x', max_tokens: 128, grant: 'grant-1',
  });
  const b = storeBody(admission);
  const authority = Object.assign({}, h.store, {
    redeemStart: async (args) => {
      h.sqlite.prepare('UPDATE grants SET revoked_at = ? WHERE id = ?').run(new Date(h.clock.now()).toISOString(), 'grant-1');
      return h.store.redeemStart(args);
    },
  });
  const mod = await load();
  const coord = mod.createDispatchCoordinator({
    resolvePrincipal: async () => ({ ...storeBob }),
    authority,
    transport: {
      capabilities: { protocol: 'aipster-bound-cpu-internal/1', instance_pin: true, deadline: true },
      dispatch: () => { throw new Error('must not dispatch after a refused start'); },
      poll: () => null,
    },
    now: h.clock.now,
  });
  const out = await coord.submit('ctx-bob', b);
  assert.equal(out.status, 'rejected');
  assert.equal(out.code, 'START_REFUSED');
  assert.equal(out.reason, 'revoked');
  assert.equal(h.sqlite.prepare('SELECT used_tokens FROM grants WHERE id = ?').get('grant-1').used_tokens, 0);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_start_redemptions').get().n, 0);
  noNetwork();
});

test('real store: deadline before redemption fences and releases without dispatch', async () => {
  const h = createStoreHarness();
  const admission = await h.store.issueAdmission({
    principal: storeAlice, resource_id: STORE_RES, model_id: 'model-x', max_tokens: 64,
  });
  const b = storeBody(admission, { deadline_at: STORE_T0 + 1000 });
  const authority = Object.assign({}, h.store, {
    admit: async (args) => {
      const out = await h.store.admit(args);
      h.clock.advance(2000);
      return out;
    },
  });
  const mod = await load();
  const coord = mod.createDispatchCoordinator({
    resolvePrincipal: async () => ({ ...storeAlice }),
    authority,
    transport: {
      capabilities: { protocol: 'aipster-bound-cpu-internal/1', instance_pin: true, deadline: true },
      dispatch: () => { throw new Error('must not dispatch after the deadline'); },
      poll: () => null,
    },
    now: h.clock.now,
  });
  const out = await coord.submit('ctx-alice', b);
  assert.equal(out.status, 'expired_before_start');
  assert.equal(out.code, 'DEADLINE_EXCEEDED');
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').get().n, 0);
  assert.equal(h.sqlite.prepare('SELECT used_tokens FROM dispatch_pool_usage').get().used_tokens, 0);
  noNetwork();
});

test('real store: cancel before redemption fences and releases; after dispatch it is unsupported', async () => {
  const h = createStoreHarness();
  const { coordinator } = coordinatorOverStore(h);
  const key = storeOpKey('cancel');
  const pending = await admittedOperation(h, {
    principal: storeAlice, max_tokens: 64, op_key: JSON.stringify([storeAlice.principal_id, key]),
  });
  assert.equal(pending.admitted.outcome, 'admitted');
  const cancelled = await coordinator.cancel('ctx-alice', key);
  assert.equal(cancelled.status, 'cancelled_before_start');
  assert.equal(h.sqlite.prepare('SELECT used_tokens FROM dispatch_pool_usage').get().used_tokens, 0);
  assert.equal((await h.store.getOperation({ op_key: JSON.stringify([storeAlice.principal_id, key]) })).phase, 'released');

  const admission = await h.store.issueAdmission({
    principal: storeAlice, resource_id: STORE_RES, model_id: 'model-x', max_tokens: 32,
  });
  const b = storeBody(admission);
  assert.equal((await coordinator.submit('ctx-alice', b)).status, 'dispatched');
  const after = await coordinator.cancel('ctx-alice', b.idempotency_key);
  assert.equal(after.cancel, 'UNSUPPORTED_CAPABILITY');
  assert.equal(h.sqlite.prepare('SELECT used_tokens FROM dispatch_pool_usage').get().used_tokens, 32);
  noNetwork();
});

test('no real network was attempted by any test in this file', () => noNetwork());

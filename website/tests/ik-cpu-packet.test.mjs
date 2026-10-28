import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateQualificationPacket, qualificationReadiness } from '../scripts/qualification/ik-cpu-packet.mjs';
const now = 1_000_000;
// Explicitly synthetic budgets, identities and receipts; no machine measurement.
const fixture = () => ({ adapterRevision: 'a'.repeat(40), workerRevision: 'b'.repeat(40),
  engineRevision: 'c'.repeat(40), modelSha256: 'd'.repeat(64), resourceId: 'fixture-resource',
  workerId: 'fixture-worker', runtimeId: 'fixture-runtime', modelId: 'fixture-model',
  authorizationReceipt: 'fixture-only', device: 'cpu', gpuLayers: 0, concurrency: 1,
  threads: 4, observedAtMs: now, healthy: true, modelAvailable: true, idle: true,
  availableRamBytes: 8192, modelRuntimeKvBytes: 4096, headroomBytes: 1024,
  contextTokens: 2048, inputTokens: 10, outputTokens: 64, timeoutMs: 180000,
  cpuSecondsBudget: 720, requestCount: 1, automaticRetries: 0, paidCompute: false,
  operationKey: 'fixture-operation' });

test('default checks do not inspect a packet or dispatch', () => {
  const packet = new Proxy({}, { get() { throw new Error('must not read packet'); } });
  assert.deepEqual(qualificationReadiness({ packet }), { status: 'disabled', requests: 0 });
});
test('valid offline packet reuses parent request codec; it is not permission or live proof', () => {
  const task = validateQualificationPacket(fixture(), now);
  assert.equal(task.prompt, 'Reply with exactly: hello');
  assert.equal(task.allow_simulated, false);
  assert.equal(task.max_tokens, 64);
});
test('explicit opt-in stays blocked even with a complete packet', () => {
  assert.deepEqual(qualificationReadiness({ optIn: true, packet: fixture(), now }),
    { status: 'blocked', code: 'AIPSTER_EXECUTION_CONTRACT_MISSING', requests: 0 });
});
for (const [name, change] of Object.entries({
  revision: { workerRevision: 'main' }, model: { modelSha256: '' }, authorization: { authorizationReceipt: '' },
  gpu: { gpuLayers: 1 }, parallel: { concurrency: 2 }, threads: { threads: 5 },
  stale: { observedAtMs: now - 60001 }, future: { observedAtMs: now + 1 }, health: { healthy: false },
  unavailable: { modelAvailable: false }, busy: { idle: false }, ram: { availableRamBytes: 4000 },
  headroom: { headroomBytes: 0 }, context: { inputTokens: 2048 }, output: { outputTokens: 65 },
  timeout: { timeoutMs: 180001 }, cpuBudget: { cpuSecondsBudget: 719 },
  duplicate: { requestCount: 2 }, retry: { automaticRetries: 1 }, paid: { paidCompute: true }
})) test('rejects unsafe packet: ' + name, () => {
  assert.throws(() => validateQualificationPacket({ ...fixture(), ...change }, now));
});

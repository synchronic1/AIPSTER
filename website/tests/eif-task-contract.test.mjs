import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCpuTask, decodeCpuTask, classifyTransportOutcome } from '../src/inference/eif-task-contract.mjs';
const expected = { id: 'task-1', node_id: 'cpu-fixture', runtime_id: 'ik-fixture', model_id: 'model-fixture' };
const result = () => ({ ...expected, status: 'succeeded', result: { request_id: expected.id,
  node_id: expected.node_id, runtime_id: expected.runtime_id, model_id: expected.model_id,
  simulated: false, content: 'hello', elapsed_ms: 1, cache: {}, usage: {} } });
const input = { modelId: expected.model_id, prompt: 'Reply hello', maxTokens: 64, operationKey: 'operation-0001' };
test('encodes bounded real-only completion and preserves operation key on replay', () => {
  const task = encodeCpuTask(input);
  assert.deepEqual(task, encodeCpuTask(input));
  assert.equal(task.allow_simulated, false);
  assert.equal(task.idempotency_key, input.operationKey);
  assert.equal('node_id' in task, false);
});
for (const bad of [{ modelId: '' }, { maxTokens: 0 }, { maxTokens: 4097 }, { maxTokens: 1.5 },
  { prompt: '' }, { prompt: 'x'.repeat(65537) }, { operationKey: '' }]) {
  test('rejects invalid task field ' + Object.keys(bad)[0] + JSON.stringify(bad).length,
    () => assert.throws(() => encodeCpuTask({ ...input, ...bad }), /INVALID_EIF_CONTRACT/));
}
test('decodes a controlled successful CPU envelope; this is not inference', () => {
  assert.equal(decodeCpuTask(result(), expected).content, 'hello');
});
test('does not reflect caller metadata or private upstream diagnostic fields', () => {
  const job = result(); job.privateDiagnostic = 'private';
  const decoded = decodeCpuTask(job, { ...expected, credential: 'private' });
  assert.deepEqual(decoded.provenance, { ...expected, simulated: false });
  assert.ok(!JSON.stringify(decoded).includes('private'));
});
test('rejects oversized results and unknown terminal status', () => {
  const job = result(); job.result.content = 'x'.repeat(1024 * 1024);
  assert.throws(() => decodeCpuTask(job, expected), /INVALID_EIF_CONTRACT/);
  assert.throws(() => decodeCpuTask({ ...expected, status: 'cancelled' }, expected), /INVALID_EIF_CONTRACT/);
});
for (const field of ['id', 'node_id', 'runtime_id', 'model_id']) {
  test('rejects wrong outer assignment ' + field, () => {
    const job = result(); job[field] = 'wrong'; assert.throws(() => decodeCpuTask(job, expected));
  });
}
for (const change of [{ request_id: 'wrong' }, { node_id: 'wrong' }, { runtime_id: 'wrong' },
  { model_id: 'wrong' }, { simulated: true }, { simulated: undefined }, { truncated: true },
  { content: ' ' }, { elapsed_ms: -1 }, { usage: null }, { cache: [] }]) {
  test('rejects malformed result ' + Object.keys(change)[0] + String(Object.values(change)[0]), () => {
    const job = result(); Object.assign(job.result, change); assert.throws(() => decodeCpuTask(job, expected));
  });
}
test('failed and expired polls never become success or reflect private error text', () => {
  for (const status of ['running', 'failed', 'expired']) {
    assert.deepEqual(decodeCpuTask({ ...expected, status, error: 'private diagnostic' }, expected), { status });
  }
});
test('timeout, cancellation and connection loss never authorize a retry or claim remote stop', () => {
  for (const outcome of ['timeout', 'cancelled', 'connection_lost']) {
    assert.deepEqual(classifyTransportOutcome(outcome), { status: 'uncertain', automaticRetry: false, remoteStopped: false });
  }
});

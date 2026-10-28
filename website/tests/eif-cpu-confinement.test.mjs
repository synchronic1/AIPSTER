import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBoundCpuTask, classifyTransportOutcome } from '../src/inference/eif-task-contract.mjs';
import { createTestEnv, readJson } from './d1-shim.mjs';
const input = { modelId: 'fixture-model', prompt: 'Reply hello', maxTokens: 64, operationKey: 'cpu-operation-1' };
const target = { device: 'cpu', nodeId: 'fixture-node', runtimeId: 'fixture-runtime' };
test('CPU wire binding preserves explicit target, model, no-simulation and operation key', () => {
  assert.deepEqual(encodeBoundCpuTask(input, target), {
    capability: 'complete', model_id: 'fixture-model', prompt: 'Reply hello', max_tokens: 64,
    temperature: 0, allow_simulated: false, idempotency_key: 'cpu-operation-1',
    placement: { device: 'cpu', node_id: 'fixture-node', runtime_id: 'fixture-runtime' },
  });
});
for (const bad of [null, {}, { ...target, device: 'gpu' }, { ...target, nodeId: '' },
  { ...target, runtimeId: 'wrong\u0000target' }, { ...target, endpoint: 'https://untrusted.invalid' },
  { ...target, owner: 'caller-assertion' }]) {
  test('invalid binding fails closed: ' + JSON.stringify(bad), () => {
    assert.throws(() => encodeBoundCpuTask(input, bad), /INVALID_EIF_CONTRACT/);
  });
}
test('model is required and unknown submit remains uncertain; no unbound fallback', () => {
  assert.throws(() => encodeBoundCpuTask({ ...input, modelId: '' }, target));
  assert.deepEqual(classifyTransportOutcome('connection_lost'), {
    status: 'uncertain', automaticRetry: false, remoteStopped: false,
  });
});
test('concurrent valid-looking bound submissions cannot bypass missing atomic admission', async () => {
  const t = await createTestEnv({ EIF_CPU_ENABLED: '1' });
  const fetchBefore = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('no transport is authorized'); };
  try {
    const payload = encodeBoundCpuTask(input, target);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => t.call('/api/jobs', {
      method: 'POST', headers: { ...t.as(t.alice), ...t.csrf },
      body: { ...payload, resourceId: 'fixture-resource', grantId: 'asserted-grant', idempotencyKey: `attempt-${i}` },
    }).then(readJson)));
    assert.ok(results.every(r => r.status === 501 && r.json.code === 'INFERENCE_DISABLED'));
    assert.equal((await t.DB.prepare('SELECT id FROM jobs').all()).results.length, 0);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = fetchBefore; t.sqlite.close(); }
});

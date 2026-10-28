// Protocol codec only. No transport, credentials, placement or authorization.
// Callers must not treat a valid envelope as proof of an admitted CPU resource.
const fail = () => { throw new Error('INVALID_EIF_CONTRACT'); };
const id = x => typeof x === 'string' && x.length > 0 && x.length <= 256;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);

export function encodeCpuTask({ modelId, prompt, maxTokens, operationKey }) {
  if (!id(modelId) || typeof prompt !== 'string' || !prompt.trim()
    || prompt.length > 65536 || !Number.isInteger(maxTokens)
    || maxTokens < 1 || maxTokens > 4096
    || typeof operationKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(operationKey)) fail();
  // The protocol deliberately has no node_id/runtime_id selector. Confinement
  // must be supplied by the fabric owner before this can be dispatched.
  return { capability: 'complete', model_id: modelId, prompt, max_tokens: maxTokens,
    temperature: 0, allow_simulated: false, idempotency_key: operationKey };
}

export function decodeCpuTask(job, expected) {
  if (!object(job) || !object(expected)
    || !['id', 'node_id', 'runtime_id', 'model_id'].every(k => id(expected[k]) && job[k] === expected[k])) fail();
  if (job.status === 'running') return { status: 'running' };
  if (job.status === 'failed' || job.status === 'expired') return { status: job.status };
  if (job.status !== 'succeeded' || !object(job.result)) fail();
  const r = job.result;
  if (r.request_id !== expected.id || !['node_id', 'runtime_id', 'model_id'].every(k => r[k] === expected[k])
    || r.simulated !== false || (r.truncated !== undefined && r.truncated !== false)
    || typeof r.content !== 'string' || !r.content.trim()
    || !Number.isFinite(r.elapsed_ms) || r.elapsed_ms < 0 || !object(r.usage) || !object(r.cache)
    || new TextEncoder().encode(JSON.stringify(job)).byteLength > 1024 * 1024) fail();
  return { status: 'succeeded', content: r.content, provenance: {
    id: expected.id, node_id: expected.node_id, runtime_id: expected.runtime_id,
    model_id: expected.model_id, simulated: false,
  }, elapsedMs: r.elapsed_ms };
}

// A timeout/abort does not establish that remote execution stopped. Recovery
// requires a durable owner-scoped operation binding, absent from main today.
export function classifyTransportOutcome(outcome) {
  if (!['timeout', 'cancelled', 'connection_lost'].includes(outcome)) fail();
  return { status: 'uncertain', automaticRetry: false, remoteStopped: false };
}

// Wire encoding only. The target must eventually come from durable admitted
// state, never browser input. This does not authorize, reserve, or dispatch.
export function encodeBoundCpuTask(input, target) {
  if (!object(target) || Object.keys(target).some(k => !['device', 'nodeId', 'runtimeId'].includes(k))
    || target.device !== 'cpu'
    || ![target.nodeId, target.runtimeId].every(v => typeof v === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v))) fail();
  return { ...encodeCpuTask(input), placement: {
    device: 'cpu', node_id: target.nodeId, runtime_id: target.runtimeId,
  } };
}

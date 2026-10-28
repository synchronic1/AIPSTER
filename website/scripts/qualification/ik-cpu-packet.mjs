// Offline packet validation only. Operator claims are not worker attestation,
// authorization, or a substitute for server-side admission.
import { encodeCpuTask } from '../../src/inference/eif-task-contract.mjs';
const reject = code => { throw new Error(code); };
const sha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const positive = x => Number.isSafeInteger(x) && x > 0;
const named = x => typeof x === 'string' && x.trim().length > 0 && x.length <= 256;

export function validateQualificationPacket(p, now = Date.now()) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) reject('PACKET_REQUIRED');
  if (![p.adapterRevision, p.workerRevision, p.engineRevision].every(sha)
    || !digest(p.modelSha256)) reject('REVISION_OR_MODEL_IDENTITY_REQUIRED');
  if (![p.resourceId, p.workerId, p.runtimeId, p.modelId, p.authorizationReceipt].every(named)) reject('IDENTITY_OR_AUTHORIZATION_REQUIRED');
  if (p.device !== 'cpu' || p.gpuLayers !== 0 || p.concurrency !== 1
    || !positive(p.threads) || p.threads > 4) reject('CPU_LIMITS_INVALID');
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(p.observedAtMs)
    || p.observedAtMs > now || now - p.observedAtMs > 60_000
    || p.healthy !== true || p.modelAvailable !== true || p.idle !== true) reject('FRESH_CAPABILITY_REQUIRED');
  if (!positive(p.availableRamBytes) || !positive(p.modelRuntimeKvBytes)
    || !positive(p.headroomBytes) || p.modelRuntimeKvBytes > p.availableRamBytes
    || p.headroomBytes > p.availableRamBytes - p.modelRuntimeKvBytes) reject('RAM_BUDGET_INVALID');
  if (p.contextTokens !== 2048 || !positive(p.inputTokens) || p.outputTokens !== 64
    || p.inputTokens > p.contextTokens - p.outputTokens) reject('CONTEXT_BUDGET_INVALID');
  if (!positive(p.timeoutMs) || p.timeoutMs > 180_000 || !positive(p.cpuSecondsBudget)
    || p.cpuSecondsBudget > 720 || p.cpuSecondsBudget * 1000 < p.threads * p.timeoutMs
    || p.requestCount !== 1 || p.automaticRetries !== 0 || p.paidCompute !== false) reject('EXECUTION_BUDGET_INVALID');
  return encodeCpuTask({ modelId: p.modelId, prompt: 'Reply with exactly: hello',
    maxTokens: p.outputTokens, operationKey: p.operationKey });
}

// There is intentionally no injected transport or bypass flag. PR #7 is a
// codec prerequisite, not a connected authenticated AIPSTER execution route.
export function qualificationReadiness({ optIn = false, packet, now } = {}) {
  if (!optIn) return { status: 'disabled', requests: 0 };
  validateQualificationPacket(packet, now);
  return { status: 'blocked', code: 'AIPSTER_EXECUTION_CONTRACT_MISSING', requests: 0 };
}

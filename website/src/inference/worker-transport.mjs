// Worker-pull transport for the admitted-dispatch coordinator.
//
// Capabilities are exactly the internal bound-CPU protocol the coordinator
// requires; a transport without them is refused before any side effect.
// dispatch() enqueues the bound envelope through the L1 store, and poll()
// reads the EIF-shaped job row by job id. This module owns no authority: the
// store decides leasing, binding and exactly-once completion, and the
// coordinator decides settlement and release.
import { TRANSPORT_PROTOCOL } from './dispatch-coordinator.mjs';

export const WORKER_TRANSPORT_CAPABILITIES = Object.freeze({
  protocol: TRANSPORT_PROTOCOL,
  instance_pin: true,
  deadline: true,
});

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_ID_MAX = 256;
// Shared with the store's result normalizer (dispatch-store.mjs) so the HTTP
// validator and the durable store accept exactly the same completions.
export const CONTENT_MAX = 65536;
export const WORKER_RESULT_MAX_BYTES = 1024 * 1024;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x, max = MODEL_ID_MAX) => typeof x === 'string' && x.length > 0 && x.length <= max;

/**
 * Build the transport the coordinator calls. The store must implement the L1
 * interface methods used here (enqueueJob, readJob).
 */
export function createWorkerTransport(store) {
  if (!isObj(store) || typeof store.enqueueJob !== 'function' || typeof store.readJob !== 'function') {
    throw new TypeError('createWorkerTransport requires a dispatch store with enqueueJob and readJob');
  }
  return Object.freeze({
    capabilities: WORKER_TRANSPORT_CAPABILITIES,
    // Pass the envelope through unchanged: the coordinator never downgrades
    // or strips the instance/fingerprint/deadline binding.
    dispatch: (envelope) => store.enqueueJob(envelope),
    poll: ({ job_id } = {}) => store.readJob({ job_id }),
  });
}

function invalid(code, message, http = 400) {
  return { ok: false, code, message, http };
}

function validSucceededResult(result) {
  if (!isObj(result)) return false;
  const allowed = new Set(['request_id', 'node_id', 'runtime_id', 'model_id', 'runtime_instance',
    'model_fingerprint', 'simulated', 'content', 'elapsed_ms', 'usage', 'cache', 'truncated']);
  if (Object.keys(result).some((k) => !allowed.has(k))) return false;
  if (!isStr(result.request_id) || !isStr(result.node_id) || !isStr(result.runtime_id) || !isStr(result.model_id)) return false;
  if (!isStr(result.runtime_instance) || !isStr(result.model_fingerprint)) return false;
  if (result.simulated !== false) return false; // never report simulated execution as success
  if (result.truncated !== undefined && result.truncated !== false) return false;
  if (typeof result.content !== 'string' || !result.content.trim() || result.content.length > CONTENT_MAX) return false;
  if (!Number.isFinite(result.elapsed_ms) || result.elapsed_ms < 0) return false;
  if (!isObj(result.usage) || !isObj(result.cache)) return false;
  return true;
}

function validFailedResult(result) {
  if (!isObj(result)) return false;
  const allowed = new Set(['reason', 'detail', 'elapsed_ms', 'usage', 'cache']);
  if (Object.keys(result).some((k) => !allowed.has(k))) return false;
  return isStr(result.reason, 128);
}

/**
 * Strictly validate a worker result report: exactly {lease_id, status,
 * result}, status succeeded|failed, an EIF-shaped result for success, and a
 * 1 MiB wire cap for the whole body.
 * @returns {{ok:true, value:object} | {ok:false, code:string, message:string, http:number}}
 */
export function validateWorkerResultReport(body) {
  if (!isObj(body)) return invalid('INVALID_RESULT', 'A JSON object is required.');
  const keys = Object.keys(body);
  if (keys.length !== 3 || keys.some((k) => !['lease_id', 'status', 'result'].includes(k))) {
    return invalid('INVALID_RESULT', 'The report must contain only lease_id, status and result.');
  }
  if (typeof body.lease_id !== 'string' || !ID_RE.test(body.lease_id)) {
    return invalid('INVALID_RESULT', 'lease_id must be a valid lease id.');
  }
  if (body.status !== 'succeeded' && body.status !== 'failed') {
    return invalid('INVALID_RESULT', 'status must be "succeeded" or "failed".');
  }
  // Enforce the cap on the wire representation, after parsing.
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > WORKER_RESULT_MAX_BYTES) {
    return invalid('BODY_TOO_LARGE', 'The worker result exceeds 1 MiB.', 413);
  }
  if (body.status === 'succeeded' && !validSucceededResult(body.result)) {
    return invalid('INVALID_RESULT', 'A succeeded result must be a complete non-simulated EIF result.');
  }
  if (body.status === 'failed' && !validFailedResult(body.result)) {
    return invalid('INVALID_RESULT', 'A failed result must carry a reason.');
  }
  return { ok: true, value: body };
}

/* Built with Meta Muse. */
// Worker lifecycle transport: the seam between the deployment control
// plane and node execution (download/verify/load/unload/cancel/report).
// No real worker implements this protocol yet (see
// local-worker/EXECUTION-GAPS.md), so live dispatch reports
// WORKER_API_UNAVAILABLE with its missing dependency. Tests and local
// fixture renders use FakeWorkerTransport, whose scripted receipts prove
// the control plane's durability, reconciliation, and cleanup logic.
//
// Fake semantics (documented, fixture-only):
// - dispatch(op) records the worker op id; re-dispatch with the same op id
//   resumes without duplicating work (AC15/AC16).
// - peek(op) returns the next receipt WITHOUT consuming it, and poll(op)
//   consumes one scripted receipt step for the op. Status reads run
//   peek → compare-and-swap → consume-on-success, so a race loser never
//   destroys a receipt the winner still needs (N2). Real transports behind
//   this seam must offer the same peek/poll pair.
// - Scripts live in the deployment plan under `fixtureScript` and are
//   rejected outside fixture environments.
// - __resetFixtureTransport() simulates a worker restart: server-side rows
//   survive; worker-side memory is dropped; the next poll reconciles.
import { isFixtureEnv } from './hub.mjs';

export const WORKER_STATES = ['queued', 'admitted', 'staging', 'verifying', 'loading', 'ready', 'failed', 'cancelled'];
export const TERMINAL_STATES = ['ready', 'failed', 'cancelled'];

export function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

const ops = new Map(); // opId -> { jobId, nodeId, steps: [], cursor: 0, dispatches: 0, cancelled: false }
const uniqueDispatches = new Set();

export function __resetFixtureTransport() {
  ops.clear();
  uniqueDispatches.clear();
}

export function __fixtureDispatchCount() {
  return uniqueDispatches.size;
}

// Test-only: did the control plane request cancel for this op?
export function __fixtureWasCancelled(opId) {
  const op = ops.get(opId);
  return !!op && op.cancelled === true;
}

// Test-only: simulate a lost cancel request (transport unreliability).
// Receipts still come from the declared script; this only clears the
// cancel flag the route set, so tests can drive the unacknowledged and
// cancel-lost-race branches deterministically.
export function __fixtureUncancel(opId) {
  const op = ops.get(opId);
  if (op) op.cancelled = false;
}

// Test-only: simulate a worker that finally answers a cancel after going
// quiet, so tests can drive late-acknowledgment reconciliation (N1).
export function __fixtureAckCancel(opId) {
  const op = ops.get(opId);
  if (op) op.cancelled = true;
}

function fakeTransport() {
  return {
    backend: 'fake-fixture',
    async dispatch({ opId, jobId, nodeId, script }) {
      uniqueDispatches.add(opId);
      if (!ops.has(opId)) {
        ops.set(opId, { jobId, nodeId, steps: Array.isArray(script) ? script : [], cursor: 0, dispatches: 1, cancelled: false });
      } else {
        ops.get(opId).dispatches += 1; // resume, not duplicate work
      }
      return { accepted: true, opId };
    },
    // Returns the next receipt for the op WITHOUT consuming it, or
    // { status: 'unknown' } when the worker has no record (restart /
    // reconnect gap → reconcile).
    async peek(opId) {
      const op = ops.get(opId);
      if (!op) return { status: 'unknown', detail: 'worker holds no record of this op' };
      if (op.cancelled) return { status: 'cancelled', detail: 'worker acknowledged cancel' };
      if (op.cursor >= op.steps.length) {
        // Script exhausted without terminal state: the worker went quiet.
        return { status: 'unknown', detail: 'no further receipts; worker quiet' };
      }
      return op.steps[op.cursor];
    },
    // Consumes one scripted receipt step for the op. Call only after the
    // control plane made progress on the peeked receipt (N2).
    async poll(opId) {
      const op = ops.get(opId);
      if (!op) return { status: 'unknown', detail: 'worker holds no record of this op' };
      if (op.cancelled) return { status: 'cancelled', detail: 'worker acknowledged cancel' };
      if (op.cursor >= op.steps.length) {
        return { status: 'unknown', detail: 'no further receipts; worker quiet' };
      }
      const step = op.steps[op.cursor];
      op.cursor += 1;
      return step;
    },
    async cancel(opId) {
      const op = ops.get(opId);
      if (!op) return { status: 'unknown' };
      op.cancelled = true;
      return { status: 'cancelled' };
    },
  };
}

export function workerTransport(env) {
  if (isFixtureEnv(env)) return fakeTransport();
  return null; // no real lifecycle transport exists yet
}

export function transportAvailable(env) {
  return !!workerTransport(env);
}

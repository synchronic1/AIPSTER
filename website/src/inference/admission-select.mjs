// Opt-in server selection glue for the admissions route (offline slice).
//
// Called ONLY from the worker.js `POST /api/inference/admissions` select
// path. Derives candidates server-side via the existing principal-scoped
// `listEligible` (owner + live same-side grants, never foreign rows), runs the
// reviewed `selectPlacement` + `validatePlacementBinding`, and returns the
// winning resource id with advisory evidence — or a precise refusal. This
// module mints nothing: the route feeds the winner through the unchanged
// access/liveness/grant/store authority afterwards.
//
// Design notes (API decisions, see ADMISSION-RESULT):
// - Candidates are always server-derived descriptors; no caller field (score,
//   tenant, grant, qualification) is trusted or even accepted.
// - Heartbeat/PATH/model-token observation is reachability + soft scoring
//   signal only. It is NOT residency, model attestation, or execution
//   readiness, and the returned evidence says so (`modelCompat:'unverified'`).
// - Unsupported devices (GPU et al) and off-allowlist runtimes are refused
//   explicitly (400); there is no silent CPU fallback and no invented
//   qualification. No eligible node is a 409 availability refusal, mirroring
//   the route's RESOURCE_STALE precedent.
// - `usable`/`tenantMatch` evidence below restates server-established facts:
//   selectPlacement only selects usable===true rows; owned rows re-pin tenant
//   scope and granted rows were authorized upstream by canUseResource inside
//   listEligible. They are not caller assertions.
import { listEligible } from '../routing/eligibility.mjs';
import { selectPlacement, validatePlacementBinding } from './placement-binding.mjs';

/**
 * Server-side opt-in target selection for one principal.
 * @param {{db:object,tenantId:string,model:string,maxTokens:number,device?:string,runtimeId?:string,nowMs?:number}} args
 * @returns {Promise<{ok:true,resourceId:string,selection:object}|{ok:false,code:string,reason:string,http:number,examined:number,excluded:number}>}
 */
export async function selectAdmissionTarget({ db, tenantId, model, maxTokens, device = 'cpu', runtimeId = 'ganglion', nowMs } = {}) {
  if (!db || typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new Error('selectAdmissionTarget requires a database and tenant.');
  }
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const { eligible } = await listEligible(db, tenantId, { nowMs: now, maxTokens, model });
  const decided = selectPlacement(eligible, { tenantId, model, maxTokens, device, runtimeId });
  if (decided.code !== 'SELECTED') {
    const http = decided.code === 'DEVICE_UNSUPPORTED' || decided.code === 'RUNTIME_UNSUPPORTED' ? 400
      : decided.code === 'DEADLINE_EXCEEDED' ? 504 : 409;
    return {
      ok: false, code: decided.code, reason: decided.reason, http,
      examined: decided.examined, excluded: decided.excluded.length,
    };
  }
  const winner = decided.selected;
  // Belt-and-braces on the real path: both reviewed checks must agree that
  // the server-pinned binding is well-formed before the route may use it.
  // Any disagreement is an internal invariant failure, never a selection.
  const checked = validatePlacementBinding(
    { device: winner.binding.device, nodeId: winner.binding.nodeId, runtimeId: winner.binding.runtimeId },
    { liveness: 'online', lastSeenAgeMs: winner.evidence.lastSeenAgeMs, usable: true, tenantMatch: true });
  if (!checked.ok) {
    return {
      ok: false, code: 'SELECTION_INVALID', reason: checked.reason, http: 503,
      examined: decided.examined, excluded: decided.excluded.length,
    };
  }
  return {
    ok: true,
    resourceId: winner.resourceId,
    selection: {
      resource_id: winner.resourceId,
      device: winner.binding.device,
      runtime_id: winner.binding.runtimeId,
      score: winner.score,
      evidence: winner.evidence,
      examined: decided.examined,
      excluded: decided.excluded.length,
    },
  };
}

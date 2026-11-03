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
import { STALE_AFTER_MS } from '../lib/status.mjs';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// Qualification gate: a bounded disabled prerequisite, not a new authority.
// Automatic selection may feed admission issuance only when the winning
// descriptor carries explicit, server-shaped runtime/model qualification
// evidence — a resident exact-instance attestation with named authority.
// No such evidence exists in the current descriptor contract
// (routing `buildDescriptor` carries no qualification field), so every row
// is unqualified today and the select path refuses with advisory evidence
// instead of minting. This gates ONLY the new automatic path: explicit
// issuance names the caller's own resource and is unchanged.
// Exact data prerequisite (forward-looking; nothing in-repo produces it):
//   descriptor.qualification = { qualified: true,
//     runtimeDigest: <non-empty string>, modelDigest: <non-empty string>,
//     authority: <non-empty string>, attestedAt: <safe-int epoch ms> }
// where attestedAt must be within STALE_AFTER_MS (freshness), never future.
function qualificationOf(descriptor, nowMs) {
  const missing = 'No runtime/model qualification evidence is recorded for this resource: no resident exact-instance attestation exists. Automatic selection cannot qualify execution; explicit issuance is unchanged.';
  const q = isObj(descriptor) ? descriptor.qualification : undefined;
  if (q === undefined || q === null) return { qualified: false, reason: missing };
  const malformed = !isObj(q) || q.qualified !== true
    || typeof q.runtimeDigest !== 'string' || q.runtimeDigest.length === 0
    || typeof q.modelDigest !== 'string' || q.modelDigest.length === 0
    || typeof q.authority !== 'string' || q.authority.length === 0
    || !Number.isSafeInteger(q.attestedAt) || q.attestedAt > nowMs;
  if (malformed) {
    return { qualified: false, reason: 'Runtime/model qualification evidence is malformed or future-dated and cannot qualify automatic execution; explicit issuance is unchanged.' };
  }
  if (nowMs - q.attestedAt > STALE_AFTER_MS) {
    return { qualified: false, reason: 'Runtime/model qualification evidence is stale (attestation older than the freshness window); explicit issuance is unchanged.' };
  }
  return { qualified: true };
}

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
  const selection = {
    resource_id: winner.resourceId,
    device: winner.binding.device,
    runtime_id: winner.binding.runtimeId,
    score: winner.score,
    evidence: winner.evidence,
    examined: decided.examined,
    excluded: decided.excluded.length,
  };
  // The gate: without qualification evidence the wired selection is advisory
  // only. The refusal carries the same advisory selection so the caller sees
  // exactly what would have been picked and why it cannot execute yet.
  const qual = qualificationOf(winner.candidate, now);
  if (!qual.qualified) {
    return {
      ok: false, code: 'SELECTION_UNQUALIFIED', reason: qual.reason, http: 409,
      selection, examined: decided.examined, excluded: decided.excluded.length,
    };
  }
  return { ok: true, resourceId: winner.resourceId, selection };
}

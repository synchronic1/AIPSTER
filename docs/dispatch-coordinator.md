# Internal admitted-dispatch coordinator

`website/src/inference/dispatch-coordinator.mjs` implements interface `aipster-dispatch-coordinator/1`.

**Status:** an internal, offline-tested server-side module. It is **not** a route, a deployed endpoint, an issuer or authority.
- `worker.js` does not import it, and `POST /api/jobs` stays `501 INFERENCE_DISABLED` after its existing auth/CSRF checks.
- No flag, schema, migration or WebSocket was added.
- Lane L2 adds flag-gated routes on a separate branch (`docs/inference-dispatch-routes.md`). For the default flag-off deployment the two statements above remain exactly true; with `INFERENCE_ENABLED=1` the coordinator is constructed per request over an injected store and transport.
- All positive lifecycle evidence uses an owned test double (`website/tests/fixtures/dispatch-authority-fake.mjs`). That double is not D1 and not a transport, and its "restart persistence" is modeled.

## Construction

```js
createDispatchCoordinator({ resolvePrincipal, authority, transport, now })
  -> { interface, submit(authContext, body), reconcile(authContext, key), cancel(authContext, key) }
```

With no arguments (the production default), every call returns `rejected` / `DISPATCH_UNAVAILABLE` with `blocked_by: [NO_PRINCIPAL_RESOLVER, NO_AUTHORITY_STORE, NO_TRANSPORT]` and touches nothing.

### `resolvePrincipal(authContext)`
A trusted server resolver over the existing session/API-key boundary. `authContext` is opaque to the coordinator. The resolver returns:
- `principal_id`, `tenant_id`
- `actor_kind` (`session` | `key`)
- `key_scope`, `expired`

Heartbeat and read-scoped keys get `KEY_SCOPE`, expired keys get `KEY_EXPIRED`, and anything else gets `AUTH_REQUIRED`. These checks mirror `needAuthz('inference')` and do not replace it.

### `authority`
**One atomic store boundary.** The response's separate `IBudgetLedger` is folded in deliberately, because the admission CAS must attest every hold and the live authority in the same step.

| Method | Returns | Requirement on a real store |
|---|---|---|
| `resolveAdmission({principal, admission_ref})` | admission record or `null` | Server-stored, server-issued record (B1). Foreign and unknown references must look the same. |
| `readGrant({grant_id})` | grant (`fabric/policy.mjs` shape plus `revoked`) | Live read. Used only as an advisory pre-check. |
| `claimOperation({op_key, request_digest, principal_id, tenant_id, binding})` | `{claimed, op}` | Principal-scoped key `JSON.stringify([principal_id, idempotency_key])`. Stores the immutable digest and binding, including `deadline_at`. |
| `acquireHold({op_id, generation, pool_id, amount})` | `{held:true, hold_id}` or `{held:false}` | One hold per (operation, pool). Pending and non-dispatchable. |
| `admit({op_id, generation, holds, authority})` | `{outcome:'admitted'}` or `{outcome:'rejected'}` | **Linearization point.** The exact held set plus the live grant status, `revoked === false`, revision and incarnation are checked in one transaction. A fence must also refuse. |
| `redeemStart({op_id, generation, worker})` | `{outcome:'redeemed'}` or `{outcome:'refused', reason}` | Issuer-owned, one-time, serialized with revoke in the same store (B3). |
| `fenceStart({op_id, generation})` | `{outcome:'fenced'}` or `{outcome:'already_redeemed'}` | A tombstone: no later admit or redeem can succeed. |
| `releaseHolds({op_id, generation, reason})` | `{released}` | Only this operation's uncharged holds, and only when no start can still be redeemed. |
| `recordDispatch`, `markUncertain`, `recordCancelIntent` | `{recorded}` | Generation-fenced. |
| `recheckRelease({op_id, generation})` | `{ok}` or `{ok:false, reason}` | Live authority recheck before content is released. |
| `settle({op_id, generation, job_id, outcome, result_digest})` | `{settled}` or `{settled:false, reason}` | Charges the full admitted envelope exactly once, generation- and job-owned. |
| `getOperation({op_key})` | op or `null` | Read-only reconcile. |

Every response is shape-checked. A throw, a malformed response or an unexpected value is treated as **unknown** and never as success.

### Retained state and retention

Durable state is bounded per principal. `INFERENCE_DISPATCH_MAX_ADMISSIONS` (default 20) caps live admissions; expired admissions are swept and never count. `INFERENCE_DISPATCH_MAX_OPERATIONS` (default 20) caps retained operations in **every** phase, terminal ones included, and is enforced by a guarded insert inside the claim batch: at the cap the claim either makes room by pruning or fails with `429 DISPATCH_LIMIT`.

Only state that cannot be replayed is pruned, and only for the claiming principal:

| State | When it is pruned |
|---|---|
| `released` operation | As soon as the principal is at the cap. `releaseHolds` requires that no start was redeemed (and that an admitted operation is fenced), so nothing ran and no result or receipt exists. |
| `settled` operation | After `INFERENCE_DISPATCH_RETENTION_MS` (default 7 days; values under 1 hour are ignored). This row is the replay/receipt record, so it is kept for that window. |
| `dispatch_settlements`, terminal `dispatch_jobs`, `dispatch_start_redemptions`, `dispatch_fences` | With their pruned operation, in the same batch. |
| `dispatch_holds` in `released` or `charged` | With their pruned operation. These rows are history, not accounting: a released hold already refunded its charge in `releaseHolds` and a charged hold *is* the settlement charge, so deleting either moves no pool or grant counter. |

Never pruned at any age: an operation with `uncertain_phase`, one owning a `held`/`committed` hold, one owning a `queued`/`leased` job, or any non-terminal phase. Such an operation keeps counting against the cap, so unresolved work blocks new claims for that principal with `429 DISPATCH_LIMIT` until it is resolved or cancelled — the deliberate trade of availability for never re-running uncertain work.

Pruning statements and the guarded insert form one atomic D1 batch (D1 executes a batch serially inside one transaction), so eviction and the capacity decision it enables are applied together and never half-applied: the principal either has room or the insert is refused. That is a claim about this batch only. Other methods are their own batched units — `releaseHolds`, for example, gates the operation in one batch and refunds its holds in a subsequent guarded batch — so a concurrent caller can read state from just before another batch. Such a stale read is never authority: every write re-checks the exact `op_id`, generation, phase, fence and `changes()` chain inside its own batch and does nothing when the predicate fails. Live reservations are protected by the same in-batch predicates (a `held`/`committed` hold keeps its operation), so eviction can neither remove a reservation nor skip its refund. Eviction itself is a delete only: pool ceilings and counters are preserved, and pruning never refunds or re-charges.

Idempotency is bounded by retention: a retained `op_key` always reconciles to its original operation, and a key whose row was pruned becomes a new operation. Because only released and aged-settled rows are pruned, that bound cannot lose a live result: released work never executed, and settled work is past its replay window. `getOperation` for a pruned key returns `null` (the coordinator's unknown outcome), and nothing in eviction re-dispatches.

### `transport`
- **Capabilities** must be `{protocol: 'aipster-bound-cpu-internal/1', instance_pin: true, deadline: true}`. A transport without them, such as the legacy EIF execute frame, is refused with `TARGET_CAPABILITY_UNSUPPORTED` before any side effect. The coordinator never downgrades or strips fields.
- **`dispatch(envelope)`** returns `{accepted:true, job_id}`. The envelope is `encodeBoundCpuTask(...)`, the legacy bound CPU codec, plus an internal `binding` of op, generation, runtime instance, model fingerprint and deadline.
- **`poll({job_id})`** returns an EIF-shaped job, decoded with `decodeCpuTask` and additionally bound to the runtime instance and fingerprint.

## Client body

Accepted fields:
- `contract_version` (exactly `v1.0.0`)
- `admission_ref`
- `idempotency_key`
- `model_id`
- `prompt`
- `max_tokens`
- `deadline_at` (an integer in Unix ms, in the future, at most 180 s ahead)

Refused fields:

| Field kind | Examples | Code |
|---|---|---|
| Authority, identity or placement | `authenticated`, receipts, grants, `principal_id`, `tenant_id`, `placement`, instance, fingerprint | `FORGED_CLIENT_AUTHORITY` |
| Sampling parameters | `temperature` and other sampling fields | `UNSUPPORTED_PARAMETER` |
| Unsupported capabilities | `stream`, `cancel` | `UNSUPPORTED_CAPABILITY` |
| Anything else unknown | | `UNSUPPORTED_FIELD` |

The target comes only from the resolved admission record.

## Lifecycle

1. **Principal**, then **body**, then **deadline**, then **transport capability**.
2. **Admission lookup:** principal and tenant must match, the admission must not be expired, and the model and token ceiling must match.
3. **No-stitching grant pre-check** using `matchGrant` against one grant.
4. **Claim:** a same digest gives a read-only view; a changed digest gives `409 IDEMPOTENCY_CONFLICT`.
5. **Holds:** insufficient budget compensates only this operation's holds.
6. **Admission CAS.**
7. **Deadline check:** if passed, fence and release, giving `expired_before_start`.
8. **Start redemption:** a refusal fences and releases.
9. **Bound dispatch.**
10. **Record the job id.**

`reconcile` polls by the recorded job id only:
- a running job past its deadline becomes `uncertain`
- a terminal, verified result is settled once
- content is released only after `recheckRelease`; otherwise it is withheld and still charged

### Uncertain outcomes

Any unknown result at claim, holds, admission, start, dispatch, result or settlement leaves the operation `uncertain`:
- holds are retained
- `automatic_retry` and `remote_stopped` stay false
- a retry with the same key returns that recorded state and never repeats the step

### Cancellation

Before start, cancel fences the start and then releases this operation's holds. After start, it records intent and returns `cancel: UNSUPPORTED_CAPABILITY`, because the accepted nonstreaming contract has no execution-cancel frame.

Internal request or lease cancellation is not OS-descendant cleanup. Process supervision stays with the runtime and worker owners.

## Modeled vs implemented vs unavailable

| Area | State |
|---|---|
| Coordinator logic, validation, binding, conflict, uncertainty, fencing, exactly-once settle calls | **Implemented** (this module) and tested against fakes |
| No-stitching matcher, canonical digest, bound CPU codec, result decoder | **Reused** existing source (`fabric/policy.mjs`, `fabric/canonical.mjs`, `inference/eif-task-contract.mjs`) |
| Authority store, atomic CAS, start redemption, holds, settlement, restart persistence | **Modeled** only in the owned test double |
| Real D1 tables, migrations and CAS (B4); issuer (B1); live grant channel (B2); durable start redemption (B3); node-role FAT; EIF transport, deadline and cancel frames; live inference | **Unavailable.** These belong to their owners and were not invented here. |

## Unresolved internal choices (alternatives recorded, not decided here)

1. **Resuming after an authoritatively read state.** After an unknown CAS or start response, the coordinator only reports the store's phase. The alternative is to resume when the store authoritatively shows `admitted` and not redeemed. That needs the state-layer owner's agreement on read consistency.
2. **Definite non-accept after redemption.** This is treated as uncertain, with holds retained. The alternative is to release once the transport protocol can prove non-execution.
3. **Charging the full admitted envelope.** The coordinator always charges it, following the atomic-admission contract. The alternative, usage-based charging below the envelope, needs a pricing and budget decision.

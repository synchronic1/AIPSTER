# Inference dispatch routes (L2)

Status: an internal, flag-gated HTTP surface on `website/src/worker.js` for the
admitted-dispatch coordinator (`docs/dispatch-coordinator.md`). It is **dark by
default**: every route below exists only when `env.INFERENCE_ENABLED === '1'`,
which production does not set. With the flag off, `POST /api/jobs` keeps its
exact `501 INFERENCE_DISABLED` body after the existing auth/CSRF checks, and
every other route falls through to the JSON `404 NOT_FOUND`. Nothing here
deploys, migrates, or mints anything by itself; the L1 D1 store
(`createD1DispatchStore` in `src/inference/dispatch-store.mjs`) is loaded
lazily and its absence fails closed with `503 DISPATCH_UNAVAILABLE`.

## Routes

| Route | Auth | Body / query | Success |
|---|---|---|---|
| `POST /api/inference/admissions` | session + CSRF, or inference-scoped key | `{resource_id, model_id, max_tokens, runtime_id?}` | `201 {admission_ref, expires_at, model_id, max_tokens}` |
| `POST /api/jobs` | session + CSRF, or inference-scoped key | coordinator `v1.0.0` body | `202` dispatched, or coordinator state |
| `GET /api/jobs/:idempotency_key` | session or inference-scoped key | — | `200` settled (`outcome.released` / withheld), `202` still dispatched, `409` pending |
| `POST /api/jobs/:idempotency_key/cancel` | session + CSRF, or inference-scoped key | — | `202` with `cancel: UNSUPPORTED_CAPABILITY` after start; pre-start fence+release returns `200 CANCELLED` |
| `GET /api/worker/jobs/next` | heartbeat-scoped key bound to one resource | — | `200 {job_id, lease_id, envelope, deadline_at}`, or `204` when no job is leasable |
| `POST /api/worker/jobs/:job_id/result` | same heartbeat-scoped key | `{lease_id, status: 'succeeded'\|'failed', result}` | `200 {ok:true}`, `409` mismatch/duplicate |

`GET /api/jobs` (list) is unchanged. While the flag is on, the reconcile route
takes precedence over the legacy `GET /api/jobs/:id` read; with the flag off
the legacy read is untouched.

## Admission issuance

The issuer checks, before calling `store.issueAdmission`:

1. The resource exists and the caller **owns it or holds one live, non-revoked,
   same-side grant with remaining quota** (`lib/access.js` `canUseResource`).
   Foreign and unknown resources both answer `404 NOT_FOUND`.
2. The resource is **reachable**: the dashboard's read-time rule
   (`lib/status.mjs` `resourceLiveness` with `STALE_AFTER_MS`, i.e. `online = 1`
   and a heartbeat inside the 5-minute window). Anything else is
   `409 RESOURCE_STALE`.
3. `max_tokens` is an integer in `1..4096` (`400 BAD_MAX_TOKENS`).
4. `runtime_id` is absent (default `ganglion`) or exactly `ganglion` or
   `llama-server` (`400 BAD_RUNTIME` otherwise, including any non-string). This
   check runs before the store, so a refused value mints nothing.

### Runtime identity (Addendum B)

`runtime_id` is the worker runtime that will execute the job: `ganglion` (the
default) or a plain `llama-server` on Metal, for hosts that have no Ganglion
yet. The issuer passes the validated value to `store.issueAdmission`, which
pins both halves of the identity in the admission binding — `runtime_id` and
`runtime_instance` (`<node_id>#<runtime_id>`). The coordinator carries them
unchanged into `task.placement.runtime_id` and `binding.runtime_instance`, and
the worker echoes the binding back in its result, so a `llama-server` job can
never present itself as Ganglion. The test double rejects an out-of-allowlist
runtime too, so a route bug cannot be masked by the fake.

For a grant-covered request the issuer also normalizes the app grant into the
`fabric/policy.mjs` shape, pins the remaining token ceiling, and runs
`matchGrant` for the exact resource/incarnation/model, so the stored admission
is one complete no-stitching authority. Exhausted quota is
`429 GRANT_QUOTA_EXHAUSTED`; a grant that does not cover the exact request is
`403 NO_MATCHING_GRANT`.

The response carries only the four admission fields. The record itself
(principal, tenant, resource, node/runtime ids, model, ceiling, grant
id/revision, 10-minute expiry, pools) is server-side. The owner self-use pool is
`owner:<user_id>:<yyyy-mm-dd UTC>` with the ceiling from
`env.INFERENCE_OWNER_DAILY_TOKENS`; missing or invalid means `0` and fails
closed.

## Principal and authority

The coordinator's resolver maps the existing actor boundary to
`{principal_id: user.id, tenant_id: user.id, actor_kind}`. Client fields that
claim authority (`principal_id`, `tenant_id`, `grant_id`, `placement`,
`authenticated`, …) are refused by the coordinator with
`400 FORGED_CLIENT_AUTHORITY`; the target comes only from the stored admission.

The transport is `src/inference/worker-transport.mjs`:
`{protocol: 'aipster-bound-cpu-internal/1', instance_pin: true, deadline: true}`,
`dispatch(envelope) = store.enqueueJob(envelope)`,
`poll({job_id}) = store.readJob({job_id})`. The coordinator refuses a transport
without those capabilities before any side effect.

## Worker results

The result report is validated strictly: exactly `lease_id`, `status`,
`result`; `status` is `succeeded` or `failed`; a succeeded result must be a
complete EIF result (`request_id`, `node_id`, `runtime_id`, `model_id`,
`runtime_instance`, `model_fingerprint`, `simulated === false`, non-empty
`content`, finite `elapsed_ms`, `usage`, `cache`, no truncation); a failed
result must carry a `reason`. The whole body is capped at 1 MiB
(`413 BODY_TOO_LARGE`). The store accepts a result only for the matching job,
lease and bound resource, once; anything else changes nothing and answers
`409 RESULT_REJECTED`.

These are exactly the canonical worker wire shapes in Addendum A: the worker
echoes `binding.runtime_instance` and `binding.model_fingerprint` from the lease
frame and sends nothing else. A succeeded `result` allows only
`request_id, node_id, runtime_id, model_id, runtime_instance, model_fingerprint,
simulated, content, elapsed_ms, usage, cache` (plus `truncated: false`); a failed
`result` allows only `reason, detail, elapsed_ms, usage, cache`, with `reason` a
token of at most 128 characters and no `content`. A rejected report never
consumes the lease.

The worker may lease and complete only jobs whose `resource_id` equals its
key's bound resource (migration 0013). Sessions, read keys, inference keys and
unbound heartbeat keys are refused (`403 KEY_REQUIRED` / `403 KEY_SCOPE`).
These endpoints use bearer-key auth only and have no CSRF surface, matching the
heartbeat intake.

## Known integration gap (for L1)

The coordinator pre-checks `readGrant({grant_id})` against the exact resource,
incarnation and model, but receives only the grant id. A literal shared
`"owner"` id therefore cannot resolve which resource is being authorized. The
L1 store must mint a resource-scoped owner grant id (or otherwise key the
readback by the admission it stored); the test double uses
`owner:<principal>:<resource>:<admission_ref>` and stores the normalized
policy snapshot for both owner and grant-covered admissions.

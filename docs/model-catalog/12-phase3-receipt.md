# Model catalog — Phase 3 receipt (qualified deployment + durable jobs)

<!-- Built with Meta Muse. -->

- Branch: `muse/model-catalog`. Commit: (this commit).
- Gate: AC14–AC21. `npm run check` PASS, `npm test` 961/961 PASS
  (19 new: 15 deployments + 4 deploy-UI), `npm run build` PASS,
  `npm run bundle` dry-run PASS.

## Delivered

- `migrations/0018_model_catalog_reservations.sql`: `catalog_reservations`
  (byte holds per deployment), `catalog_deployments`, `catalog_deployment_events`.
- `src/lib/catalog/transport.mjs`: worker lifecycle seam. No real worker
  implements the protocol, so live dispatch fails closed with
  `WORKER_API_UNAVAILABLE`; fixture envs get the scripted fake transport
  (resume-by-op-id, one receipt per poll, restart simulation).
- Routes: `POST /api/catalog/plans` (immutable HMAC plan tokens, 15 min,
  principal-bound; gated refused; blocked/unknown never plan),
  `POST /api/catalog/deployments` (idempotent execute: key+principal+
  fingerprint; re-resolves pins, re-evaluates compat, owner/node caps,
  byte reservation, dispatch), `GET …` (list, owner-only),
  `GET …/:id` (status with fixture reconciliation per read),
  `POST …/:id/cancel` (best-effort worker cancel, terminal replay).
- Durability: forward-only transitions with structured error codes;
  restart resumes the same op id with idempotent receipt replay;
  reconcile-lost, timeout, partial failure, and mid-flight revocation all
  fail honestly and release reservations. Ready KEEPS its reservation
  (loaded weights occupy memory; no unload API yet).
- UI: Plan deployment from estimated-compatible decisions (blocked keeps
  an honestly disabled action), plan card with pins/expiry, Execute plus
  a labeled DEMO fixture walkthrough, job tracker with state pill,
  reservation, error, event trail, Refresh/Cancel, and a Deployments
  list kept consistent with the tracker. Demo cannot plan/execute.
- `summary.deploymentAvailable` now reflects the fixture transport.

## Acceptance mapping

- AC14: idempotent execute (same key+plan replays, same key+other plan
  409s); receipt-driven states with ordered timestamped events; stale
  snapshot between plan and execute fails closed (cache never authorizes).
- AC15: restart resumes the same op id; replayed receipts are no-ops;
  exactly one dispatch per op.
- AC16: never-observed and quiet workers fail with `RECONCILE_LOST`;
  reservations released.
- AC17: cancel/timeout/partial all release with cleanup notes; cancel
  replays on terminal jobs.
- AC18: byte exhaustion 409s with available/needed bytes; per-node
  active cap rejects the third concurrent job.
- AC19: gated weights refused at plan time (`GATED_ACCESS_REQUIRED`).
- AC20: mid-flight revocation fails the job (`REVOKED`); jobs are
  owner-visible only in reads, cancels, and listing.
- AC21: demo denied plan/execute; live mode plans but dispatch 503s
  with nothing persisted; scripted receipts refused outside fixtures.

## Bugs found by tests/renders during this phase

1. Client rendered `plan.revision` instead of `plan.asset.revision`
   (`@undefined`). Fixed; UI test asserts the pinned prefix.
2. Tracker refresh left the Deployments list stale. Fixed (tracker
   refresh re-renders the list); render 12 proves consistency.
3. Render driver raced `Loading…` for job identity; telemetry seed aged
   past freshness; wrangler serves `./dist` (rebuild required after
   client edits). Harness/driver-side, fixed.
4. Orphaned pre-compaction wrangler/workerd stack held port 8791.
   Stopped (own processes only); 10/27 public-site stack untouched.

## Renders (`docs/model-catalog/renders/`)

10 plan card (pins, 7.4 GB reservation, expiry, Execute + DEMO
walkthrough), 11 walkthrough-ready tracker (DEMO label, full event
trail, reservation held), 12 deployments list consistent with the
tracker, 13 list at 390px. Real headless-Edge captures against local
fixture `wrangler dev`.

## Limitations / not in Phase 3

- No real worker lifecycle transport: live dispatch is honestly
  refused; no download/verify/load/unload/cancel/report protocol exists.
- No unload API: ready holds its reservation until a follow-on exists;
  repeat large walkthroughs can honestly 409 on bytes.
- Owner-active cap (5) and node-active cap (2) are provisional.
- `PIN_DRIFT` and dispatch-refusal paths are code-reviewed, not
  test-triggered (fixtures are deterministic; the fake never refuses).

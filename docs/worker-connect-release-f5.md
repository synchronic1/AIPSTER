# Worker-connect release order note (F5)

Recorded 2026-10-31 UTC, before worker-connect push. This file rides the
worker PR so the merge/dispatch owner sees the ordering constraints.

## Catalog PR #50 (verified read-only, not merged at record time)

- PR: synchronic1/AIPSTER#50 `muse/model-catalog` → `main`, state OPEN.
- Head: `3f253b39b8b6d4f7f26d49bea72046c0e322871d`.
- Migrations: `website/migrations/0022_model_catalog.sql`,
  `website/migrations/0023_model_catalog_reservations.sql`.
- Code: `website/src/lib/catalog/*`, plus `website/src/lib/schema.js` and
  `website/src/worker.js` (shared health-check/schema surface).
- `main` migrations top out at `0017_dgm_preview.sql` (DGM slice).

## Ordering decision

- Preferred: ship worker-connect FIRST with NO new migration, then rebase
  catalog. Worker lane currently adds no migration file; keep it that way
  unless a reviewer proves a table is required.
- If #50 lands first: rebase `muse/worker-one-click-connect` onto current
  `main`, allocate any new migration number from the live tree (never a
  hardcoded `0018`), re-run all gates, and re-verify migration readiness
  before deployment.
- Shared files (`schema.js`, `worker.js`): whoever merges second resolves;
  both lanes must keep the health-check contract green.

## Pre-dispatch migration ledger check (required)

Merging does not prove migrations applied. Before any production dispatch
of this lane, the coordinator must confirm which migrations the release
will apply against the actual production ledger (`d1_migrations`).
Constraint: this session has no Cloudflare API access and will not
acquire credentials, so the direct ledger read is owner-side. Minimum
acceptable evidence: migration-file reconciliation against `main` plus
the deploy run's migration-application log lines.

## Live stale-worker-pin defect

The deployed site's download pins reportedly still point at the older
`f3e115e` client. This candidate must include the pin correction with
regression tests, and live verification must confirm the deployed links
no longer recreate the fixed 403.

## Preserved state (restated, not negotiable here)

- Enrollment `r_9c27cd5f` + heartbeat (`usable=false`): preserve; never
  re-pair or request secrets to re-prove it.
- Port 8090 owner (Temp `aipster-worker.exe`, PID 2367672 at record time):
  identify before acting; never kill/steal/duplicate; reuse if compatible
  or use a supported alternative port.

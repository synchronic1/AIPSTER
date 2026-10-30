# Admin control panel scaffold

Scaffold-only `/admin` UI shell and `/api/admin/v1/*` routes. Authorized
reads return typed "unavailable" envelopes; authorized mutations return
`501 ADMIN_NOT_IMPLEMENTED`. The shell carries no authority — the server
authorizes every call.

## Baseline

Built on `origin/main` at `2ed8fdf` (29 Oct 2026), not the PRD pin
`b9f4793`:

- PRs #29, #31, #35, and #36 are merged, so migrations `0006`–`0015`
  exist. There is still no canonical `fabrics` table: the scaffold
  invents no fabrics and reports the model as pending (VIS01).
- Inference is still disabled (`POST /api/jobs` → `501`); the scaffold
  claims no serving capacity.
- No admin roles or APIs existed. This change adds only the grant table
  and deny-by-default routing — no elevation or account actions.

## Enforced for real

- `migrations/0016_admin.sql`: `admin_grants` table. Rows are issued
  out-of-band; no endpoint creates them.
- `src/admin/router.mjs`: live-grant check on every request. Grantless
  sessions, user and heartbeat keys, demo sessions, expired/revoked
  grants, unknown roles, and unrecognized scopes fail closed (`403
  ADMIN_FORBIDDEN`); missing credentials get `401`. Unknown paths
  answer 403 to unauthorized callers, so path existence is not an
  oracle.
- Role separation: no role holds both directory and metric permissions.
  The observer holds no acknowledgement permission, so every
  acknowledgement fails closed until Milestone 4.
- Mutations check authorization, then CSRF, then answer 501. No audit
  row, session, key, or account changes.
- Nulls are never zero: lists report `total: null`; metrics report
  `not_instrumented` with `value: null`.
- `/admin` shell (`public/admin/`): ten PRD sections, served with the
  `/app` host guard, `no-store`, and `script-src 'self'`. Reviewed
  static-policy change in `scripts/check.mjs`: one approved script per
  shell, no forms, no inline code.

## Still stubbed

Elevation, audit writes, suspension/restoration/session/key/recovery
workflows, tickets, GitHub export and sync, coding assignments, metric
instrumentation and privacy release, alerts and quotas, and
grant-management UI. Only a working collector may turn an envelope
into data.

## Production rollout (after the chain release)

HOLD: do not merge until the chain release (migrations 0006–0015 plus
deploy of `2ed8fdf`) is confirmed live. Migration 0016 needs a second
production pass after that release:

1. Back up production D1 and record the migration journal state.
2. Apply only `0016_admin.sql` (the journal must already show
   0006–0015 applied; nothing else pending).
3. Probe: select from `admin_grants` (expect an empty table with the
   documented columns), confirm every admin route denies with zero
   grants, and verify owner routes are unchanged.

## Tests

`website/tests/admin-scaffold.test.mjs` (12 tests): denial matrix,
grant edges, role separation, CSRF-before-501 ordering,
no-state-change, unknown-route non-leakage, panel headers. Run `npm
test` from `website/`.

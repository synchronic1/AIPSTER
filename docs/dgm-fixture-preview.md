# DGM fixture preview — Worker implementation (Stage 2)

Releasable fixture-preview slice on branch `muse/dgm-fixture-preview` from
`origin/main` at `47444a5`. Successor to `dgm-fixture-preview-plan.md`
(Stage 1, untracked); the plan's design stands with the deviations in §5.

## 1. What shipped

Worker API routes plus `/admin` shell UI for deterministic DGM fixture
runs. Gated on `DGM_PREVIEW_ENABLED === '1'` (default off, federation
pattern); production stays dark until the release owner opts in. Worker
`VERSION` `0.4.0` → `0.5.0`. No new bindings, no `wrangler.jsonc` change.

Evaluation is a deterministic fixture table (`src/dgm/preview.mjs`), not
the Python DGM harness: the Worker never imports, executes, or reproduces
it, and every fixture surface says so (`evaluation: 'fixture'` on
responses, UI banner, provenance `fixtureTable`). Real on this path:
Cloudflare request handling, session/grant authorization, D1 run/event
rows, audit rows, write-budget charging, and telemetry views derived
live from stored events.

## 2. Route table (all under `/api/admin/v1/dgm/preview/`)

| Method + path | Auth | Meaning |
|---|---|---|
| `GET status` | `admin.dgm.preview` | binding health, fixtures, states, run count |
| `POST runs` | same + CSRF + budget | create `{fixture, held?, label?, target?}` → 201 |
| `GET runs` | same | paginated summaries |
| `GET runs/{id}` | same | full run + live telemetry |
| `POST runs/{id}/pause` | same + CSRF + budget | re-hold a completed preview |
| `POST runs/{id}/resume` | same | complete a paused run |
| `POST runs/{id}/cancel` | same | cancel a paused run |
| `POST runs/{id}/promote\|execute\|reserve\|final-audit\|advise-live` | same + CSRF | always 501, before any run lookup |

Anonymous → 401; anything without the permission (grantless sessions, API
keys, demo, wrong role) → uniform 403 `ADMIN_FORBIDDEN`, decided before
routing so path existence is not an oracle. Unknown ids → 404 `NOT_FOUND`
on reads/transitions, identical 501s on disabled actions. Illegal
transitions → 409 `DGM_PREVIEW_STATE`. Refused bodies → 400
`DGM_OVERRIDE` / `DGM_BAD_BODY` / `DGM_BAD_FIXTURE` / `DGM_UNKNOWN_TARGET`.

## 3. Auth: site pattern only, no `?token=`

Operators authenticate exactly like every admin caller: `HttpOnly`
session cookie + live `admin_grants` row + `ROLE_PERMISSIONS` check in
`requireAdmin`, plus same-origin CSRF on mutations. The permission
`admin.dgm.preview` is held by `operations_observer` and
`engineering_reviewer`; grants stay out-of-band operator SQL. The
stack's `?token=` operator-URL pattern is deliberately NOT ported:
tokens in URLs leak via history, logs, and referrers, and no site
operator surface uses them (verified: tests prove query tokens grant
nothing). API keys authorize nothing here, mirroring the admin router.

## 4. Telemetry path proof (real site path, no dev-only events)

- Write: one atomic `db.batch` per create/transition — run row, event
  rows, fixture telemetry rows (`env=fixture`), and the `audit` row
  (`dgm.preview.create|pause|resume|cancel`, detail carries fixture +
  status only, never the label). Lost races (live cap, concurrent
  transition) chain on `changes() = 1` and leave zero partial rows.
- Read: run detail re-reads `dgm_preview_events` and rebuilds the view
  live (`readStatus` ok/stale/degraded/unavailable, outcome counts,
  nearest-rank p50/p95, estimate-only token sums). Empty aggregates are
  null/`unknown`, never 0. Held runs read `stale` until resume/cancel
  appends the outcome row.
- Redaction runs before every write (bearer/e-mail scrubbing; counts
  untouched). Scope matches the harness advisory: bearer/e-mail only,
  not general PII — verified secret-free across runs/events/audit rows.
- Failure isolation: corrupt event rows degrade the view
  (`readStatus: degraded`, `unparsedRows` counted); a failed events
  read still returns the run with an explicit unavailable-telemetry
  block. Proven by test, not by inspection.
- The audit trail is operator-readable through the real `GET /api/audit`
  session path (asserted in tests).

## 5. Deliberate deviations

From the stack contract (for review):

1. Non-operator refusal is house `403 ADMIN_FORBIDDEN`, not 404 (uniform
   denial already leaks nothing; consistency beats code parity).
2. Disabled actions are house `501 ADMIN_NOT_IMPLEMENTED`, not 403
   `E_DGM_DISABLED` (matches `POST /api/jobs` → 501; a 403 here would
   conflate "nobody can do this" with "you lack permission").
   Fail-before-lookup and unknown-id identity preserved exactly.
3. Telemetry persists as D1 rows, not JSONL (no filesystem on Workers).
4. Status requires `admin.dgm.preview` (stack: any authed): run counts
   are operator data, and uniform denial admits no grantless readers.
5. No `?token=` URLs (see §3); `HttpOnly` session cookies instead.
6. API field casing is house camelCase; contract vocabulary (fixtures,
   states, gates, events, reason strings) matches the stack verbatim.

From the Stage 1 plan: the `telemetry_status` run column was dropped —
telemetry derives live from events (like the stack's
`with_live_telemetry`), so no stored snapshot can go stale. The
optional enable flag was adopted (required to keep existing
readiness-test semantics and production dark).

## 6. Files

- `website/src/dgm/preview.mjs` — pure core: verdicts, gates,
  transitions, body checks, redaction, telemetry builders/summaries.
- `website/src/dgm/router.mjs` — routes, budget/cap fencing, atomic
  batches, live views; `dgmPreviewEnabled`, `DGM_PREVIEW_PERMISSION`,
  `MAX_DGM_PREVIEW_LIVE_RUNS` (20 paused/operator).
- `website/src/admin/router.mjs` — permission grants + flag-gated mount
  (requireAdmin passed via context; no import cycle).
- `website/src/lib/schema.js`, `website/src/worker.js` — additive
  readiness probe selected by flag; version `0.5.0`.
- `website/migrations/0017_dgm_preview.sql` — `dgm_preview_runs`,
  `dgm_preview_events` (new tables only, re-runnable).
- `website/public/admin/` — shell sections (status, runs, create,
  detail, state matrix) + `admin.js` fetchers/mutations (CSRF,
  same-origin, escaped rendering, no forms, no inline code).
- Tests: `website/tests/dgm-preview-{core,api,ui}.test.mjs` (41
  tests); `d1-shim.mjs`, `migrations`, `integration-boundaries`
  (17), `federation-main-upgrade` updated for 0017.

## 7. Verification (observed, this worktree)

- `npm run check` → passed (27 files).
- `npm test` → 939 pass, 0 fail (41 new: 14 core + 21 API + 6 UI).
- `npm run build` → built, 28 assets.
- `npm run bundle` → dry-run bundle ok (DB + ASSETS only).
- No server started; the Python harness/adapter untouched as reference.

## 8. Rollout notes

- Migration `0017_dgm_preview.sql` applies through the normal journal;
  with the flag off, `/api/health` readiness ignores the new tables.
- Grant issuance stays out-of-band SQL per `0016_admin.sql`; no
  self-service grant endpoint was added.
- Production deploy stays release-owner `workflow_dispatch` with a
  reviewed SHA; the slice is dark until `DGM_PREVIEW_ENABLED='1'` is set.

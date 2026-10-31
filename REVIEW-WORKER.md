# DGM fixture preview — Stage 4 review (Worker)

## Scope and limit

Scoped revalidation of the exact `muse/dgm-fixture-preview` diff vs
`origin/main` (`47444a5`), in worktree `aipster-dgm-preview`.
Reviewed SHAs: `8441e6ab29722c4f88cb6a76a0b1a425093abb87` (code+tests,
16 files) + `9ab732f4e6f618938e6c74f11ba297f7f5fee69c` (docs, 2 files);
HEAD `9ab732f4e6f618938e6c74f11ba297f7f5fee69c`.

Limit: same-session revalidation — the reviewer read the same
implementation and test bodies the earlier stages produced, plus ran the
gates independently. This is not an independent second implementation.
No implementation file was edited in this stage; this file is the only
addition and is left uncommitted.

Files opened (full bodies): `website/src/dgm/preview.mjs`,
`website/src/dgm/router.mjs`, `website/src/admin/router.mjs`,
`website/src/lib/schema.js`, `website/migrations/0017_dgm_preview.sql`,
`website/tests/dgm-preview-core.test.mjs`,
`website/tests/dgm-preview-api.test.mjs`,
`website/tests/dgm-preview-ui.test.mjs`,
`docs/dgm-fixture-preview.md`; diffs of `website/src/worker.js`,
`website/tests/d1-shim.mjs`, `website/tests/migrations.test.mjs`,
`website/tests/federation-main-upgrade.test.mjs`,
`website/tests/integration-boundaries.test.mjs`,
`website/public/admin/admin.js`, `website/public/admin/index.html`,
`website/public/admin/styles.css`, `docs/admin-scaffold.md`; plus
`readJson` in `website/src/lib/validate.js` and greps for
token/secret/`?token=`/held-out/console/fetch/URL-query reads across
`website/src/dgm/`.

## Verdict

No blocking defects. Fixes-required: none. Advisory: 3 (below).

## Coverage

- Fixture isolation: pure table in `preview.mjs:evaluateFixture`; no
  stack import, no held-out reference (grep-clean), no cross-user
  joins, `env=fixture` the only telemetry env written.
- Tenant/operator boundaries: every preview route calls
  `requireAdmin(admin.dgm.preview)` before routing, including the
  unknown-preview-path fallthrough; 401 anonymous / uniform 403
  `ADMIN_FORBIDDEN` for grantless, wrong-role, API-key, expired-key,
  and demo callers on all 13 routes (tested). Authz precedes CSRF.
  Flag-off falls through to the admin 404 for authorized callers only.
- Durable state + D1 migration safety: 0017 is additive tables +
  indexes only, `IF NOT EXISTS`, no ALTERs, re-runnable; `schema.js`
  column lists match the migration exactly; `/api/health` requires
  0017 only when the slice is enabled (tested both directions);
  creates/transitions commit run+events+telemetry+audit in one batch
  chained on `changes() = 1`; the 20-paused/operator live cap is
  fenced inside the mutating statement with honest re-reads.
- Failure paths: corrupt event rows degrade (`degraded` +
  `unparsedRows`) instead of failing reads; failed events read still
  returns the run with an explicit unavailable-telemetry block;
  concurrent transitions and cap races re-read and answer 409
  honestly; refused creates and capped creates write zero rows
  (tested event/audit counts).
- Disabled live actions: constant `DISABLED_ACTIONS` table, no flag,
  no body key, no setter — the only env flag gates the whole slice,
  never an action; `disabledAction` refuses 501
  `ADMIN_NOT_IMPLEMENTED` before any run lookup with unknown-id
  identity, no budget charge, no audit row (tested). CSRF-before-501
  matches house `mutate()` ordering.
- `?token=` replacement: the router never reads a query token
  (`searchParams` untouched; `pageQuery` pagination only on list);
  test proves `?token=` grants nothing; auth is `HttpOnly` session
  cookie + live grant + same-origin CSRF; UI uses `same-origin`
  fetch; run ids appear only in in-page fragment anchors.
- Redaction: label redacted at `checkCreateBody` before storage;
  event and audit details carry fixture/status/transitions only —
  label flows exclusively into the redacted runs row (list summaries
  omit it entirely); error details echo key names and server-side
  values, never label content; `readJson` errors are generic;
  UI escapes all dynamic text (`dgmEsc`, injection-tested).
- Fixture labeling honesty: `evaluation: 'fixture'` on every
  response, `fixtureTable` in provenance, `fixture-`-prefixed
  identities, UI banner and state matrix stating the Python harness
  does not run in the Worker; nothing implies live evaluation.
- No new paid infra/creds: `wrangler.jsonc` untouched, bundle
  dry-run shows DB + ASSETS only, no secrets, no new bindings;
  `DGM_PREVIEW_ENABLED` is enablement, not a credential.
- No hackathon-declaration drift: the Worker diff and
  `docs/dgm-fixture-preview.md` make no hackathon claims.
- Telemetry E2E through the operating path: the API test creates and
  resumes through the real request path, asserts stored `env=fixture`
  rows plus `preview.created`/`preview.resumed`, rebuilds the live
  view, and reads the audit trail through the real `GET /api/audit`
  session path. Empty aggregates are null/`unknown`, never 0.

## Gates re-run by this reviewer (this worktree, Node v24.18.1)

- `npm run check` → `{"passed":true,"files":27,...}`.
- `npm test` → 939 pass, 0 fail, 0 skipped (~155s).
- `npm run build` → `{"built":true,"assets":28,...}`.
- `npm run bundle` → dry-run ok; bindings DB (aipster-app) + ASSETS
  only (plus the existing `BETTER_AUTH_URL` env var).
- No server started or left running; `stack/` untouched; no
  push/merge/PR/dispatch.

## Findings

### Fixes-required

None.

### Advisory

1. `website/src/dgm/router.mjs:mapRow` (low) — `JSON.parse` of
   `gates_json`/`provenance_json` is unguarded, so a corrupt run row
   would 500 the detail read instead of degrading like corrupt event
   rows do. Reachable only via direct DB tampering (the server writes
   canonical JSON once at creation and never mutates it). Consider a
   try/catch returning the unavailable-telemetry shape or an explicit
   `degraded` marker on a future pass.
2. `website/src/dgm/router.mjs` list/detail/status reads (doc) —
   reads are shared across all `admin.dgm.preview` holders: any
   holder lists and opens every operator's runs (labels included,
   redacted at write), while the live cap is fenced per operator.
   Reasonable admin-tool semantics and consistent with the
   operator-readable audit trail, but `docs/dgm-fixture-preview.md`
   never states the shared-read intent. Consider one line confirming
   it (or scoping reads per operator if that was intended).
3. `transition()` refusal detail (note, no action) — the unknown-action
   branch echoes the action string, but the router only calls it with
   regex-matched (`pause|resume|cancel`) segments, so no request echo
   exists on the operating path. No change needed.

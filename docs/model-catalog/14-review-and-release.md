# Model catalog — review packet and release handoff

<!-- Built with Meta Muse. -->

## Scope

- Branch: `muse/model-catalog` (release lane).
- Base: `47444a5` (main, Merge PR #47 admin-scaffold);
  merged main `3fa309c` (Merge PR #49 DGM fixture preview)
  via merge commit (3 mechanical migration-list unions).
- Commits: `b192554` (Phase 0) → `f1b1a05` (Phase 1) →
  `173268d` (Phase 2) → `3d9a1b3` (Phase 3) → (this commit, Phase 4 docs).
- Worktree: `aipster-catalog/` beside the main checkout.

## What changed

- Phase 0: base record, capability matrix, plan, threat model
  (`docs/model-catalog/00–02`).
- Phase 1: migration 0018 (renumbered from 0017 post-DGM-merge), Hub adapter + fixtures + estimator,
  search/detail/compat/capability/summary routes, Models tab +
  Overview card, 30 tests, renders 01–06.
- Phase 2: validator + byte store, upload session routes, `priv:`
  detail/compat, My assets + upload UI, 14 tests, renders 07–09.
- Phase 3: migration 0019 (renumbered from 0018 post-DGM-merge), fake worker transport, plan/execute/
  status/cancel routes, job tracker UI + Deployments list, 19 tests,
  renders 10–13.
- Receipts: `10-phase1-receipt.md`, `11-phase2-receipt.md`,
  `12-phase3-receipt.md`. Real-node proposal: `13-…` (this phase).

## Evidence (all local, fixture-only)

- `npm run check` PASS, `npm test` 1043/1043 PASS, `npm run build`
  PASS, `npm run bundle` dry-run PASS (final re-run after last edit,
  quiescent tree, preview stopped, port 8791 verified free). One
  transient full-run flake observed earlier (node worker init
  failure in an unrelated file's runner, green alone and on
  re-run); recorded, not hidden. Check manifest `bc4fb01f…`
  (post-DGM-merge tree; 1002 catalog-side + ~41 DGM tests).
- Renders 01–13: real headless-Edge captures against local fixture
  `wrangler dev` (owner session, seeded `render-box` telemetry).
- Renders 14–20: interactive CDP-driven Edge journeys, same fixture
  posture (owner session, seeded `render-box`/`render-box2`
  telemetry; `quiet-box` without telemetry for unknown-compat).
  14 cancelling, 15 cancelled, 16 timeout/failed wording,
  17 Overview counts (ready excluded from active), 18 blocked
  compat, 19 cancelling at 390px, 20 deployments list at 390px.
  All seven inspected pixel-by-pixel; journey log JOURNEY-OK.
- Mocked tests prove control-plane logic only; live qualification is
  BLOCKED behind doc 13 and is not claimed anywhere in code or UI.

## Review-fix round (post-`6882227`)

- Frozen candidate `6882227f49` (clean tree verified); review work
  as new commits only, no history rewrite.
- Commissioned fresh-context reviews of `b192554..6882227`: code
  HOLD pending F1–F7, security READY. Migration overlap: none —
  0018/0019 exist only on this branch (renumbered from 0017/0018
  after the DGM merge); main is at 0017.
- Triage treated findings as questions-not-bugs; every fix was
  reproduced with a failing deterministic test first (~24 new
  behavior tests; F1/F2 race gates pass 10/10).
- Fixes: receipt CAS + conflict re-read/replay (F1); idempotency
  race catch (F2); `cancelling` pending state, ack-only completion,
  held reservation, late-receipt audit (F3/F9); summary excludes
  ready (F4, pinned live in render 17); shared guards at
  plan+execute (F6/F7); max reserve (F20); same-side grant
  staleness (S-F14); demo eval gate + filtered total (S-F9/F13);
  script intake caps (S-F3/S-F8); cache prune+cap (S-F12); quota
  checks (F5/F15); `BASE_NOT_FOUND` (F18); shard/magic handling
  (S-F6/S-F7); UI resetState + cancelling states (S-F10/F9).
  F8 stays a documented live-gate (migration 0019 header);
  F14/F18 keep deliberate `needSession` posture; F16
  (GET advances via idempotent receipts) is intentional.
- Interactive journeys asserted: native-button/focus-visible,
  revision label, double-execute-single-job, cancelling→cancelled
  with ack note, list-tracker consistency, TIMEOUT/LOAD_FAILED +
  NOT-verified wording, blocked offers no plan action, unknown
  compat, back/forward reload, mobile 390 cancel cycle.
- Re-review of the final delta (fresh context, read-only):
  READY. All 16 fixes confirmed present and bounded; F1/F2/F9
  tests judged genuine (real UNIQUE index, serialized-gate
  races, exact event trails); no secrets, no trust broadening.
  Verified against the better-sqlite3 shim only — live-D1
  behavior untested, consistent with the fixture-only posture.
- Follow-ons from that round, all reconciled in the release pass
  (below): N1–N7.

## Release pass (N1–N7 + site release)

Peter directed release: push, review, merge, and deploy this scoped
feature to the existing Cloudflare site; fix-forward online for
ordinary defects, roll back for security/tenant-isolation/data-loss
risk. No paid inference, model downloads, credential changes, or
live worker qualification under this release.

- N1 fixed: a cancelling job past the 60s quiet window fails
  `CANCEL_UNCONFIRMED` WITH its reservation held (new
  `{ release: false }` transition option); the hold frees only on a
  terminal worker report or lost node access (terminal-read
  reconciliation). Unknown execution never frees potentially
  occupied capacity. Pinned by 3 tests (threshold hold, late-ack
  release, revocation release).
- N2 fixed: fixture transport gains `peek`; status reads run
  peek → CAS → consume-on-success, so a race loser destroys
  nothing. Stale replays are consumed-but-unapplied; the old
  conflict-audit is removed (nothing is lost to audit). Revocation
  reordered to transition-then-cancel (same N6 root cause). Pinned
  by 2 tests (peek unit, serialized-consumption race).
- N3 fixed: transitions commit as one guarded batch — CAS UPDATE +
  conditional event marker (deterministic `ev_<job>_<from>_<to>`
  id; a same-target loser PK-conflicts and rolls back) +
  marker-conditional release. Uses the repo's proven D1
  batch-as-transaction contract. Pinned by 2 tests (marker ids,
  loser-commits-nothing) plus 3 miniflare-D1 runtime proofs.
- N4 fixed: admission checks `needBytes = max(plan, re-evaluated)`
  and reserves the same figure — one variable, no check/reserve
  skew. Pinned by a growth-in-the-window test (compat passes,
  admission 409s with `neededBytes`).
- N5 documented residual (reviewer's suggested treatment):
  racing finalizes can both pass; over-admission bounded to one
  footprint and visible to later checks — same class as F8.
- N6 fixed: cancel sends the worker request only after a
  successful CAS (first try and retry converge); a lost race sends
  nothing. Pinned by a lost-race test (no flag, no phantom audit).
- N7 fixed: big-endian Mach-O magics refused; cancelling
  self-transition removed from the predicate. Pinned by 2 tests.
- UI: heartbeat availability vs capability-report freshness
  disambiguated — strip says "no worker heartbeats seen" (never
  bare "telemetry"), compat card says "capability-report age …
  snapshot only, not a connected node". Pinned by 2 tests.
- Migrations verified against current main (not assumed): main is
  at 0017 post-DGM-merge, 0001–0017 byte-identical on this branch,
  0018/0019 are the correct next numbers. New
  `catalog-d1-runtime.test.mjs` (5 tests) applies 0001–0019 on
  real local D1 (miniflare),
  asserts catalog tables/columns, and proves the N3/admit SQL —
  including under FK enforcement, which local D1 applies and the
  node shim does not (seeds carry real parents).
- Release target discovered: live site serves chain merge
  `2ed8fdf` (run 40981033161), prod D1 journal exactly
  0001–0015, `auth_deployed:false` is a hardcoded build
  placeholder (same both sides). PR #47 (0016 + admin scaffold)
  is merged but never deployed: this release carries it, so the
  migration plan was 0016+0017+0018 at discovery time —
  superseded by the journal-driven plan below (pending entries
  through 0019) after the DGM merge.
  Admin router reviewed for the carry: deny-by-default, live
  grant re-check, keys/demo fail closed, mutations 501, no
  state changes — prod has no grant rows, so all admin routes
  fail closed until operator-SQL grants exist.
- Main is unprotected (no required reviews/checks enforced by
  GitHub); the release follows the normal process anyway: draft
  PR → CI green → independent reviews → merge with
  `--match-head-commit`, no self-approval. No open PRs and no
  competing catalog writer at release start.
- DGM collision, RESOLVED DGM-first: code review found branch
  `muse/dgm-fixture-preview` carrying `0017_dgm_preview.sql`
  (tables `dgm_preview_*`, disjoint from catalog tables) behind
  DRAFT PR #49 — same migration number as catalog's 0017. The
  merge-time re-verification gate then caught #49 merging to
  main (`3fa309c`) mid-pass, so the documented fallback ran:
  catalog renumbered 0017/0018 → 0018/0019 (files, headers,
  shim list, tests, docs; F8 comment now points at the 0019
  header) and merged `origin/main` via merge commit. The 3
  merge conflicts were mechanical migration-list unions
  (d1-shim, federation-main-upgrade, integration-boundaries
  count 19); worker.js/schema.js auto-merged cleanly (DGM
  import + version 0.5.0 + readiness arg compose with the
  catalog tables already in the readiness contract). The
  renumber commit also strips the last worker.js BOM (a
  stacked second BOM the first strip missed), adds
  FAT_CIGAM_64, and fixes the seeded-shape comment. Reviewed
  commits keep their SHAs (merge, not rebase); only the merge
  resolution + renumber are new surface.
- Release-candidate reviews: security READY on `c374be8` (no
  medium+ findings; 4 infos, no action). Code review on
  `c374be8`: code fully verified + suite independently
  re-run green, verdict HOLD solely for the extrinsic DGM
  process collision (now resolved above). Code findings 2
  (runtime SQL hand-mirrored), 3 (PK-conflict comment
  overstated), 4 (release guard should also check
  post-state), and 8 (FAT_CIGAM unscreened) are all fixed:
  `TRANSITION_SQL` exported from the worker and imported by
  the runtime test, release guarded on marker + post-state
  with a stale-loser regression proof, comments corrected,
  fat-magic family completed (incl. FAT_CIGAM_64). Focused
  delta re-review: READY for `f95758e` (2 low + 3 info, none
  blocking; the lows/infos are the BOM remainder, an off-by-one
  in a doc contingency line, FAT_CIGAM_64, and two comment
  wordings — all folded into the renumber commit). BOM churn
  flagged by both reviews is stripped (encoding-only commit
  plus the final stacked-BOM removal).

## Local reproduction

```
git worktree add aipster-catalog muse/model-catalog
cd aipster-catalog/website
npm ci
npx wrangler d1 migrations apply aipster-app --local
npm run check && npm test && npm run build
npx wrangler dev --port 8791 --var CATALOG_FIXTURES:1 \
  --var BETTER_AUTH_URL:http://localhost:8791
```

Serve note: wrangler serves `./dist` — rerun `npm run build` after
any `public/` edit and restart dev before trusting a render.

## Reviewer checklist

- Auth boundaries: session-only mutations + CSRF; demo denied
  plan/execute/upload; API keys never mint/ingest.
- Tenant isolation: owner-only `priv:`/jobs (404, never 403);
  grants directional; revocation fails flights.
- Plan tokens: HMAC, principal-bound, 15-minute, immutable;
  execute re-resolves pins and re-evaluates (cache never authorizes).
- Idempotency: key+principal+fingerprint; mismatch 409s, never merges.
- Reservations: held before dispatch, released on every terminal
  failure/cancel; ready keeps its hold (documented, no unload API).
- Honesty: `STORAGE_UNPROVISIONED`, `WORKER_API_UNAVAILABLE`,
  DEMO/fixture labels, unknown-cost-never-$0, no live claims.
- UI: `esc()`-only rendering of untrusted content; generation
  fencing; text state labels, not color-only.
- Migrations: 0018→0019 additive; readiness gates updated; no prod
  application in this branch.
- Hygiene: no secrets, credentials, or machine-private data in the
  branch; attribution comments only.

## Known limitations carried forward

R2 unprovisioned (prod chunk routes 503 by design); no worker
lifecycle transport (live dispatch refused); no unload API; owner/
node caps (5/2) provisional; live Hub never exercised; `validated`
unreachable until qualification; 128 MiB scaffold assembly cap.

## PR handoff (owner action — NOT done here)

Title: `Model/adapter catalog: discovery, uploads, qualified deployment (Phases 0–3)`

Body: scope + evidence above; fixtures-only; live qualification
blocked behind doc 13; reviewer checklist; rollback below.

```
git push -u origin muse/model-catalog
gh pr create --base main --head muse/model-catalog --title "…" --body "…"
```

Merge prerequisites: independent review clearance of the exact SHAs;
CI green; main still `3fa309c` at merge (re-verify: no new merge
since the branch's merge commit); files overlap the chain lane —
coordinate with the release owner before merge.

Deploy prerequisites: D1 backup (private dir, never committed);
read the live prod journal and apply every pending migration in
filename order (expect 0016 admin + 0017 DGM + 0018/0019 catalog
unless a newer deploy already applied some — never assume);
readiness probe (journal rows, `admin_grants` + `dgm_preview_*` +
catalog tables present); no new secrets (uses `BETTER_AUTH_SECRET`;
`CATALOG_STORE` binding deferred by design); health/readiness +
smoke (login, admin routes fail closed without grants, compat
unknown without telemetry, plan refusal live, catalog fixture
journeys).

Rollback: restore the D1 backup; redeploy the previous release.
Migrations are additive (new tables/columns only).

## Explicitly NOT done

R2 provisioning, credential enrollment, paid calls, live
inference, live worker qualification. Push, PR, coordinated merge,
prod migration (pending journal entries through 0019), and deploy
are authorized under the release pass above and proceed through
the normal process (CI green, independent reviews recorded,
`--match-head-commit`, no self-approval, runbook-order migration
+ deploy).

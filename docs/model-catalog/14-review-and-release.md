# Model catalog — review packet and release handoff

<!-- Built with Meta Muse. -->

## Scope

- Branch: `muse/model-catalog` (LOCAL-ONLY, never pushed).
- Base: `47444a5` (main, Merge PR #47 admin-scaffold).
- Commits: `b192554` (Phase 0) → `f1b1a05` (Phase 1) →
  `173268d` (Phase 2) → `3d9a1b3` (Phase 3) → (this commit, Phase 4 docs).
- Worktree: `aipster-catalog/` beside the main checkout.

## What changed

- Phase 0: base record, capability matrix, plan, threat model
  (`docs/model-catalog/00–02`).
- Phase 1: migration 0017, Hub adapter + fixtures + estimator,
  search/detail/compat/capability/summary routes, Models tab +
  Overview card, 30 tests, renders 01–06.
- Phase 2: validator + byte store, upload session routes, `priv:`
  detail/compat, My assets + upload UI, 14 tests, renders 07–09.
- Phase 3: migration 0018, fake worker transport, plan/execute/
  status/cancel routes, job tracker UI + Deployments list, 19 tests,
  renders 10–13.
- Receipts: `10-phase1-receipt.md`, `11-phase2-receipt.md`,
  `12-phase3-receipt.md`. Real-node proposal: `13-…` (this phase).

## Evidence (all local, fixture-only)

- `npm run check` PASS, `npm test` 961/961 PASS, `npm run build`
  PASS, `npm run bundle` dry-run PASS (final re-run after last edit).
- Renders 01–13: real headless-Edge captures against local fixture
  `wrangler dev` (owner session, seeded `render-box` telemetry).
- Mocked tests prove control-plane logic only; live qualification is
  BLOCKED behind doc 13 and is not claimed anywhere in code or UI.

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
- Migrations: 0017→0018 additive; readiness gates updated; no prod
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
CI green; no reported chain collision (files overlap the chain lane —
coordinate with the release owner before merge).

Deploy prerequisites: D1 backup; apply 0017→0018 on staging first,
then prod; no new secrets (uses `BETTER_AUTH_SECRET`; `CATALOG_STORE`
binding deferred by design); health/readiness + smoke (login,
compat unknown without telemetry, plan refusal live).

Rollback: restore the D1 backup; redeploy the previous release.
Migrations are additive (new tables/columns only).

## Explicitly NOT done

Push, PR, merge, deploy, R2 provisioning, credential enrollment,
paid calls, prod migration, live inference. Independent review has
not been performed — this packet requests it; nothing here is
self-approved for merge.

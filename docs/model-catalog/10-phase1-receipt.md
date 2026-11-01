# Model catalog — Phase 1 receipt (read-only discovery + compatibility)

<!-- Built with Meta Muse. -->

- Branch: `muse/model-catalog`. Base: `47444a5`. Commit: (this commit).
- Gate: AC01–AC09 + AC22 slices. `npm run check` PASS,
  `npm test` 928/928 PASS (30 new: 8 search + 8 compat + 5 capabilities +
  9 UI), `npm run build` PASS, `npm run bundle` dry-run PASS.

## Delivered

- Migration `0022_model_catalog.sql`: `node_capabilities`, `catalog_assets`,
  `catalog_asset_files`, `catalog_uploads`, `catalog_compat_cache`,
  `catalog_deployments`, `catalog_deployment_events`. Readiness contract
  (`schema.js`) + test shim + migration-count assertions updated.
- `src/lib/catalog/`: `hub.mjs` (allowlisted Hub metadata client, manual
  redirect cap, fixture mode, call counting), `fixtures.mjs` (4 synthetic
  models incl. gated + hostile card, 2 snapshots), `estimate.mjs` (pure
  single-node estimator, fixture-only matrix, method/uncertainty always).
- Routes: `GET /api/catalog/search` (filters, limit/offset, per-node compat
  filter), `GET /api/catalog/assets/:id`, `POST /api/catalog/compat`
  (principal-aware cache, full-fingerprint key incl. adapter base),
  `GET /api/catalog/summary`, `POST|GET /api/resources/:id/capabilities`
  (heartbeat-key auth, strict schema v1, 25s cost guard).
- UI: Models tab (search/detail/compat/decision), Overview card, demo
  restrictions, stale-generation drops, `role=status` + focus target +
  text state labels, external links marked, inert card rendering.

## Acceptance mapping

- AC01: `calls.weights === 0` on search/detail/compat; no download
  affordances in payloads. AC02: cross-tenant node 404s; grant permits.
- AC03: pagination slices; empty 200+`[]`; 400/502 distinct; UI empty/error
  states. AC04: hostile card entity-escaped, no live elements/handlers.
- AC05: weight-fit/context-OOM blocks `INSUFFICIENT_VRAM` with breakdown.
- AC06: one nodeId per evaluation; sibling snapshots never merge.
- AC07: missing/stale → `TELEMETRY_MISSING/STALE` unknown; revoked → 404.
- AC08: untested runtime, base-revision mismatch, tokenizer mismatch block;
  missing metadata unknown; adapter needs explicit baseRepo.
- AC09: changed inputs miss cache; fingerprint carries asset+adapter+base+
  node+runtime+settings+snapshot; revocation denies despite cache.
- AC22: keyboard-native controls; decision focus target; announcements;
  1440+390 renders verified (see `renders/`).

## Bugs found by tests during this phase

1. Compat-cache fingerprint omitted the adapter base → stale cross-base
   replay. Fixed (base in fingerprint) + regression test.
2. Partial-schema health tests + migration-count assertions needed 0018
   (readiness covers compiled routes). Updated, not weakened.

## Renders (`docs/model-catalog/renders/`)

Real headless-Edge captures against local `wrangler dev` (fixture mode,
seeded session): 01 overview 1440, 02 models 1440, 03 detail 1440,
04 compat-unknown 1440, 05 models 390, 06 overview 390. All show DEMO DATA
labeling; unknown state names `TELEMETRY_MISSING`; Deploy honestly disabled.

## Limitations / not in Phase 1

- Live Hub calls implemented but never exercised (fixtures only in tests;
  no network in CI). Upstream-outage UI state tested via injected failure.
- No metadata cache: Hub outages surface as 502, not stale-cache-with-age.
- `validated` decision state unreachable (no qualification records yet).
- Private assets, uploads, plans, deployments: schema only; routes Phase 2–3.
- R2 still unprovisioned (blocks real upload bytes, Phase 2).

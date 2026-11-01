# Model catalog — Phase 2 receipt (private uploads + validation + My assets)

<!-- Built with Meta Muse. -->

- Branch: `muse/model-catalog`. Commit: (this commit).
- Gate: AC10–AC13. `npm run check` PASS, `npm test` 942/942 PASS
  (14 new: 10 uploads + 4 upload-UI), `npm run build` PASS,
  `npm run bundle` dry-run PASS.

## Delivered

- `src/lib/catalog/validate.mjs`: pure structural validator — explicit
  manifests, traversal/symlink policy, suffix matrix (no archives,
  executables, scripts, pickle weights), magic-number screen, bounded
  safetensors header + offset checks, shard-index consistency, adapter
  binding requirements. Never instantiates or executes a model.
- `src/lib/catalog/store.mjs`: byte persistence behind one interface —
  R2 when `CATALOG_STORE` is bound, ephemeral memory in fixture env,
  `STORAGE_UNPROVISIONED` otherwise (never silent).
- Routes: `POST /api/catalog/uploads` (manifest intake + quotas),
  `PUT …/chunk` (idempotent indexed chunks, 8 MiB cap),
  `POST …/finalize` (bounded assembly, digests, validate, atomic promote),
  `GET …/:id` (owner status), `GET /api/catalog/my-assets`,
  `POST /api/catalog/assets/:id/validate` (re-run). Upload sessions lazy-
  expire (24h) with best-effort quarantine cleanup.
- Private refs end-to-end: `priv:` detail (owner-only 404s), compat
  accepts `assetId`/`adapterAssetId`/`baseAssetId`; non-validated bytes
  refuse with `ASSET_NOT_VALIDATED` (AC12).
- UI: My assets list (validation pills, Details, Revalidate), upload form
  with chunked progress + adapter fields toggle, safe rejection rendering,
  demo hiding, logout clearing.

## Acceptance mapping

- AC10: upload→validate→list; cross-tenant 404s; demo denied; session-only
  ingestion (API keys refused).
- AC11: traversal/suffix/magic/shard/digest/quota/chunk refusals; rejected
  uploads create no rows.
- AC12: promote batch is atomic (asset + files + upload state one commit);
  rejected assets cannot evaluate.
- AC13: duplicate chunk/finalize idempotent; interrupted resumes; expired
  410s; digest mismatch fails without corruption.

## Bugs found by tests during this phase

1. Finalize bound NULL into `catalog_assets.base_revision` (NOT NULL) →
   500. Fixed (bind `''`) — surfaced via a temporary debug flag, removed.
2. Traversal test defeated itself (`|| 'x'`); placeholder-count typo in a
   demo seed. Both test-side, fixed.

## Renders (`docs/model-catalog/renders/`)

07 upload form, 08 validated asset listed, 09 rejection (`ASSET_REJECTED`
in place, nothing listed). Real headless-Edge captures with real file
bytes via CDP file input.

## Limitations / not in Phase 2

- 128 MiB scaffold finalize/validate cap (in-memory assembly; Workers
  memory bound). Streaming multipart promotion is documented follow-on.
- R2 still unprovisioned: fixture memory store in tests/local only; prod
  chunk routes honestly 503.
- No version-update flow: changed bytes are a new asset (immutable).

# Model catalog — Phase 0 implementation plan

<!-- Built with Meta Muse. -->

## API mapping (logical PRD ops → concrete routes)

All routes same-origin under `/api/catalog/*` (session or API-key auth via
existing `actorFrom`; session mutations CSRF-guarded; demo denied
non-read ops). Versioned errors `{ error, code, retryable, action }`.

| PRD op | Route | Phase |
|---|---|---|
| Catalog search | `GET /api/catalog/search?q=&task=&arch=&format=&quant=&runtime=&license=&kind=&compat=&nodeId=&limit=&offset=` | 1 |
| Asset detail | `GET /api/catalog/assets/:id` (Hub `org/name` or `priv:<uuid>`) | 1 |
| Compatibility evaluate | `POST /api/catalog/compat` `{ repo\|assetId\|assetRef, adapterRepo\|adapterAssetId?, baseRepo\|baseAssetId?, nodeId, context, concurrency, runtime }` (ref aliases accepted; one must be present) | 1 |
| Capability report | `POST /api/resources/:id/capabilities` (heartbeat-key auth, schema v1) | 1 |
| Upload begin/chunk/finalize/status | `POST /api/catalog/uploads/*` | 2 |
| Asset validate | `POST /api/catalog/assets/:id/validate` (re-run; bounded) | 2 |
| My assets | `GET /api/catalog/my-assets` | 2 |
| Plan create | `POST /api/catalog/plans` → plan token (15 min, principal-bound) | 3 |
| Deployment execute | `POST /api/catalog/deployments` (plan token + idempotency key) | 3 |
| Job get/cancel | `GET /api/catalog/deployments/:id` advances + returns; `POST .../:id/cancel` requests cancel (pends as `cancelling` until the worker acks) | 3 |

Worker lifecycle transport (download/verify/load/unload/cancel/report) does
not exist: Phase 3 implements the control-plane side (plans, durable jobs,
idempotency, reconciliation) against a `WorkerTransport` interface with a
fake implementation. Real dispatch stays disabled with explicit
`WORKER_API_UNAVAILABLE` + missing dependency per action — no cosmetic
success path.

## Migration 0022 (`0022_model_catalog.sql`)

- `node_capabilities(node_id PK→resources, schema_version, reported_at,
  os, arch, runtimes_json, mem_json, disk_json, workload_json)` —
  worker-reported, server-timestamped; writes only via capability endpoint.
- `catalog_assets(id PK, owner_id NULL=public-HF-mirror-row, source,
  repo, revision, kind, task, arch, format, quant, license_json,
  access, manifest_json, validation, created_at)` — HF rows are cached
  metadata (owner NULL); private rows carry `owner_id` + `access='private'`.
- `catalog_asset_files(asset_id, relpath, bytes, sha256)` — explicit file
  manifests; traversal rejected at write.
- `catalog_uploads(id PK, owner_id, state, quotas_json, expires_at, …)` —
  session state machine; byte refs NULL until R2 exists.
- `catalog_compat_cache(key PK, principal, fingerprint_json, decision_json,
  expires_at)` — principal-aware, invalidated by input/policy change.
- `catalog_deployments` + `catalog_deployment_events` — durable jobs.
- All catalog reads filter `owner_id = me() OR access='public'`; private
  existence never leaks (404, not 403, for cross-tenant asset ids).

## UI plan (existing tab pattern)

- New `models` tab: dashboard card summary + catalog browser + detail +
  My assets + upload dialog + plan confirmation + job tracker. Follows
  `loadModels()` + `renderStatus`-style helpers in `app.js`; accessible
  dialogs with focus return; `role=status` progress announcements.
- Overview tab gains a compact "Models & adapters" card (counts + last
  fabric refresh + Browse/Upload shortcuts). Empty fabric → "add a node"
  guidance, no manufactured recommendations.
- Model cards rendered as sanitized text (existing `esc()` helper); external
  links marked; no embedded-instruction following (no `eval`, no link
  prefetch, no auto-download).

## Estimator (Phase 1)

`website/src/lib/catalog-estimate.mjs`: pure function
`(artifact, adapter, settings, snapshot, matrix) → decision`.
Budgets weights + KV(context×concurrency) + buffers + adapter + load
workspace + reserve (default 15%, owner-confirmable). Method/version/
uncertainty always returned. Matrix = fixture-llama + explicit unsupported
list. Unit-tested with synthetic headers; no downloads.

## Fixture strategy

- `website/tests/fixtures/catalog/` (new): synthetic Hub metadata pages,
  artifact manifests, safetensors/GGUF header bytes, capability snapshots,
  validator corpus (good + traversal/oversize/bad-shard/unsafe-pickle cases).
- Fake Hub adapter: serves fixtures; counts outbound calls (AC01 asserts
  zero weight fetches). Real Hub fetch code exists but tests run offline.
- Fake worker transport: scripted receipts (AC15–AC17 restart/reconcile).
- Two test identities + demo account for isolation tests throughout.

## R2 request for rollout owner (blocks real bytes only)

- Bucket (name TBD by owner, e.g. `aipster-catalog-quarantine` + `-assets`),
  binding `CATALOG_STORE`, lifecycle: quarantine prefix expiry 7d, multipart
  cleanup. Worker needs `r2:read/write` on these buckets only. Until bound,
  upload finalize returns `STORAGE_UNPROVISIONED` (fixture validator still
  fully tested on synthetic bytes).

## Gates per phase

- P1: AC01–AC09 + AC22 slices; `npm run check/test/build/bundle` green.
- P2: AC10–AC13 + isolation/validator tests; same gates.
- P3: AC14–AC21 with fake transport; same gates.
- P4: real-node proposal (no execution), independent review, release package.

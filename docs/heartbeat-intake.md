# Owner-confined heartbeat intake

Branch: `muse/heartbeat-intake` (stacked on `muse/resource-status-strip`).
Status: unmerged. **Merge blocker: federation-owner (Peter Medina) sign-off on
migration number 0013** — see "Migration coordination" below.

## What this is

`POST /api/resources/:id/heartbeat` is the only telemetry writer in AIPSTER.
An owner mints a **heartbeat-scoped API key bound to exactly one resource**,
installs it next to that resource, and the resource proves it is reachable by
posting heartbeats. There is **no sender/daemon** in this slice: intake only.

A heartbeat proves **reachability only, never inference acceptance**:

- `usable: true` — the resource reports itself reachable and willing. This
  still does not make it runnable: dispatch authorization, grants, and
  `POST /api/jobs` (which stays `501 INFERENCE_DISABLED`) are unchanged.
- `usable: false` — the resource is reachable but explicitly **not acceptable
  for inference**. Either value refreshes `heartbeat_at` liveness, but
  `usable=false` must never render as runnable/ready anywhere; the Overview
  strip gives it a distinct not-ready attention presentation.

## Request contract

```
POST /api/resources/:id/heartbeat
Authorization: Bearer <heartbeat-scoped key for :id>
Content-Type: application/json

{"usable": true}
```

- **Auth is API-key only.** Session cookies are rejected with `403
  KEY_REQUIRED` before any CSRF check, so this endpoint has no CSRF surface.
  Read/inference keys are rejected with `403 KEY_SCOPE`; heartbeat keys are
  rejected by every other route (`KEY_SCOPE` on read routes, `KEY_FORBIDDEN`
  on management routes).
- **Strict body: exactly `{"usable": boolean}`.** Unknown fields, missing or
  non-boolean `usable`, arrays, and empty bodies are `400 BAD_HEARTBEAT`.
  Bodies over **1 KiB** are `413 BODY_TOO_LARGE`. Client timestamps are never
  accepted: the server sets `heartbeat_at=now` and `online=1` plus the body's
  `usable` bit, and no other columns change.
- **Binding:** the key's `resource_id` must equal `:id`, the resource must be
  owned by the key owner, and the row must exist. Violations are `404
  NOT_FOUND` (binding mismatches intentionally do not distinguish
  "wrong resource" from "missing resource").
- **Key liveness:** revoked keys are `401 KEY_REVOKED`, expired keys are `401
  KEY_EXPIRED`. Disabled owners (migration 0004) authorize nothing (`401`).
- **Rate window:** at most one accepted heartbeat per resource per **25s**.
  Too-soon posts are `429 HEARTBEAT_TOO_SOON` with a `Retry-After` header
  (seconds until the window opens) and a matching `retryAfterSec` body field.
- **Atomicity:** ownership, owner-disabled, not-deleted (row existence),
  binding-match + key-live, and the 25s window checks all live inside **one
  single conditional `UPDATE ... WHERE`** — no read-then-write. Lost claims
  are mapped to 404/401/429 by read-only probes afterwards; losers change
  zero rows.
- **No budget draw:** heartbeats never touch the hourly `write_budget`
  (migration 0005); intake works at a spent budget.
- **Audit:** key creation is logged (`key.create`, detail records the
  binding). There is **no audit row per heartbeat** — only the coarse
  hourly `key_verifiers.last_used_at` advances.
- **Success:** `200 { ok: true, id, heartbeatAt, online: true, usable }`.

## Minting a heartbeat key

Session-only, like all key management:

```
POST /api/keys   { "name": "lab-1 sender", "scope": "heartbeat", "resourceId": "r_..." }
```

- `resourceId` is required and must be caller-owned, else `404`. It is
  rejected for `read`/`inference` scopes (`400 BAD_RESOURCE`).
- **Demo users cannot mint heartbeat keys** (`403 DEMO_RESTRICTED`); demo
  telemetry stays fixture-labeled.
- The secret is revealed once; only the salted verifier is stored. Key
  listings expose the binding as `resourceId` (null for read/inference keys).

Example sender call (the Keys panel reveals a copyable, pre-filled variant):

```sh
curl -X POST https://aipster.net/api/resources/r_abc123/heartbeat \
  -H "Authorization: Bearer aip_live_k_..." \
  -H "Content-Type: application/json" \
  -d '{"usable":true}'
```

Use disposable local test keys throughout development (test fixtures / local
D1). Production credentials and deployment are out of scope for this slice.

## Strip semantics

- Liveness (`online`/`stale`/`offline`/`unknown`) stays derived by the
  5-minute rule in `website/src/lib/status.mjs`; intake never redefines it.
  `usable` never promotes a row to `online`.
- Only heartbeat-seen rows replace the "telemetry unavailable" copy, with
  reachability-only wording. `usable=false` rows render
  `ATTENTION: reachable but NOT usable for inference`.
- `DEMO DATA` labels are unchanged.

## Migration coordination

- Binding column: `website/migrations/0013_heartbeat_binding.sql`
  (`key_verifiers.resource_id` + index). Purely additive.
- Numbers **0006–0012 are reserved** for the federation integration lineage
  (PR #14 → #18 ordered plan); this branch's `migrations/` intentionally
  jumps 0005 → 0013, which `wrangler d1 migrations apply` and the test
  `MIGRATION_FILES` list both apply in filename order.
- **Owner sign-off is a merge blocker:** federation owner Peter Medina must
  confirm the 0013 reservation against the live federation heads at PR time
  (the federation plan is DRAFT and renumbers can shift on rebase). Recorded
  2026-10-28; unconfirmed at implementation time.

## Non-goals

No sender/daemon, no EIF fabric wiring (EIF liveness stays separate from
AIPSTER D1 intake), no inference acceptance, no changes to `local-worker/**`
or federation files, no merge/deploy/remote-migrate/production from this
slice.

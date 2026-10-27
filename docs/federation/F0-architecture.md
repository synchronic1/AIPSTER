# F0 — Federation contracts, architecture, and decisions

Feature branch `muse/federation-control-plane`, base `c8854bc` (PR #3 head at
branch time). PR #3 (`muse/control-panel-cloudflare-auth`) is frozen: this
branch adds federation; it never modifies release behavior except the two
F0-authorized truthfulness corrections (usage-null totals, grant-enforcement
copy), which the release owner may cherry-pick independently. Pending
dependency: PR #3 unmerged — rebase onto `main` after it merges; federation
routes depend on PR #3 auth/tenant primitives.

## Identity boundaries (nonnegotiable)

Owner (human + owner-role binding) ≠ workspace (tenant namespace) ≠ node/
gateway (workload identity, routing only) ≠ worker/resource (immutable ID +
incarnation + endpoint binding) ≠ consumer principal (named user/service) ≠
trusted agent (explicit delegation envelope). A node is not its owner; a
connection grants no access; imported resources are never re-exportable.

## F1 decisions with platform evidence

1. **Admission atomicity: conditional-write batches + compensating release.**
   D1 `batch()` executes statements sequentially and rolls back the whole
   sequence on statement failure ([D1 docs](https://developers.cloudflare.com/d1/worker-api/d1-database/),
   fetched 2026-10-27). A batch cannot branch on results, so each reservation
   is a conditional `UPDATE pools SET held = held + ? WHERE id = ? AND
   held + ? <= ceiling`. Single-statement atomicity + D1's single writer mean
   ceilings can never be exceeded, even concurrently. A batch whose statements
   report zero writes on any pool is denied; partial holds are released by a
   compensating batch (transient under-admission only — the safe direction).
   Durable Objects remain a recorded alternative if strict multi-pool
   atomicity is later required. Read replication stays OFF.
2. **Idempotency:** operation ID primary key; retries reconcile by key, never
   re-reserve. Constraint failure aborts the batch; the handler returns the
   existing record (conflict on payload mismatch).
3. **Provider custody (design; F1P builds fixtures only):** upstream secrets
   live only as Cloudflare Worker secrets, referenced by name from D1
   (`credential_ref` + masked `last4`/fingerprint). Never in D1, browsers,
   peers, logs, or audit. Rotation = secret put + version bump; disable =
   version tombstone. No enrollment UI touches raw secrets.
4. **Peer identity (F1):** narrow peer service principals authenticated by
   scoped API keys with audience binding (`peer_id`, `audience` columns on
   key verifiers); remote user/agent strings are attribution-only.
   Workload identity (SPIFFE/mTLS) is deferred to a named decision before
   any real transport.
5. **Transport (F1):** fixture (in-process) only. Relay vs direct stays a
   Peter + security/privacy decision; no network peer code in F1.
6. **Approval binding:** JCS-subset canonicalization (`src/fabric/
   canonical.mjs`) + SHA-256 over the preview; full RFC 8785 deferred until
   a second implementation needs interop. Vectors in `tests/fabric-f0`.
7. **MCP:** thin dispatcher module over the same policy functions as HTTP;
   no MCP network transport in F1 (tool schemas defined 1:1 with API ops).

## State machines (PRD §7; enforced in F1, fixtures in F0)

- Invitation: draft → issued → accepted | declined | expired | revoked.
  Single-use verifier, 24h default expiry, recipient-bound, atomic redeem.
- Connection: pending → active | degraded | suspended | disconnected.
  Suspend/disconnect blocks admission; never auto-reactivates grants.
- Grant: draft → pending-approval → configured → applying → enforced, with
  paused | expired | revoked. "Enforced" needs all mandatory enforcement
  points on the revision; anything else is configuration-only.
- Approval: requested → approved | rejected | expired | cancelled |
  superseded → consumed. Bound to preview hash + revision vector, 10min
  default window, human-owner proof required for access expansion.

## F1 API/MCP surface (new `/v1/fabric/*`; UI mirrors Sharing)

Invitations (create/get/accept/decline/revoke), connections
(list/suspend/disconnect/resume), previews (grant + authorization),
approvals (list/request/decide), grants (commit/list/get/revise/pause/
resume/revoke), discovery (nodes/resources, policy-filtered), usage/audit
reads. Mutations require Idempotency-Key; revisioned writes require
If-Match/preview+approval+revision vector. Status codes per PRD §10
(401/403-or-404/409/412/422/429/503/501). MCP tools named
`fabric_*` 1:1; identical schemas, checks, errors, audit.

## Migration plan (draft; implemented in F1)

`0005_fabric.sql` (additive): `nodes`, `node_identities`, `invitations`,
`connections`, `grant_previews`, `approvals`, `fabric_grants`,
`fabric_grant_revisions`, `operations`, `reservations`, `quota_pools`,
`peer_keys` extension columns; `resources` gains `incarnation`,
`enrollment_generation`. `0006_provider.sql` (F1P): `provider_accounts`
(metadata only, `credential_ref`), model allowlists, budget pools.
Feature flag `FEDERATION_ENABLED` (default off) gates routes + UI.

## Reuse map

Need → existing → disposition: tenant isolation → `owner_id` + actor
checks (`worker.js`) → extend with workspace/audience columns; API-key
lifecycle → `lib/keys.js` → extend with peer binding; invitation
verifiers → key-verifier pattern → reuse pattern, new table; audit →
`audit()` (`lib/store.js`) → reuse, add actor/delegator fields; adapter
seam → `aipster-local/lib/adapters.mjs` fake/stub → mirror fixture
adapter; sessions/CSRF/logout → Better Auth + app client → reuse incl.
generation fencing; readiness/health → `/api/health` pattern → extend
with migration-column checks for new tables; operator scripts →
`scripts/disable-user.mjs` + `lib/operator-sql.mjs` → same pattern for
federation ops tooling. No provider adapter exists — documented gap.

## F0 test vectors (runnable)

`tests/fabric-f0.test.mjs` + `tests/fixtures/fabric/`: canonicalization
vectors, digest stability/tamper-evidence, approval binding, allow w/
deterministic witness, A06 no-stitching, wrong-recipient/incarnation/
stale-revision denial, explicit-deny precedence, expired/paused denial.

## Open for F0 sign-off

Security-architect owner (credential profile, JCS full profile);
Codex F0 reconciliation (Dendrite/Fabric primitives vs this contract);
Peter: scope, data path, lifetimes, provider terms review.

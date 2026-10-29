# One-time worker pairing

Branch: `muse/onboarding-w2-pairing` (stacked on the W1 heartbeat merge).
Status: unmerged. Migration `0015_pairing.sql` follows heartbeat 0013 and
federation restriction receipts 0014; 0006–0012 remain the federation lineage.
This branch does not deploy those migrations. The 0013 sign-off note in
`docs/heartbeat-intake.md` still stands.

## What this is

Pairing is the explicit user-consent link between a signed-in owner and one
installed worker. The browser mints a short-lived single-use code; the worker
exchanges it for a resource row plus a resource-bound heartbeat key
(`docs/heartbeat-intake.md`). After that exchange, hardware discovery fields
arrive automatically — the user never fills out a CPU/GPU/capability form.

The pairing code is a bearer credential with training wheels: 60 bits,
10-minute default TTL (1–60 configurable), single use, burned after 10 wrong
guesses. The real long-lived credential — the heartbeat key — travels only
over the claim HTTPS response into OS-protected worker storage, and is never
shown, logged, or put in a URL.

## Endpoints

```
POST /api/pairing/codes   { "ttlMinutes": 10 }            # session + CSRF
-> 201 { id, code, expiresAt, oneTime }

POST /api/pairing/claim                           # code-authenticated ONLY
{ "code": "pair-…", "nodeId": "stable-node-id",
  "name": "lab-box", "kind": "local",
  "cpu": "…", "gpu": "…", "capabilities": ["summarize"] }
-> 201/200 { resourceId, created, resource, heartbeatKey, keyId,
             keyPrefix, heartbeatUrl, oneTime }
```

- **Mint** is session-only with CSRF, like all key management. Demo users
  cannot mint (`403 DEMO_RESTRICTED`): demo telemetry stays fixture-labeled.
  At most 5 live (unused, unexpired) codes per owner (`409 PAIRING_LIMIT`).
- **Claim** accepts no session and no API key — the worker holds no AIPSTER
  credential yet — so it has no CSRF surface. Only the code authenticates.
- Claim bodies are capped at 4 KiB. `nodeId` (1–64 id chars) is the worker's
  stable identity, generated once and kept in worker state; it is the
  idempotency key for the whole exchange.

## Claim semantics

- **Find-or-create by (owner, node):** a re-pair with a fresh code returns
  the same resource (`200`, `created: false`) instead of duplicating. Node
  ids are owner-scoped: two owners may each pair a `node-01` and stay
  isolated.
- **Key rotation on every claim:** a fresh heartbeat key is minted and all
  older live heartbeat keys for that resource are revoked, so a re-pair
  never leaves two live senders. Consent, resource identity, budget, key
  insertion/revocation and audit commit atomically, with the live owner and
  exact owner/node/resource binding checked in that transaction. The secret
  is verified before initial claims and reclaims. Mint-first ordering means a lost race at
  the key cap (`409 KEY_LIMIT`) never leaves the resource keyless — the old
  key keeps working until the owner revokes a stale one and re-pairs.
- **Lost-response reclaim:** if the claim response never arrives, the same
  node may re-submit the spent code within 10 minutes and receive a fresh
  sender key for the same resource. Any other node, or a later retry, sees
  the generic `404 PAIRING_INVALID`.
- **Display-name collisions** suffix (`lab`, `lab-2`, …). Identity is the row
  id / node binding, never the name.
- New rows are `configured=1, authenticated=1, online=0, usable=0` with
  origin `paired` and a `Paired …; awaiting first heartbeat` verification
  note. Liveness still comes only from heartbeat intake.

## Error shape (claim)

| Situation | Code |
|---|---|
| Malformed code / nodeId | `400 BAD_CODE` / `400 BAD_NODE` |
| Unknown, used (other node / stale), burned, disabled/demo/gone owner | `404 PAIRING_INVALID` (deliberately one shape: no oracle) |
| Expired | `410 PAIRING_EXPIRED` (expiry is not secret; the message says to mint again) |
| Owner write budget spent | `429 WRITE_RATE_LIMITED` |
| Owner resource cap (100) | `409 RESOURCE_LIMIT` via `RESOURCE_LIMIT` |
| Owner key cap (20) | `409 KEY_LIMIT` |

Guessing is rate-limited by the per-code attempt counter: 10 wrong secrets
burn the code permanently. Attempts are approximate under concurrency (a few
extra guesses may slip through a race); 60 bits keeps that harmless.

## What claim does NOT grant

Pairing creates an owned, authenticated row and a sender key. It grants no
compute to other users (no grants), no admin role, no inference permission
(`POST /api/jobs` stays `501 INFERENCE_DISABLED`), and no read/inference API
scope — the delivered key is heartbeat-scoped and fails every other route.

## Registration hardening (same slice)

- `POST /api/inventory` accepts `Idempotency-Key` (1–64 id chars). Replays
  return the original resource (`200`), even if valid input fields differ;
  the original registered fields win. Concurrent same-key requests converge
  on one resource, mapping, budget charge and audit. Replays occur before
  quota admission, including at an exhausted budget. Those writes commit
  atomically; no NULL in-flight mapping survives a failed insert or audit.
  Mappings expire after 24 h; a deleted-resource mapping provisions fresh.
- `DELETE /api/inventory/:id` (session + CSRF, owner-only, unbilled like
  other teardown): bound keys keep revoked rows with the binding nulled
  (senders read `KEY_REVOKED`, not a vanishing credential); grant and job
  rows for the resource are deleted; pairing history is kept with
  `resource_id` nulled; idempotency mappings are deleted; the resource row
  is deleted; `resource.delete` is audited. A second delete is `404`.
- Manual registration remains available. This API slice does not wire the
  pairing flow into the dashboard; that requires the separate dashboard slice.

## Worker side (installer slice)

The planned worker integration needs a `pair` step (packaged launcher + source-install script)
that takes the typed code, exchanges it, and stores `{resourceId,
heartbeatKey, nodeId}` in the user-ACL-only data dir — never logs, URLs, or
shared installers. The sender loop posts `{"usable": bool}` heartbeats with
the delivered key, honoring `429`/`Retry-After` and surfacing `401
KEY_REVOKED`/`KEY_EXPIRED` as re-pair prompts. `usable` defaults to false
unless the local engine is verified runnable: simulated/mock engines report
reachable-but-not-usable.

That worker step and OS-protected credential storage are requirements, not
implemented or qualified by this server PR. The current public worker/source
pin remains standalone and must not be configured to contact AIPSTER from these tests.

## Test map

`website/tests/pairing.test.mjs` (18 tests): mint auth/CSRF/key-denial, code
shape/TTL/storage, demo denial, mint cap, claim happy path incl. a real beat
with the delivered key plus inventory auto-appear, claim validation, attempt
burn, expiry, spent-code cross-node denial + same-node reclaim with key
rotation, re-pair dedupe, two-owner node isolation + cross-tenant heartbeat
denial, disabled-owner denial, name suffixing, idempotency replay/new/bad,
replay-after-delete, DELETE teardown (keys `KEY_REVOKED`, grants/jobs gone,
audit, second-delete 404), DELETE auth matrix, key-cap claim failure.
Disposable local fixtures only; no production credentials.

`pairing-security.test.mjs` and `pairing-registration.test.mjs` add SQLite and
actual local-D1 regressions for forged reclaim, closed/demo owners, stale node
bindings, enrollment/rotation/teardown audit rollback, concurrent rotation and
same-node pairing, revoked-key/grant-linked-job teardown, registration response
loss, same-key concurrency, exhausted budgets and closure at the batch boundary.


## Consolidated integration candidate

This separately reviewed pairing candidate stacks on the consolidated control-plane
repair (PR #29). It preserves the original Muse W1/W2 history and keeps the
pairing backend distinct from an available installer or worker pairing client.
The worker tree, source pins, licenses and notices remain unchanged.

The unapplied sequence is heartbeat 0013, federation restriction receipts 0014,
then pairing 0015. Applied 0001-0005 are unchanged. The shared readiness contract
requires pairing tables and resources.node_id even when federation is disabled,
because the pairing and registration routes are compiled into the base worker.
Partial-schema local-D1 tests reproduce the previously false-ready state; complete
schema, both heartbeat/federation orders, and exhaustion boundaries are tested.

Release-owner order: accept the final PR #29 head, then this pairing candidate.
Do not merge the original PR #28 and the repaired replacement independently.
No production migration, installer activation, running-worker enrollment or
inference is authorized by this review evidence.

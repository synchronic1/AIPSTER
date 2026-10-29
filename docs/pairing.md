# One-time worker pairing

Branch: `muse/onboarding-w2-pairing` (stacked on the W1 heartbeat merge).
Status: unmerged. Migration `0014_pairing.sql` continues past the 0013
heartbeat reservation; 0006–0012 stay reserved for the federation lineage,
and the 0013 sign-off note in `docs/heartbeat-intake.md` still stands.

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
  never leaves two live senders. Mint-first ordering means a lost race at
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
  return the original card (`200`); concurrent same-key requests serialize
  on the mapping row (`409 IDEMPOTENT_IN_FLIGHT` for the loser); mappings
  expire after 24 h; a mapping whose resource was deleted provisions fresh.
- `DELETE /api/inventory/:id` (session + CSRF, owner-only, unbilled like
  other teardown): bound keys keep revoked rows with the binding nulled
  (senders read `KEY_REVOKED`, not a vanishing credential); grant and job
  rows for the resource are deleted; pairing history is kept with
  `resource_id` nulled; idempotency mappings are deleted; the resource row
  is deleted; `resource.delete` is audited. A second delete is `404`.
- Manual registration stays available as the Advanced/expert path; pairing
  is the default onboarding flow in the UI (dashboard slice).

## Worker side (installer slice)

The worker ships a `pair` step (packaged launcher + source-install script)
that takes the typed code, exchanges it, and stores `{resourceId,
heartbeatKey, nodeId}` in the user-ACL-only data dir — never logs, URLs, or
shared installers. The sender loop posts `{"usable": bool}` heartbeats with
the delivered key, honoring `429`/`Retry-After` and surfacing `401
KEY_REVOKED`/`KEY_EXPIRED` as re-pair prompts. `usable` defaults to false
unless the local engine is verified runnable: simulated/mock engines report
reachable-but-not-usable.

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

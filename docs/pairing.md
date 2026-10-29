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
  Legacy NULL claims retain a five-minute read-only grace before atomic recovery;
  recent pending retries do not consume budget or create state.
  Mappings expire after 24 h; a deleted-resource mapping provisions fresh.
- `DELETE /api/inventory/:id` (session + CSRF, owner-only, unbilled like
  other teardown): bound keys keep revoked rows with the binding nulled
  (senders read `KEY_REVOKED`, not a vanishing credential); grant and job
  rows for the resource are deleted; pairing history is kept with
  `resource_id` nulled; idempotency mappings are deleted; the resource row
  is deleted; `resource.delete` is audited. A second delete is `404`.
- Manual registration remains available. This API slice does not wire the
  pairing flow into the dashboard; that requires the separate dashboard slice.

## Worker side and dashboard setup

The dashboard's authoritative source commands pin the published, reviewed
worker `5fd4aba06bd05143a029cf25f8976d3f823b754d`. They retain the sparse
`/local-worker/` + `/LICENSE` checkout and the pinned installation toolchain.
The linked standalone README is background documentation and may name an
older checkout; use the dashboard's explicit pairing commands instead.
Packaged launcher integration remains pending, and every installer button
stays unavailable until a verified artifact is published.

Source setup has two explicit steps in a second terminal in `local-worker`:
run `.\.venv\Scripts\python.exe pairing.py pair` and type the dashboard
code locally, then run `.\.venv\Scripts\python.exe pairing.py heartbeat-loop
--config configs/mock.toml`. Pairing persists private credentials and exits;
it does not start the sender. The POSIX equivalent uses `.venv/bin/python`,
but macOS/Linux adaptation is not qualified. Choose Done or reopen My Compute
after pairing to refresh inventory; the dashboard does not observe installation.
Do not paste pairing codes or stored heartbeat keys into agent conversations.

The sender posts `{"usable": bool}` with its heartbeat-scoped key, honors
`429`/`Retry-After` and transient failures, and prompts to re-pair after key
revocation/expiry. The supplied mock command always reports `usable=false`:
a heartbeat proves reachability, not inference readiness. For credential
storage and launcher integration, see the pinned worker's
[`PAIRING-INTEGRATION.md`](https://github.com/synchronic1/AIPSTER/blob/5fd4aba06bd05143a029cf25f8976d3f823b754d/local-worker/PAIRING-INTEGRATION.md).

To disconnect, stop both sender and daemon terminals, revoke the resource's
heartbeat key in AIPSTER Keys, then run the same venv Python with
`pairing.py unpair` to forget local state. Local unpair does not revoke the
server key, and removing `.venv`/`.state` alone does not remove credentials
from the private worker data directory. Preserve unrelated models and engines.
The setup adds no service, startup task or automatic update.

The reviewed Python client and dashboard are included in this integration.
Their pairing and private-storage qualification uses disposable local fixtures.
Packaged pairing, hosted migration and production enrollment are not qualified.

## Test map

`website/tests/pairing.test.mjs` (23 tests): mint auth/CSRF/key-denial, code
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
The Python core, dependency pins, licenses and notices remain unchanged.
The reviewed pairing client is added separately from the packaged local daemon.

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


Latest Muse W2 head `f0e2bb1` is preserved in this candidate's ancestry. Its
uppercase code-entry fix and all five additional regressions are retained,
including the deterministic wrong-secret fixture. Overlapping rowid-based
rotation and separate mapping/audit writes are superseded by the reviewed atomic
operations here. The legacy five-minute NULL-claim grace is preserved.

Used pairing consent with a NULL resource binding fails closed. That ambiguous
legacy state can represent an interrupted old claim or an explicitly deleted
resource; owner/node identity alone cannot distinguish them. Automatically
adopting a replacement resource would revive deleted consent and rotate its new
sender. Mint a fresh owner-approved code instead: the atomic claim finds the
existing owner/node resource without duplicating it. Tests cover both legacy
recovery through fresh consent and deletion followed by same-node replacement.
This deliberately replaces the peer's unbound-consent adoption behavior.

Code minting commits its live-owner/cap/budget admission, verifier and audit in
one transaction. A failed audit cannot strand an undisclosed code or charge.
Concurrent same-code claims refresh authenticated consent for one bounded retry,
including an already-existing node, and revalidate the reclaim window and exact
owner/node/resource binding before the atomic effect.

Worker slice (muse/onboarding-w3-worker): local-worker/test_pairing.py
(unit and security tests, fake in-thread API; 3 POSIX-permission tests skip honestly
on Windows) and local-worker/test_pairing_e2e.py (6 cross-language
scenarios, real CLI against real worker.js over loopback): two-user
isolation, repeat startup + quota, reclaim + rotation, expired/replayed
codes, revocation, delete, disabled owner, stale strip.

Dashboard slice (muse/onboarding-w4-dashboard):
website/tests/ui-connect-card.test.mjs (18 tests, exact checked-in
client): pair mint/reveal/dismiss/re-mint with no clipboard write and no
new links, cap-failure retry, demo unavailability, stepper honesty,
resource link states (needs-link/linked/reachable/stale), manual form
under Advanced. `website/tests/ui-pairing-repair.test.mjs` adds 8 exact-client
VM regressions for late mint success/error after target changes, Done/tab/
logout/replacement fences, CSRF, clipboard exclusion, published sparse source
pin, anonymous/demo guards, escaped code display and explicit sender/revocation
instructions. Clearing a code invalidates pending mint work; it does not revoke
an already minted code, which remains subject to server expiry and limits.
## Current source reconciliation

The integrated candidate preserves the ancestry of Muse W2 round 5
(`8d6d174`). Its deleted-code and interrupted-claim findings are covered by
SQLite and native local D1 regressions. The atomic claim transaction commits
consumption, resource, key, binding, budget and audit together; it cannot
create a new consumption-only crash state. A spent code with a NULL binding
is ambiguous legacy state and remains invalid, including after deletion or
replacement of that node. The owner can mint a fresh code to recover an
existing node without duplication. We deliberately do not import the
alternative `claim_json` reconstruction or its `invalidated_at` migration:
those fields serve the superseded multi-transaction claim path. Fresh
consent also covers older NULL records with no trustworthy snapshot.

# Federation threat model (F0)

Assets: owner resources and provider credentials; grant/approval records;
reservations and usage ledger; audit trail; peer credential verifiers;
invitation tokens; user sessions.

## Trust boundaries

1. Browser ↔ Worker: session cookie + CSRF; no secrets in DOM/storage
   after dismissal (covered by existing UI session tests; F1 extends to
   federation views).
2. Owner authority ↔ importer: peer key + audience; importer enforces
   local-consumer restrictions, disclosed as importer-side.
3. Owner authority ↔ worker/executor: fixture only in F1/F1P; real
   dispatch needs F2 contract + custody (out of scope here).
4. Operator ↔ D1: SQL only via reviewed migrations + operator scripts
   with shared, tested statements.

## Threats → controls → F1/F1P proof

- **BOLA / cross-tenant IDs** (every object, nested lookup, export):
  authorize each reference; tenant/audience checks in every handler.
  Proof: A14-style negatives for all new entities.
- **SSRF (pairing/metadata/callbacks/endpoints):** F1 has no outbound
  fetch (fixture transport); provider endpoints in F1P come from an
  allowlisted static config, never peer/user URLs; arbitrary-URL
  connectors explicitly out of scope. Proof: config-driven-only test,
  SSRF rejection tests around any URL-accepting field (must reject).
- **Replay (invitation/approval/operation):** single-use verifiers,
  atomic redeem, idempotency keys bound to actor+payload, revision
  vectors. Proof: A08/A12-style race tests.
- **Confused deputy:** peer identity + consumer attribution + grant
  witness carried through every hop; gateway cannot upgrade narrow
  requests. Proof: attribution-spoof tests (A19-style).
- **Credential exposure:** invitation tokens stored as verifiers;
  provider secrets never in F1/F1P local (fixtures only); masked
  metadata; no secret logging (existing no-secret tests extended).
- **Stale approval / TOCTOU:** approval binds preview hash + revisions;
  commit revalidates atomically; PREVIEW_STALE/412 on drift. Proof:
  A04-style tests.
- **Quota oversubscription:** conditional-write admission (see F0
  architecture §1); ceilings never exceeded; compensating release on
  partial holds. Proof: concurrent reservation tests (A07-style, F1P).
- **Untrusted content/compute:** peer metadata/errors/outputs are data;
  destination owner may observe inputs/outputs (disclosed in preview).
  Proof: injection tests (A19-style); preview renders route/retention.
- **Lease/partition abuse:** F1/F1P have no execution leases (no
  dispatch); 30s bound applies at F2 with verified worker semantics.
  No sooner claimed.

## Residual risks (accepted into F1, not silent)

- Malicious authorized peer can copy received output (controlled-
  boundary limit; contained by narrow grants + quotas + revocation).
- D1 batch gives rollback-on-error, not branching: partial-hold window
  handled by compensation, with transient under-admission possible.
- Single-implementation JCS-subset digest (interop deferred, explicit).
- No independent review yet (requested via pushed branch; Goose).

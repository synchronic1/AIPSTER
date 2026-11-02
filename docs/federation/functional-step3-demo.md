# Federation functional lane — milestone 2: visible synthetic demo

Base: `f9960fa` (APPROVED, 49/49). Demo test: 3/3 pass first run
(`website/tests/fabric-functional-demo.test.mjs`).

## What was built (new files only, no shared-file edits)

- `website/demo/federation-two-user/run.mjs` — runs the REAL reviewed
  fabric handlers in-process (real worker module, `FEDERATION_ENABLED=1`,
  sqlite shim, in-process Request dispatch) with synthetic alice/bob/demo
  fixtures; returns a labeled JSON report.
- `website/demo/federation-two-user/render.mjs` — pure-string static HTML
  renderer (no DOM, no network, no `<script>`).
- `website/tests/fabric-functional-demo.test.mjs` — asserts synthetic
  labels, honest non-live reasons, no-network transport, no live claims,
  and that rendered outcomes equal handler results.

## Rendered outcomes (all SYNTHETIC/FIXTURE-labeled)

Per-user fabric views, redacted peer node (no secret leak, stranger 404),
invitations + connection, grant visibility incoming/outgoing (third-party
404), discovery via grant, authz allow/deny, per-owner quota exhaustion
(429, bob unaffected), revocation effect (deny + discovery drop), audit
rows present. `NOT SHOWN LIVE` panel gives reasons (no network/peers,
fixture identities, F1/F1P held + inference disabled) and live-test
prerequisites (real identities, networked peers, non-prod backend + flags,
browser pass). No browser launched.

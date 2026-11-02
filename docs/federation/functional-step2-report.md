# Federation functional lane — steps 2+3: two-identity acceptance + defect report

Worktree: `muse/federation-functional-20261102`, HEAD `ffd96fd`. Date (UTC): 2026-11-02.
Step-1 baseline (44/44 pass, unmodified) recorded in `functional-step1-baseline.md` and unchanged.

## New acceptance: `website/tests/fabric-functional-two-user.test.mjs` — 5/5 pass

Synthetic identities (`u_alice`/`u_bob`/`u_demo`) through the current real
handlers (`FEDERATION_ENABLED=1`, sqlite shim). Result: **5 tests, 5 pass, 0 fail.**

| # | Acceptance | Result |
|---|---|---|
| 1 | Per-user fabrics isolated (`listNodes` owner-scoped); peers see a redacted node view (`mine:false`, no `node_secret_verifier`/`node_secret_salt`); strangers (demo) get 404; invitations incoming-scoped; connection visible to both parties, 404 for demo | pass |
| 2 | Grant visible incoming (bob) / outgoing (alice), 404 for demo; bob discovers `r_gpu1` via `grant`; authz preview `allow` for granted consumer, `deny` for ungranted consumer | pass |
| 3 | Per-owner write quota: budget pre-set to 119 → 1 mutation 201, next 429; bob unaffected | pass |
| 4 | Revoke → authz preview flips to `deny`, resource drops from discovery; `fabric_operation_admissions` holds audit rows for nodes/invitations/previews/approvals/grants with `actor_kind='session'` | pass |
| 5 | Bob cannot revoke alice's grant (403/404) nor preview alice's resource (4xx); suspend gates enforcement to `deny` | pass |

## Failing-first correction (test bug, NOT a source defect)

First draft asserted bob `GET` alice's node → 404; handler returned 200.
Code read (`getNode` in `website/src/fabric/store.mjs`) shows this is intended:
active-connection peers receive a redacted view (id/label/fingerprint/transport/status,
`mine:false`), secrets stripped. Test corrected to assert that contract plus
stranger-404. Verified: no secret fields leak in the peer view.

## Defect report: no source defects reproduced

Across per-user isolation, invites/connections, grant visibility, discovery,
routing eligibility, quota, revocation, suspend-gating, cross-user rejection
and audit rows, every behavior matched the intended contract. **Zero
`website/src/fabric/*` fixes made** — correct per the no-fix-before-repro rule.

## Open risks carried forward (not re-proven in this lane)

- No browser UI pass (slot held by DGM QA; no browser launched).
- MCP JSON envelope only; no execution/network peers, no quota spending.
- D1 concurrent-accept single-statement UPDATE path untested here.
- Delegate claims parsed but no issuance path.
- This is synthetic-identity, single-process evidence — NOT a live two-user sharing claim.

## Files changed (lane-owned only)

- `website/tests/fabric-functional-two-user.test.mjs` (new, 5 tests)
- `docs/federation/functional-step1-baseline.md` (new)
- `docs/federation/functional-step2-report.md` (this file)

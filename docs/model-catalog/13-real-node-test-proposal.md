# Model catalog — real-node test proposal (NOT executed)

<!-- Built with Meta Muse. -->

This is a gated qualification plan. Nothing here has run: no real
weights were loaded, no paid inference executed, no credentials
enrolled, no infrastructure provisioned. Every section below requiring
owner approval is unchecked and stays that way until explicitly granted.

## Objective

Qualify ONE real node and ONE real runtime for catalog deployment, and
confront the fixture-proven control plane with reality: estimator
accuracy, compat decisions vs actual load outcomes, reservation
behavior under real memory pressure, and the worker lifecycle
transport that does not exist yet.

## Prerequisites (all blocked)

- [ ] A real worker lifecycle transport: download/verify/load/unload/
  cancel/report protocol design, implementation, and security review
  (see `local-worker/EXECUTION-GAPS.md`). This is the critical path;
  without it, live dispatch stays honestly refused.
- [ ] A real runtime adapter behind the estimator matrix (the
  `fixture-llama` row is synthetic; a llama.cpp-class worker is the
  expected first candidate). Owner selects and qualifies it.
- [ ] R2 bucket + `CATALOG_STORE` binding in a NON-PROD environment,
  with a test prefix and lifecycle rule. Prod stays unprovisioned
  (chunk routes 503 by design) until a separate rollout decision.
- [ ] Test weights: one small public GGUF (license-clear, < 1 GB),
  pinned by digest; no gated weights until the manual-grant flow is
  owner-operated.
- [ ] Isolated test node + test account; no access to Peter's
  inventory, provider credentials, or prod tenants.
- [ ] Credentials (if any) enrolled via approved channels only; none in
  repo, logs, or prompts.

## Test matrix (maps to AC14–AC21)

1. Telemetry: real heartbeats drive compat; stale/missing telemetry
   blocks planning (AC07/AC14 counterparts).
2. Plan/execute: real load to ready; event trail matches observed
   worker states; idempotent re-execute replays (AC14).
3. Estimator check: predicted total vs measured peak RSS/VRAM; record
   the error, tighten method/uncertainty (feeds AC05).
4. Restart: kill the worker mid-load; job resumes by op id without
   duplicate work (AC15).
5. Reconnect gap: drop worker comms; unknown → reconcile → advance or
   honest `RECONCILE_LOST` (AC16).
6. Cancel/timeout/partial: operator cancel, injected stage timeout,
   induced load failure; each releases with cleanup notes (AC17).
7. Exhaustion: two loads exceeding VRAM; second honestly 409s and the
   first stays healthy (AC18).
8. Gated: owner completes a real manual grant out-of-band; planning
   still refuses until the grant is represented (AC19).
9. Revocation: revoke the grant mid-load; job fails `REVOKED`, worker
   stops, no further admission (AC20).
10. Live dispatch: unscripted end-to-end success with zero fixture
    flags in the path (AC21 — the only test allowed to claim it).

## Safety and non-goals

- Local GPU only; zero paid inference, zero provider spend.
- Tiny weights; bounded context/concurrency; operator abort at any
  mismatch between predicted and observed memory.
- Abort criteria: any OOM of the host, any cross-tenant visibility,
  any credential appearing outside its vault, any spend.
- Cleanup afterwards: unload test weights, delete test assets and
  reservations, rotate test credentials, record receipts.
- Non-goals: prod migration, prod R2, multi-node, benchmarking,
  provider-backed inference, performance tuning.

## Entry / exit criteria

- Entry: all prerequisite boxes checked, independent review of this
  proposal, scheduled window with the rollout owner present.
- Exit: matrix fully executed with pass/fail evidence per row, or an
  abort report; estimator error recorded; follow-on issues filed for
  every divergence from fixture behavior.

## Sign-off

- Rollout owner: ______________ (approves prerequisites + window)
- Independent reviewer: ______________ (clears proposal + evidence)
- Executor: ______________ (runs the matrix, records receipts)

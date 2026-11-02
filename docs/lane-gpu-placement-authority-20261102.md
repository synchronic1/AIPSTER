# Lane registry: GPU placement authority

Lane: GPU placement authority for Mac inference client
Date: 2026-11-02
Branch: `ds/inference-integration-20261101`

## Decision

**OPEN — backend-owner decision required.** The Mac inference client lane
(`muse/mac-inference-client-20261102`, merged here) is accepted as CPU-only
Gate A/B preparation. It proves the contract, routes, admission, dispatch,
settlement and refusal behaviour offline; it does not, and cannot, select a
GPU on the current contract.

## Scope (NOT implemented)

A reviewed protocol revision replacing `aipster-bound-cpu-internal/1`:

- GPU placement authority: device capability selection
- Admission-time allowlist of selectable devices
- Coordinator binding of the selected device to the operation
- Worker and store fence update (today both reject `placement.device != cpu`)
- Contract-test update covering the new authority and fence

## Status

OPEN. Owner: backend owner. No code written. No dispatcher, contract or
worker change is staged by this entry; it records the lane and its decision
only.

## Evidence this lane inherits

- `docs/mac-real-inference-client.md` §6 ("Exact live HOLD"): the CPU-only
  fence on both worker (`local-worker/inference_worker.py`) and store
  (`website/src/inference/dispatch-store.mjs`), `placement` treated as
  `FORGED_CLIENT_AUTHORITY`, and no `--gpu`/`--device` CLI.
- `website/tests/mac-inference-client.test.mjs`: offline proof that a device
  or GPU selector is refused (`FORGED_CLIENT_AUTHORITY` / `UNSUPPORTED_FIELD`)
  and that the lease envelope stays `device=cpu`.

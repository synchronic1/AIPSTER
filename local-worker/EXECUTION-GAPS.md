# Installation is not execution qualification

The vendored worker is the public snapshot, not newer private EIF source. No
private histories or patches were accessed or copied for this PR. The comparison
is against public `dendrite/config.py`, `schemas.py`, `node.py`, `runtimes/llama.py`
and AIPSTER's [published contract](../docs/eif-atomic-admission-contract.md).

| Boundary | Public snapshot / outstanding work |
|---|---|
| Task admission | ExecuteRequest has no stable operation key or owner/workspace authority. AIPSTER still needs durable atomic budget reservation and admission. |
| Placement | No bound CPU node/runtime placement envelope. Capability matching is not authorization. |
| CPU confinement | Zero GPU layers is configurable, but no `cpu_only` opt-in, `--device none`, `--no-kv-offload`, or exclusion of ambient `LLAMA_ARG_*` values. Use a CPU-only engine build for standalone CPU preparation; do not advertise qualified AIPSTER CPU execution. |
| Retry / settlement | Worker request IDs are not a durable idempotent execution ledger. No worker-start redemption/settlement protocol is connected to AIPSTER. |
| Transport / tenant isolation | Patch 0002 reviews the opt-in outbound Ganglion fabric bridge: authenticated node socket, exact resident-model binding, resident-only capacity advertisement, job-id result binding and rejection handling. It remains disabled in the supplied examples and is still **not the AIPSTER transport**. AIPSTER has no node dispatch endpoint, `/api/jobs` stays `INFERENCE_DISABLED`, and a fabric socket does not establish AIPSTER tenant/grant authority. The fabric execute frame carries no tenant, grant, runtime ID or deadline; the worker trusts the authenticated socket and cannot re-verify AIPSTER authorization locally. |
| Result and revocation | No connected AIPSTER result authorization, admitted revision validation or revocation settlement. Ganglion fabric results are one non-streamed frame; the worker binds it to the dispatch job ID but keeps no durable execution ledger across reconnects. |
| Runtime evidence | Public code has some attach quarantine/model identity checks already. This PR does not assert all such protections are missing, nor claim private fixes were independently verified. Native CPU ISA, RAM/context fit and exact model digest qualification remain future work. |

Unknown fields are rejected by the strict public schemas. Do not remove placement
fields to make newer tasks pass, downgrade to unbound retries or enable jobs on the
strength of these installation tests. Authentication, tenancy, budgets, placement
and F1/F1P holds are unchanged. `/api/jobs` still returns `INFERENCE_DISABLED`.

## Ganglion contract limits recorded for local patch 0002

The reviewed node contract is the Ganglion fabric v0.2.0 node socket described by
its public manifest and node contract (reviewed 2026-11-01; the deployed fabric
was not connected or exercised by this change): `GET /v1/nodes/connect?node_id=…`
with a node-role token bound to that ID, one immediate and then periodic
heartbeat, `execute` down the same socket, and exactly one terminal `result`
frame. It has **no streaming, no cancel frame and no deadline field**. The
contract assigns a 180 s deadline at admission and discards a result that arrives
at or after it; the worker can only enforce its own `request_timeout_seconds`.
Disconnect is the only remote cancellation signal, so an in-flight attached
request is quarantined as an uncertain outcome. These are contract gaps for the
fabric owner, not fields this worker may invent.

Resident-only is deliberate: the worker advertises non-resident models as
unavailable and advertises no model switching. A fabric request for any other
model, or for a resident model whose file identity changed, is rejected with 409
before a load or switch; make it resident through the local API first. Chat
(`messages`) is not advertised and a forced frame is rejected as an invalid
request; `probe_chat` is answered with a normal heartbeat. A durable
cross-reconnect execution ledger and AIPSTER admission/settlement remain absent.

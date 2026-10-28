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
| Transport / tenant isolation | Optional legacy fabric bridge is included only to satisfy package imports. It is disabled in examples and is not the reviewed AIPSTER transport. Local bearer checks do not establish AIPSTER tenant/grant authority. |
| Result and revocation | No connected AIPSTER result authorization, admitted revision validation or revocation settlement. |
| Runtime evidence | Public code has some attach quarantine/model identity checks already. This PR does not assert all such protections are missing, nor claim private fixes were independently verified. Native CPU ISA, RAM/context fit and exact model digest qualification remain future work. |

Unknown fields are rejected by the strict public schemas. Do not remove placement
fields to make newer tasks pass, downgrade to unbound retries or enable jobs on the
strength of these installation tests. Authentication, tenancy, budgets, placement
and F1/F1P holds are unchanged. `/api/jobs` still returns `INFERENCE_DISABLED`.

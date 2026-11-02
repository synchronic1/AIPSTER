# Installation is not execution qualification

The vendored worker is the public snapshot, not newer private EIF source. No
private histories or patches were accessed or copied for this PR. Local patch
0002 is an original change implementing the documented Ganglion v0.2.0 node
socket. It was checked offline against the Ganglion reference snapshot sanitizer
and scheduler; the deployed fabric was not connected or exercised. The
comparison is against public `dendrite/config.py`, `schemas.py`, `node.py`,
`runtimes/llama.py` and AIPSTER's [published contract](../docs/eif-atomic-admission-contract.md).

## What the job runner connects (2026-11-01)

`inference_worker.py` now implements the worker half of the admitted-dispatch
path: one leased job at a time from the worker job route, a strict nested
bound-CPU envelope check (`{protocol, task, binding}`, canonical worker wire
shapes), exactly one non-streaming Ganglion completion, and an EIF-shaped
result bound to the lease. It reuses the stored heartbeat key and touches
neither the running port-8090 worker nor its enrollment.

Real in this tree and unit-tested against fake loopback servers:

- Lease polling with the heartbeat-scoped key, product User-Agent, 204 idle
  backoff, `Retry-After` handling and the repair-required exit on a revoked key.
- Strict envelope validation of the nested coordinator envelope: exact
  `aipster-bound-cpu-internal/1` protocol, capability, CPU placement bound to
  this resource, runtime equal to the configured `--runtime-id` (`ganglion`
  or `llama-server`), model, prompt, token ceiling, future deadline equal to
  the binding deadline, no simulation, exactly the five binding fields and no
  unknown top-level or task fields.
- Model gating against Ganglion `GET /v1/models` (briefly cached), one completion
  with `temperature: 0` and a deadline-bounded timeout, no redirects and no
  retries, and a stable `failed` reason for every failure path.
- Result shapes held to L2's validator: success is exactly the EIF key set with
  `runtime_instance`/`model_fingerprint` echoed from the binding; failure is
  exactly `{reason, detail?, elapsed_ms?, usage?, cache?}`.
- A private started-job ledger written before the completion call, so a crash
  between execution and posting never re-executes a job.
- Single-runner locking and secret-free logging (no key, token, prompt or
  completion text).

Still unavailable, unqualified or owned elsewhere:

| Boundary | State |
|---|---|
| Server job routes and store | The worker consumes `GET /api/worker/jobs/next` and `POST /api/worker/jobs/:job_id/result`; the L1 dispatch store and L2 routes are not in this tree, and both 404 unless `INFERENCE_ENABLED` is set. The route/lease/result **wire shapes used here are the dispatch lane's**, not a deployed contract. |
| Task admission | ExecuteRequest still has no stable operation key or owner/workspace authority in the public worker. Durable atomic budget reservation and admission remain AIPSTER-side and are not exercised here. |
| Placement | The runner enforces the `aipster-bound-cpu-internal/1` envelope's placement fields, but that binding is only as good as the issuing store; capability matching is still not authorization. |
| CPU confinement | Zero GPU layers is configurable, but the public worker still has no `cpu_only` opt-in, `--device none`, `--no-kv-offload`, or exclusion of ambient `LLAMA_ARG_*` values. Ganglion's own device placement was not audited or changed here. |
| Retry / settlement | The worker posts once and holds a local started-job ledger, but there is no connected server-side settlement or lease store in this tree, and no cross-process proof that a leased job cannot be handed out twice. |
| Transport / tenant isolation | Patch 0002 reviews the opt-in outbound Ganglion fabric bridge: authenticated node socket, exact resident-model binding, resident-only capacity advertisement, job-id result binding and rejection handling. It stays disabled in the supplied examples and is still **not the AIPSTER transport**. The L2 dispatch routes (`docs/inference-dispatch-routes.md`) are dark by default (`INFERENCE_ENABLED` unset), so `/api/jobs` keeps its `501 INFERENCE_DISABLED`, and a fabric socket does not establish AIPSTER tenant/grant authority. The fabric execute frame carries no tenant, grant, runtime ID or deadline; the worker trusts the authenticated socket and cannot re-verify AIPSTER authorization locally. |
| Result and revocation | The worker reports EIF-shaped results and stops on a revoked/expired key, but admitted-revision validation, grant revocation settlement and the content-release recheck belong to the coordinator lane. |
| Runtime evidence | Public code has some attach quarantine/model identity checks already. Native CPU ISA, RAM/context fit and exact model digest qualification remain future work. |

## Live qualification still pending

Nothing above was run against a live job route, a deployed store or a real
model. Ganglion was read once with `GET /v1/models` to learn its response shape;
no completion was posted, no model was loaded or unloaded, and no real inference
was performed. Before any qualification round:

- the L1 store and L2 routes must land and agree on the lease/result shapes.
  The runner now conforms to Addendum A's canonical shapes (nested envelope
  with the `binding`, echo of `runtime_instance`/`model_fingerprint`, exact
  success and failure key sets) and to L2's validator at `9f2fc29`, but no
  deployed route has ever produced one of these frames;
- a first live run should use a disposable test resource, a tiny `max_tokens`
  and a deadline long enough to observe one failed-and-one-succeeded result;
- Ganglion placement, model digest and context/RAM fit must be recorded for the
  exact model used, and the runner's loopback-only default must be kept.

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

# EIF / IK CPU integration boundary

Read-only source verification, 2026-10-27. This document preserves the existing
EIF reuse plan and the separate federation implementation. It does not enable
execution or replace either implementation.

## Answer and reviewed revisions

**The IK CPU executor exists in EIF. It is not connected to AIPSTER's job API
in either reviewed AIPSTER revision.** Current verification is source inspection
plus EIF offline fixtures; no AIPSTER-to-IK real-worker execution is qualified.

| Accessible source | Pinned revision | Relevant evidence |
| --- | --- | --- |
| AIPSTER main | 5f4dfb04b140ca414a81973713e12be5a154910d | Job dispatch is disabled; existing EIF handoff plan and guard test. |
| AIPSTER muse/federation-control-plane | 53f9e10cb3edfbe8ab10d4c8aa1b683f724c0c3a | F1R2 consent/grant repairs, fixture transport and discovery; job dispatch still disabled. |
| Public EIF source | 536508832b12d993dc272e03d4f09aca53801f68 | Existing Python worker, managed IK/llama runtime, local native process configuration. |

The public EIF mirror does not represent all later private restoration/test
work. The accompanying [public-safe runtime receipt](evidence/eif-test-runtime-20261027.json)
identifies the bounded test-tooling change by digest and records its results,
without publishing private history, source patches, credentials or endpoints.
Private commit/backup verification remains in the operator's private receipt.

The existing Muse branch was inspected read-only. Unpublished Windows-local
Muse code or a later branch head remains outside this snapshot. No federation,
release or UI file is changed by this documentation.

## Actual chain and the missing connection

Current main:

~~~text
AIPSTER POST /api/jobs
  -> inference authorization; session CSRF check
  -> 501 INFERENCE_DISABLED
  -> no job row, adapter selection, placement or native execution
~~~

The same stop remains on the reviewed Muse branch. Its FEDERATION_ENABLED=1
flag exposes federation control-plane routes; it does not enable inference.
Registered federation nodes use fixture-0 / fixture transport, and grant
previews use a fixture route. Consent, grant revisions and discovery are useful
control-plane work, not proof of a working worker transport.

The reusable EIF chain is separate:

~~~text
Authorized EIF task -> admission / one-runtime placement -> outbound node socket
  -> Python Node.execute -> managed ik_llama runtime
  -> operator-configured llama-server + GGUF model -> validated result
~~~

EIF's ik_llama runtime uses its LlamaRuntime adapter. Managed configuration
sets the executable/model path, CPU threads, context size, one parallel slot
and GPU layer count; gpu_layers=0 is an explicit CPU path. The IK fork is
ikawrakow/ik_llama.cpp. Neither an installed model file nor the existence of
this adapter joins it to AIPSTER automatically.

A direct trusted-worker route would instead call the qualified worker API and
bypass EIF placement. That is a separate contract: fabric task persistence,
ownership and idempotency must not be assumed for a direct call.

## Verification matrix

| Boundary | Implemented | Fixture-tested | Live-qualified | Missing / limit |
| --- | --- | --- | --- | --- |
| AIPSTER job submission | Authorization and deliberate 501 stop | Existing eif-guard test asserts 501 and zero job rows | No execution qualification | Execution adapter and durable external-task binding |
| AIPSTER resource cards | Configured/authenticated/online/usable distinctions | Existing application tests; not newly rerun locally here | No fresh worker proof | Declared capacity must not become inferred usable CPU capacity |
| Muse federation | Consent, grants, discovery, revision/idempotency repairs behind flag | F1R2 receipt reports 212 tests; historical owner run | Recorded workerd auth/health smoke only | Real peer/worker transport, execution admission/leases and output lifecycle |
| EIF CPU execution | Managed ik_llama / llama_cpp, native process parameters and GGUF availability checks | Restored worker's complete offline Python suite: 134 passed; protocol engines are fixtures | No new real model run; historical CPU reports are not this integration | Exact deployed worker/runtime/model qualification |
| EIF shared placement | Whole request to one eligible available runtime; no hidden queue | Fabric suite: 109 passed on Node 24.18.1 | No new production qualification | AIPSTER principal/grant mapping and placement confinement |
| AIPSTER -> EIF -> IK | Not connected in reviewed revisions | No end-to-end execution contract test to claim | No | Versioned authorized adapter handoff and a later bounded real-worker check |
| CPU memory/context admission | EIF has file/runtime availability, lane and output/context bounds | Existing boundary fixtures | No measured hardware fit | Full input+output token budget, KV/model memory, ISA/platform and shared-resource limits |

The local AIPSTER test attempt stopped at an offline dependency-cache miss for
locked zod@4.6.7. No substitute package/version was installed. Existing PR CI
remains the application-check authority for this documentation change; its
result is recorded in the PR rather than fabricated here. This does not
invalidate or independently reproduce the Muse receipt's historical counts.

## First-class CPU admission

No GPU must mean an explicit CPU eligibility decision, not rejection solely
for lacking a GPU and not automatic acceptance of arbitrary workloads.
Before real dispatch, the existing adapter/engine owners need to enforce:

- A registered, authorized CPU runtime for the requested capability/model;
  matching architecture/instruction support, model format and quantization.
- A model that fits memory with runtime overhead and KV/cache allowance;
  input tokens plus reserved output within the qualified context.
- Thread/process concurrency, occupied lanes, deadline and resource ceilings;
  stale, unknown, unavailable or insufficient capacity fails closed.
- Result correlation, simulated=false, native completion metadata and honest
  measured/unmeasured usage. A successful HTTP poll is not a successful answer.

The inspected code does not yet provide all of these admission guarantees.
Existing hardware/capability reports and the static model roster are inputs,
not proof of workload fit. Do not add a second scheduler to close this gap.

## Smallest reuse-based follow-up

1. Preserve the current disabled-dispatch guard and the
   [existing EIF handoff plan](cloudflare-integration-plan.md#10-bounded-eif-end-to-end-check-planned--blocked-no-live-endpoint).
2. Agree one versioned execution contract and custody mapping per mode:
   shared fabric delegates placement/reservation to EIF; direct trusted-worker
   execution binds an explicitly qualified target. Native engine owners retain
   model lifecycle/batching. Do not let two schedulers reserve the same job.
3. Reuse the existing adapter seam when its current source is available.
   Federation architecture refers to aipster-local/lib/adapters.mjs, but that
   source is not present in these reviewed repository snapshots. Record the
   missing source rather than inventing its behavior or rebuilding it here.
4. Bind the AIPSTER job to its external task ID, stable idempotency key,
   principal/resource authorization, execution mode and terminal provenance.
   An ambiguous submit must not trigger blind fallback or repeated compute.
   EIF's shared task API does not accept a specific node/runtime selector;
   resource-specific grants require a confined eligible pool or the qualified
   direct route.
5. Separately qualify an authorized idle CPU worker with exact software/model
   identities, admissible context/memory limits and complete native terminal
   metadata. Only then perform a separately authorized bounded real-worker
   check. This document grants no permission to load models or change services.

No new contract test is invented here: the existing job guard covers the
implemented behavior, while the execution adapter it would test is missing.

## Evidence links

- [Main job API](https://github.com/synchronic1/AIPSTER/blob/5f4dfb04b140ca414a81973713e12be5a154910d/website/src/worker.js#L369),
  [existing dispatch guard](https://github.com/synchronic1/AIPSTER/blob/5f4dfb04b140ca414a81973713e12be5a154910d/website/tests/eif-guard.test.mjs#L13),
  [resource cards](https://github.com/synchronic1/AIPSTER/blob/5f4dfb04b140ca414a81973713e12be5a154910d/website/src/lib/store.js#L36).
- [Muse job stop](https://github.com/synchronic1/AIPSTER/blob/53f9e10cb3edfbe8ab10d4c8aa1b683f724c0c3a/website/src/worker.js#L371),
  [flag/router](https://github.com/synchronic1/AIPSTER/blob/53f9e10cb3edfbe8ab10d4c8aa1b683f724c0c3a/website/src/fabric/router.mjs#L10),
  [fixture-only store](https://github.com/synchronic1/AIPSTER/blob/53f9e10cb3edfbe8ab10d4c8aa1b683f724c0c3a/website/src/fabric/store.mjs#L1).
- [F1 receipt](https://github.com/synchronic1/AIPSTER/blob/53f9e10cb3edfbe8ab10d4c8aa1b683f724c0c3a/docs/federation/F1-receipt.md),
  [F1R2 owner results and limits](https://github.com/synchronic1/AIPSTER/blob/53f9e10cb3edfbe8ab10d4c8aa1b683f724c0c3a/docs/federation/F1R2-fix-note.md),
  [adapter seam and architecture](https://github.com/synchronic1/AIPSTER/blob/53f9e10cb3edfbe8ab10d4c8aa1b683f724c0c3a/docs/federation/F0-architecture.md#L91).
- [Public EIF runtime configuration](https://github.com/synchronic1/elastic-inference-fabric/blob/536508832b12d993dc272e03d4f09aca53801f68/dendrite/config.py),
  [LlamaRuntime](https://github.com/synchronic1/elastic-inference-fabric/blob/536508832b12d993dc272e03d4f09aca53801f68/dendrite/runtimes/llama.py),
  [historical native build](https://github.com/synchronic1/elastic-inference-fabric/blob/536508832b12d993dc272e03d4f09aca53801f68/docs/node-runtime.md),
  [IK source at the documented build](https://github.com/ikawrakow/ik_llama.cpp/tree/3bb386eb68ffee0a5dc7db21da0735d594929eeb).

## Public-safe EIF test-runtime evidence

The EIF regression failed 56/57 on Node 25.6.1 and passed unchanged 57/57 on
24.18.1 with the same application dependencies. Node's pinned upstream source
shows [25.6.1 omitting the SQLite text byte length](https://github.com/nodejs/node/blob/v25.6.1/src/node_sqlite.cc#L97)
and [24.18.1 preserving it](https://github.com/nodejs/node/blob/v24.18.1/src/node_sqlite.cc#L121).
This explains a truncated embedded-NUL reservation key in the Node test host.
It is not evidence of a production Cloudflare scheduler failure.

The bounded EIF fix pins 24.18.1 (supported range >=24.18.1 <25), checks the
version and a real SQLite NUL round-trip before tests, and asserts admission
at the existing quarantine regression's intermediate step. No production
reservation format or inference behavior changed.

Afterward: focused Fabric 60/60, complete Fabric 109/109, complete Python
134/134, Ruff and TypeScript/Vite build passed. Node 25 intentionally fails
the preflight; it is not counted as a passing suite. Python is 3.12.13;
the complete version/command summary and change digest are in the linked
[receipt](evidence/eif-test-runtime-20261027.json). This runtime requirement
concerns EIF's test tooling; it does not change AIPSTER's runtime policy.

# One-request IK CPU qualification: pending

Dependent on [PR #7](https://github.com/synchronic1/AIPSTER/pull/7), commit
`3ed921e6956b27e3518a3b9fc753bfefa406cc13`. This PR's base is
`codex/eif-cpu-contract-20261028`; intended final target is `main` after the parent
is merged and this branch is retargeted/reviewed. It does not edit federation or
an active writer's branch.

**Live qualification is pending and blocked.** The parent implements a codec,
not a connected execution adapter. This follow-up supplies an offline packet
validator and a default-disabled readiness gate. Even explicit opt-in returns
`AIPSTER_EXECUTION_CONTRACT_MISSING`, zero requests. There is no live transport,
no credential reader, and no command that loads a model or dispatches inference.
It would be dishonest to implement a test that assumes a nonexistent AIPSTER
execution/result API or substitute direct EIF inference for the missing chain.

## Required chain and stop point

```text
AIPSTER authenticated POST /api/jobs -> 501 INFERENCE_DISABLED [current stop]

Required later:
AIPSTER auth + CSRF + atomic owner/resource/grant/budget admission
  -> owner-confined EIF task API (one stable operation key)
  -> authorized CPU worker -> existing IK llama adapter -> native model execution
  -> EIF terminal task -> AIPSTER durable result -> authenticated test caller
```

A future connecting PR must establish the parent's
[admission, placement and recovery contracts](eif-cpu-connection-prerequisites.md).
Before a real integration test is wired, its exact endpoint response, durable job
identity, authenticated polling, model/provenance and error semantics must be
reviewable in source. Mocked transport, model files, screenshots and a completed
packet cannot establish real IK execution. Approval of the packet cannot bypass
these dependencies.

## Offline commands and scope

```sh
cd website
node --test tests/ik-cpu-packet.test.mjs
npm test
npm run check
npm run build
WRANGLER_SEND_METRICS=false npm run bundle
```

Use the parent-supported Node 24 runtime; this work was tested on 24.18.1.
Default tests perform no inference or external execution. The packet test uses
synthetic local values and reuses the parent's actual request codec. It checks
missing revisions/authorization, stale/busy/unavailable capabilities, CPU-only
settings, RAM/context/output/CPU budgets, duplicate requests and retries. These
are packet-consistency checks, not verification of the truth of worker claims.

`qualificationReadiness()` returns disabled without even reading a packet.
Calling it with `{optIn: true, packet, now}` validates the packet but remains
blocked. It exposes no transport injection or environment bypass. A separate
reviewed implementation is necessary to replace this gate with an opt-in real
test after the missing server contract exists; no live test is claimed here.

## Exact proposed one-request packet

The request is fixed: raw completion, prompt `Reply with exactly: hello`,
temperature 0, output 64 tokens, `allow_simulated: false`, one operation key,
one request, zero automatic retries and no paid compute. Intended local limits:
CPU only, GPU layers 0, at most four threads, one slot, context 2048, at most
180 seconds wall time, at most 720 thread-seconds reserved. These are proposed
ceilings; they must be enforced by the server/worker, not merely entered here.
The 720 value is a conservative reservation ceiling, not measured CPU usage.

Before requesting approval, record the following privately with exact values:

| Packet field | Required evidence; unknown means stop |
| --- | --- |
| `adapterRevision`, `workerRevision`, `engineRevision` | Full 40-character Git revisions and evidence they match the actual authorized running chain; a checkout alone is insufficient |
| `resourceId`, `workerId`, `runtimeId`, `modelId` | Authenticated principal-to-resource mapping and pre-dispatch confinement to this CPU worker/runtime/model |
| `modelSha256` | SHA-256 of the already available, qualified GGUF; format/quantization and CPU ISA compatibility verified against the engine build |
| `authorizationReceipt` | Current owner/tenant/grant revision, revocation check and atomic budget/slot reservation; a string is only a reference to evidence |
| `observedAtMs`, `healthy`, `modelAvailable`, `idle` | Authorized capability/health observation no older than 60 seconds when admission occurs; no assumed historical health |
| `availableRamBytes`, `modelRuntimeKvBytes`, `headroomBytes` | Measured available RAM and qualified model+runtime+KV reservation plus positive operator headroom; model file size is not memory demand |
| `inputTokens`, `contextTokens`, `outputTokens` | Exact engine-tokenizer count including any prefix/template; input + 64 <= 2048 |
| `threads`, `concurrency`, `gpuLayers`, `device` | CPU, GPU layers 0, threads <=4, concurrency 1, enforced limits |
| `timeoutMs`, `cpuSecondsBudget` | Wall timeout <=180000 ms, CPU reservation sufficient for threads times wall duration and <=720 thread-seconds |
| `operationKey`, `requestCount`, `automaticRetries`, `paidCompute` | Persisted unique operation key, 1 request, 0 retries, false |

Do not commit a filled private packet, worker addresses, credentials, filesystem
paths or private source revisions. The public PR deliberately contains no filled
machine packet. The current adapter dependency is known; current deployed
worker/engine revision, model digest, RAM fit and admission evidence are not yet
qualified. Therefore no exact executable approval packet can be completed yet.
The operator receipt accompanying this work records historical identities
privately, with unknown fields called out rather than fabricated.

## Future opt-in test and approval procedure

1. Land/review the missing contracts and real adapter in their owners' branches.
   Reuse the existing EIF/IK engine; do not add a harness scheduler or bypass
   AIPSTER's authenticated endpoint. Freeze exact revisions and resource/model.
2. Fill the private packet with fresh evidence. Verify model is already resident
   or available under the separately approved operating policy. This instruction
   does not authorize startup, model load/download or a service restart.
3. Obtain separate explicit approval for that exact packet and one request.
   Keep EIF worker credentials server-side. The future test caller uses an
   authorized AIPSTER test principal, never a worker credential or endpoint from
   browser input. Use a trusted configured application origin, redact request
   headers, prompts/results as appropriate, and do not log credentials.
4. Invoke only the reviewed opt-in real test. It must submit once to AIPSTER,
   persist the stable operation/task IDs, and poll within the bounded deadline.
   No retry/fallback compute after uncertain submission. Polling must use the
   same principal and cannot create a new task. No real invocation exists yet.
5. Require terminal nonempty text (expected `hello`), native completion metadata,
   matching task/worker/runtime/model and model digest, `simulated=false`, no
   truncation, actual elapsed/usage where supported, and the source revisions.
   Correlate server/worker receipts to the same operation. A claimed provenance
   field alone is not proof that the model computed the answer.

## Failure, cleanup and receipt

Stop before submission for unknown/changed revision, identity, grant, model,
RAM, token budget, resource limit, stale health, busy worker or missing approval.
After submission, malformed/error output, wrong provenance, simulation, empty
or truncated content and deadline expiry fail qualification. Do not report
success merely because HTTP succeeded.

On local timeout/cancellation, stop polling and close test-owned client handles.
Record an uncertain remote outcome; do not claim remote execution stopped,
release its reservation as idle, retry with another key or terminate a shared
worker. Reconciliation must use the same durable operation after the real
contract is available. Do not delete task/audit evidence. Budget/lease settlement
belongs to the authoritative server contract, not harness cleanup.

The eventual receipt must say whether compute actually ran, record exact source
and model identities, the one operation/task ID, measured limits/usage and
result/provenance, redacted errors and cleanup/reconciliation state. Until that
separately authorized test passes: **implemented packet checks; offline fixtures
passed; real transport absent; live IK qualification pending**.

Rollback: revert this follow-up commit. No runtime configuration, schema,
credentials or deployment changes exist.

# EIF CPU connection: prerequisite implementation

Snapshot: 2026-10-28. Base: `71fa9aaf52e1bf45ecb2d11046e093286c86c4cc`.

**Execution is not connected.** This implements the safe prerequisite part of the
requested connection. The missing admission and placement contracts below block
an executable transport. The existing authenticated `/api/jobs` handler still
returns `501 INFERENCE_DISABLED`; no setting in this change enables it.
`EIF_CPU_ENABLED` and `EIF_CPU_TOKEN` in tests are deliberately ignored fixture
settings, not supported deployment configuration.

## One intended path

```text
Authenticated AIPSTER job endpoint (currently stops here)
  -> atomic owner/resource/grant/budget admission [missing]
  -> durable owner-scoped operation/task binding [missing]
  -> EIF task API, within an enforced eligible CPU resource pool [missing confinement]
  -> existing EIF placement/reservation and outbound worker connection
  -> existing Python worker -> existing ik_llama adapter -> local native engine
  -> EIF terminal task poll -> AIPSTER result/provenance
```

Choose EIF's owner-scoped task API, preserving its placement, reservation and
idempotency machinery. AIPSTER authorizes and accounts; EIF alone owns machine
placement. A direct worker call is not a substitute: it would bypass the task
ledger and require a different connectivity, authorization and recovery contract.
No scheduler, engine, model lifecycle manager or direct-worker fallback is added.

The inspected task parser accepts capability, model, prompt/messages, output
limit, temperature, simulation policy and idempotency key. It has **no node or
runtime selector**. A model ID alone does not bind a task to an authorized CPU
resource. Checking the chosen worker in a result cannot undo unauthorized
execution. Before dispatch, either an enforced owner pool must contain only the
explicitly admitted resource, or EIF must provide a reviewed resource-confinement
contract. A browser assertion or configured hostname is insufficient.

## Concrete changes and verification level

| Boundary | Implemented / independently tested here | Still missing / live qualification |
| --- | --- | --- |
| Job endpoint | Existing auth/CSRF and unconditional 501; guard asserts no job rows and zero fetches even with attempted activation, invalid claims and duplicate submissions | No execution; no live IK result |
| EIF request codec | `encodeCpuTask`: bounded raw completion, exact model, stable operation key, temperature zero, `allow_simulated: false` | It validates wire shape, not model availability, memory fit, token count, budget or CPU eligibility |
| EIF result codec | `decodeCpuTask`: task/worker/runtime/model correlation, nonempty terminal content, real-only and non-truncated metadata, bounded envelope; no private diagnostics reflected | Envelope fixtures are not an engine or authenticated transport test; expected identities must come from durable admitted state |
| Uncertain transport outcomes | Timeout, local cancellation and connection loss classify as uncertain; no automatic retry or assertion of remote stop | No HTTP client, polling loop or cancellation endpoint is implemented |
| Tenant/resource/revocation/budget | Unsafe submissions stay disabled | Individual live admission decisions and races cannot be tested before the atomic contract exists |
| CPU context/RAM/concurrency | No inference accepted | Fresh attested capability, tokenizer-aware context, memory/KV reserve, thread/slot and budget reservation required |

The new module is server-side protocol preparation and is not imported by the
worker or browser. It has no network access or credentials. This is deliberately
less than an execution adapter. The request's 4096 output ceiling is a protocol
ceiling, not permission to exceed a worker's smaller context. Result metadata is
not cryptographic attestation. Usage/cache objects are not billing evidence.

## Prerequisites and acceptance tests for the connecting change

1. **Execution authority, atomically consumed:** reuse the application identity,
   resource ownership and federation grant revisions. Bind principal, tenant,
   resource, model, grant/version, budget reservation and operation key in one
   durable admission transition. Revocation/version change before dispatch must
   prevent execution; failed admission creates no external task. Concurrent
   submissions cannot overspend a budget or consume the same slot twice.
2. **CPU confinement before dispatch:** server-held credentials map the admitted
   principal to the correct EIF owner/pool and explicit CPU resource. Reject
   wrong owner/resource, stale heartbeat, unavailable model/runtime, unknown
   capability and a pool containing any unauthorized candidate. Do not accept
   arbitrary caller endpoints or distribute a shared privileged credential to
   tenants. Keep credentials in server secrets and redact logs.
3. **Resource fit:** qualify model digest/format/quantization and CPU ISA;
   count input plus reserved output with the engine's tokenizer; reserve model,
   runtime and KV memory plus operator headroom from measured available RAM.
   Enforce context, threads, one execution slot, time and cost/usage limits.
   Missing GPU should take this explicit CPU admission path, never unconditional
   acceptance. No measured fit means no dispatch.
4. **Durable lifecycle:** persist normalized request hash and external task ID
   under the same owner-scoped key before acknowledging acceptance. EIF's
   inspected task retention is finite (24 hours); idempotency is not permanent
   exactly-once execution. Unknown submit outcome stays uncertain: no new key,
   no fallback worker, no blind retry after retention. Define reconciliation and
   terminal budget settlement before implementing transport retries.
5. **Real transport tests:** exercise the actual adapter with controlled HTTP
   fixtures for success, malformed/error response, timeout, abort, reconnect,
   polling authorization and ambiguous submit. Reject wrong expected identities
   from persisted state. Then separately qualify one real worker request.

Current main has resource declarations, not this atomic execution grant/budget
transition. [PR #6](https://github.com/synchronic1/AIPSTER/pull/6) was open at
`2ceafd2dbbc8b68c4d2aefef34174e877680a206` with unresolved state-transition review
findings when inspected. It is not treated as cleared or modified here.
The previously described `aipster-local/lib/adapters.mjs` is absent from the
accessible main; no missing implementation was guessed or duplicated.

## Result, streaming, cancellation and configuration limits

The selected fabric contract delivers a persisted terminal result via polling;
this module handles assembled text, not an OpenAI streaming/tool-call API.
No remote cancellation guarantee is established. A timeout, `expired` task or
local abort does not prove native compute stopped; a reservation must not be
released merely because the caller stopped waiting. A failed/expired poll is
never converted into success. Future transport must bound response bytes while
reading, before JSON parsing; the codec's size check alone cannot bound network
or parser memory.

There is no activation recipe in this PR. Invalid/missing configuration and all
attempts to enable execution remain inert because no execution route is wired.
Reverting these new files and the added guard test rolls back the prerequisite
work; there are no schema, credential, deployment or worker changes to reverse.

## Offline evidence and supported runtime

On macOS arm64 with Node `24.18.1`, locked website dependencies installed only in
the isolated worktree using `npm ci --ignore-scripts --no-audit --no-fund`:

```sh
cd website
npm test
npm run check
npm run build
WRANGLER_SEND_METRICS=false npm run bundle
```

All application tests, integrity check, asset build and local Wrangler dry-run
passed. No live verification script was invoked. The added test fixtures do not
perform inference. EIF's relevant task/domain/runtime tests also passed on
24.18.1; the existing [runtime receipt](evidence/eif-test-runtime-20261027.json)
records the full previous 109 Fabric / 134 Python regression and the Node 25
SQLite harness incompatibility. No EIF source changes are required by this PR.

The original [CPU boundary review](eif-ik-cpu-boundary.md) remains a dated source
snapshot, including its then-unavailable AIPSTER local test run. This newer run
supersedes that test availability limitation, not its live-execution caveat.

Public interfaces are independently represented here; private EIF source,
history, endpoints, credentials and operator machine details are not included.
See the original review for pinned public EIF runtime/source references.

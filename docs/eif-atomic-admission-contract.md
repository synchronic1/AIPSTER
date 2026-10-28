# CPU confinement milestone and atomic-admission handoff

This follows #7 and #8. Current main remains
`71fa9aaf52e1bf45ecb2d11046e093286c86c4cc`. #7 is
`3ed921e6956b27e3518a3b9fc753bfefa406cc13`. #8 now includes the complete-CI
trigger repair at `1a491500f757e8ea139e219fe422b7a91760a5df`, on top of its
original packet implementation `ac914a446bf03899cfa67f324a2fc3bbca237e9b`.
This branch depends on that updated #8 head. Final target is main after the
parents are reviewed/merged and this PR is retargeted; no merge is requested.

**Implemented:** bound CPU wire encoding, fail-closed application checks, and a
separate private EIF implementation that carries and enforces the target at the
worker/runtime. **Not implemented:** AIPSTER atomic execution admission, budget
reservations or a connected transport. `/api/jobs` remains unconditionally 501;
there is no flag that enables it. These omissions are blockers, not fixtures
being presented as execution.

## Coordination and existing state

[Coordination request to the federation writer](https://github.com/synchronic1/AIPSTER/pull/6#issuecomment-6473173802)
was posted before any shared-state edits. No shared-state edits were made.
At inspection #6 remains open at `2ceafd2dbbc8b68c4d2aefef34174e877680a206`;
its unresolved transition findings are not cleared by this work. No reply or
agreed execution-admission ownership was available at this milestone.

Reuse that branch's authority model, no-stitching grant matcher, retained
`idempotency_records`, attempt fencing and revision dependencies. Its F0 design
names operations/reservations/quota pools, but the reviewed migrations do NOT
implement reservation/quota-pool tables. `operations.mjs` supplies helper code,
not an execution reservation store. Main's `grants.used_jobs/used_tokens` and
resource `limits_json` are not an atomic reservation protocol. The source refers
to a local adapter seam absent from accessible main; it was not recreated.

The remaining schema and transitions belong to the federation/state-layer
owner. Do not import unresolved #6 source into this stack, reinterpret an
attribution-only consumer as authentication, or create a competing grant store.

## Implemented CPU restriction, and its trust boundary

The new `encodeBoundCpuTask(input, target)` reuses #7's real-only task codec and
adds the following interface. It is server-side preparation, not a dispatcher:

```json
{"placement":{"device":"cpu","node_id":"fixture-node","runtime_id":"fixture-runtime"}}
```

An explicit model and stable operation key remain required. The future caller
must obtain this target from durable admitted state, never from browser labels.
Unknown target fields, caller endpoints, invalid IDs and GPU requests fail.

The separately preserved EIF change implements:

1. Strict task/worker parsing of this binding; explicit model and no simulation.
2. Placement only on the exact fresh node/runtime/model, with advertised
   `cpu_only=true`, managed IK and real runtime. No alternate candidate fallback.
3. Binding included in the owner-scoped idempotency hash and outbound execution
   envelope. Same key with a changed target conflicts; replay does not redispatch.
4. Worker rejects a wrong node/runtime before attached-runtime observation, and
   rechecks model/runtime/configuration under the existing execution lane before
   any load/generation.
5. Operator opt-in `cpu_only=true` defaults false and requires managed ik_llama,
   GPU layers zero. Owned native command uses `--device none`,
   `--no-kv-offload` and `--n-gpu-layers 0`; ambient `LLAMA_ARG_*` overrides are
   excluded from that child's environment. Merely reporting a CPU label cannot
   select an attached/GPU/mock runtime in this implementation.

Native flag support was read in the pinned public IK source
[common/common.cpp at 3bb386e](https://github.com/ikawrakow/ik_llama.cpp/blob/3bb386eb68ffee0a5dc7db21da0735d594929eeb/common/common.cpp):
`parse_device_list`, the `--device` / `--no-kv-offload` parser and the
`offload_kqv` mapping. No native process or model was started to test these flags.
A trusted worker running the reviewed binary is still required: this is not
hardware attestation against a malicious worker. Model digest, RAM/KV fit, CPU
ISA and complete input/output context checks remain separate gates.

An old server/worker rejects the new field or cannot advertise the capability.
Do not strip the field or downgrade to an unbound retry. No operator configuration
or deployment was changed. The exact private commit/backup is recorded in the
operator receipt, not published in this repository. Private source is not copied
here; the [public-safe interface/test receipt](evidence/eif-cpu-confinement-20261028.json)
identifies the change by digest.

## Atomic admission contract for the existing state-layer owner

The following is a **required contract**, not a claim that code implements it.
No caller-supplied approval object, in-memory boolean or post-dispatch check may
satisfy it. Do not enable transport until its real store passes the tests below.

### Identity and immutable operation binding

Use the existing authenticated session/API principal and owner/workspace rules.
Bind operation identity `(actor_kind, actor_id, idempotency_key)` to method, path,
canonical body hash, exporter owner, recipient node/workspace, authenticated
consumer/delegation, resource ID/incarnation, grant ID/revision, connection
version/generation, model digest/format, CPU node/runtime identity, all quota
pool IDs and worst-case token/CPU/memory/slot reservations. One complete grant
must cover the entire operation. No stitching, owner shortcut or invented tenant.
All referenced authority/deny/disabled/revocation predicates are live database
predicates, not values trusted from a preview.

### Linearization point and budget ownership

The local admission linearization point must be the commit of a transaction
that BOTH admits this immutable operation AND owns its complete budget holds,
conditional on all live authority versions and ceilings. An operation is not
admitted merely because an idempotency row was claimed or one quota was held.

Use the existing planned reservation/pool contract, with schema agreed by its
owner. Every hold is unique to `(operation, pool)` and carries the operation
attempt/generation. A local D1 batch's successful execution is insufficient:
zero-row conditional writes do not abort it. The selected handoff is the existing F0 conditional-hold/commit approach:
its final admission CAS must require every exact operation-owned hold and
re-pin every live authority dependency in that same statement/transaction.
That successful CAS commit, not any preceding hold, is the linearization point.
Partial holds are pending, non-dispatchable, and compensated only by their exact
owner. This is atomic admission after conservative holds, not all-or-nothing
multi-pool acquisition. The concrete schema/CAS implementation still needs the
state-layer owner; it is not supplied by this document.

A losing competitor, failed attempt or replay cannot decrement another owner's
hold. Accounting cannot go negative; used plus held cannot exceed each ceiling.
A reservation charges the full admitted resource envelope, not guessed model
output. Missing price/budget semantics fail closed; slot exclusion is not budget
admission. Owner-only resources still need an explicit budget policy.

### Revocation and physical execution are separate boundaries

Before local admission commits, a concurrent revoke/version change must make
that admission fail. Before the worker is authorized to start, the same live
authority must be checked at a second **issuer-owned, one-time start redemption**
bound to this reservation, worker identity and generation. Redemption and revoke
must serialize in the SAME authority store: revoke first -> no start permit;
redemption first -> that already-start-authorized operation may proceed within
its admitted envelope. A later revoke blocks new redemption; it is not a promise
that existing native work instantly stops.

EIF's current execute socket does not implement this redemption. A future
reviewed protocol must authenticate that exact worker to the authority and make
permit consumption durable at both ends. A signed self-contained permit alone
cannot provide immediate revocation. The parent ledger's generic reclaim-and-
reexecute behavior must not be applied blindly to model compute.

No D1/EIF/native distributed transaction is claimed. A crash after authority
redemption but before acknowledgement is uncertain, potentially charged and
not retryable on a different key/worker. If exactly-once start cannot be proven,
prefer a retained uncertain hold over duplicate execution. An agreed bounded
permit lifetime does not establish that already-started work stopped.

### State, release and recovery

Required conceptual states: pending holds -> locally admitted -> start redeemed
-> terminal settled; any ambiguous dispatch/start/result moves to uncertain.
Denied/cancelled-before-start may release only with proof that no start redemption
can still succeed (fenced generation/tombstone). Terminal settlement must bind
the authoritative external task and worker result, with generation-fenced,
idempotent release/charge. Repeated settlement changes counters once. Budget
release and permission to reuse the native slot are separate decisions.

Timeout, local cancellation, expired task, socket loss and process restart do
NOT justify releasing a possibly running reservation or returning fake success.
Retain operation/request binding and uncertainty past the external EIF task's
finite retention window. No automatic resubmit, unbound fallback, new key or
lease takeover that can start duplicate compute. A transport retry may reconcile
read-only by the same identity only when the protocol supports it.

## Adversarial acceptance matrix

| Scenario | Existing evidence in this milestone | Required before connection |
| --- | --- | --- |
| Two requests exhaust one lane | Actual EIF handler and native worker lane fixtures reject second owner of slot | Atomic AIPSTER multi-budget exhaustion tests, including different operations and partial-hold faults |
| Same key, same/changed target | Actual EIF durable replay and target-hash conflict; no extra socket send | AIPSTER canonical request binding and crash/replay tests, not just codec equality |
| Wrong tenant/resource/model | Foreign EIF principal cannot read task; wrong bound model/target cannot dispatch; AIPSTER stays 501 | Real authority-store tests for foreign recipient/exporter/incarnation/model and no-stitching |
| Revoke during submit | Actual EIF handler rechecks revoked principal after asynchronous parsing/hash, sends nothing | Issuer revoke vs local admission and worker redemption in both commit orders |
| Missing/stale/unavailable CPU | Actual EIF parser, placement, worker and lane checks reject; native command checked | Fresh deployed capabilities, digest/ISA and measured RAM/context admission |
| Timeout/late result/cancellation | Existing EIF quarantine/replay tests retain uncertain lane; parent classifier forbids retry/remote-stop claim | AIPSTER settlement, reservation tombstone, generation fences and uncertain recovery |
| Default disabled | Actual AIPSTER concurrent submissions create no jobs and no network calls | Preserve this until every required live contract exists |

These are independently executed offline fixtures, not real IK qualification.
No fake admission store or parallel scheduler was added to make the matrix green.

## CI, rollback and one-request packet

#8 changes only the PR base filter of the existing complete check workflow.
All PR bases now run locked install, integrity check, complete tests, build and
local bundle. Pinned actions, read-only permissions, main push checks and branch
protections are unchanged. Retarget/reconcile in order #7 -> #8 -> this PR and
rerun full CI on each final combined head. No merge request/approval is implied.

Rollback: revert this public codec/test/docs milestone. The private CPU extension
is independently reversible and opt-in; no migration or service/configuration
change was made. The CI expansion should remain unless separately reviewed.

The [one-request runbook](ik-cpu-qualification-runbook.md) remains blocked. Proposed
packet: complete, `Reply with exactly: hello`, exact model digest, temperature 0,
64 output tokens, context 2048 with measured input+output fit, CPU-only <=4
threads, one slot, <=180 seconds, <=720 thread-seconds reserved, one persistent
operation key, zero retries and no paid compute. Add the explicit bound target
and the newly reviewed CPU-only worker revision. The current deployment revision,
model digest/RAM fit, issuer reservation/start-redemption contract and approval
are still missing; the exact runnable packet cannot truthfully be completed.
No live test, model load, service restart or activation is authorized here.

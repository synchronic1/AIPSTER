# Federation integration preparation, 2026-10-28

This isolated branch stacks on history repair PR #12 at
`fad6a26247bad5e525515d80caac615615c52eb8`, itself based on PR #6 at
`8a2233099a8f11a3a3d618e8481eaf05b5c80c96`. It incorporates published main
`6b74b9f6529da288378ca6284bffcbfc8d059379` without changing either author's branch.
It does not merge either PR or clear F1/F1P.

The two merge conflicts retain both intents: worker imports include federation
routing and signup quota helpers; the test schema includes main's write budget
and every federation migration. Main's application, disabled execution gates,
public worker packaging and Apache notices are preserved.

## Migration order

The previously applied main files 0001 through **0005_write_budget.sql** are
unchanged. Only the unapplied federation block is renumbered:

| Branch-local old file | Integration file |
|---|---|
| 0005_fabric.sql | 0006_fabric.sql |
| 0006_consent.sql | 0007_consent.sql |
| 0007_repair2.sql | 0008_repair2.sql |
| 0008_state_layer.sql | 0009_state_layer.sql |
| 0009_revision_receipts.sql | 0010_revision_receipts.sql |

All active test references use the new filenames. Older design/evidence
documents may retain historical numbering; this table governs this candidate.
The receipt migration has no inferred-history backfill. Existing missing or
corrupted historical snapshots require separate evidence-based assessment.

The local-D1 upgrade regression starts with main's five migrations, seeds a
synthetic identity and consumed write-budget row, then applies the federation
block. It verifies those rows remain unchanged, unique ordered migration
numbers, empty new receipt/failure tables and foreign-key integrity. Full D1
recovery tests also run against the complete integrated schema.

No production database was read or changed in this pass. Before any future
deployment, the release owner must separately inspect the actual migration
journal. Environments that already applied branch-local federation filenames
need an explicit migration plan; these renamed files must not be blindly
re-applied there. This candidate targets main's known schema lineage.

## Review and integration sequence

Review this preparation against #12, then integrate it into #12, #12 into Muse's
#6 branch, and finally review #6 against main at its resulting exact SHA. Each
merge is subject to Peter's explicit approval; do not force-push or overwrite
Muse's work. If either base advances, recompute the merge, preserve all new work,
and rerun exact-tree checks before claiming readiness. A supported GitHub merge
may create new commit IDs even when the reviewed tree is unchanged.

The original failure was reproduced on unmodified #6 source in SQLite and real
local D1: a failed history INSERT followed by retry recorded 50 as the old
1000-token ceiling. Both reproductions pass on #12. Its receipt/failure fencing
is retained without endpoint rewrites. Tests cover complete history content,
approval/operation identity, lost persistence responses, concurrent retries,
later revisions, expiry of processing leases, stale CAS, authorization and
revocation. The old regression suites are retained; signup tests from main are
included rather than replaced.

Green tests/CI establish the tested control-plane behavior, not whole-stage F1
clearance, runtime placement, atomic execution admission or a production rollout.
Inference stays disabled, F1P stays held, and no models or remote D1 are used.

## Public-signup federation admission repair

Security review of the initial combined candidate found that federation mutations
did not use main's 120/hour owner budget. The regression reproduced 121 successful
node registrations with no budget row. Both REST and MCP now call the same
durable admission through `checkIdempotency` before creating a new ledger record.
Admission and shared `write_budget` increment are one D1 batch, with live-actor,
hourly-cap and retained-operation predicates in the insert. Duplicate keys and
lost responses recover the original admission without another charge. Request
bindings cannot change. Existing completed/uncertain ledger operations retain
their recovery behavior. Non-idempotent deny deletion uses the shared budget
after ownership validation in both transports; nonexistent deletes are read-only.

New additive `0011_fabric_admission.sql` follows the reordered block. Admissions
are retained with the security evidence, never expired with processing leases or
replenished by object deletion. A per-owner ceiling of 10,000 admitted operations
(shared across session/key actors and transports) bounds new federation objects,
ledger records and associated audit/history growth. This is a retained-operation
ceiling, not an independent node/object limit and not a global anti-Sybil limit.
Already-existing pre-admission records are preserved, not silently backfilled or
deleted. Other application endpoints keep their existing caps and budget behavior.

At the retention ceiling, **new expansive mutations fail closed**; already-admitted
retries and bounded restrictive admissions remain available (see 0012 below). There is no automatic
quota reset, pruning or evidence-deleting recovery endpoint. An explicit operator
retention/archive policy is required before changing this ceiling or enabling
long-running production federation. Hourly limits count admitted mutations,
not individual SQL statements or reads. Internal store helpers are not public
RPC endpoints; public HTTP/MCP ingress supplies the admission boundary.

Tests cover the original 121st-request regression, shared REST/MCP budget,
concurrent distinct and duplicate admissions, lost responses, transactional
rollback, request mismatch, per-user isolation, retained-operation exhaustion,
reads/replay/guard behavior, and deny deletion. Actual concurrency is tested on
real local D1; the SQLite shim uses serial boundary checks because its nested
savepoint hooks do not model independent concurrent transactions.

## Restrictive actions at exhaustion (0012)

Review of `b1c3bef` found that the shared admission above also gated
security-reducing actions. With the hourly budget spent, REST grant revoke, MCP
`fabric.pause_grant` and REST connection suspend returned 429, and the grant
stayed `enforced`. At 10,000 retained admissions they returned 409 indefinitely.
Main's policy (`worker.js` auth budget, plan §5 "revocation exemption") keeps
revocation free at exhaustion, and main's `DELETE /api/grants/:id` returns 200
there. So the federation behaviour was an engineering defect, not a retention
policy choice.

The six restrictive actions are grant pause/revoke, connection
suspend/disconnect, and invitation decline/revoke, over REST and the matching
MCP tools. Each gets one uncharged, ceiling-exempt admission per (owner,
action, target, current version). A partial unique index in additive
`0012_fabric_restriction_admission.sql` enforces this across both transports.

### Durable restriction completion (0014)

`0014_fabric_restriction_receipts.sql` adds immutable operation outcomes for
grant pause/revoke, connection suspend/disconnect and invitation decline/revoke. Their guarded effect,
receipt and audit commit in one local D1 batch. A failed receipt or audit write
rolls the effect back; an unknown batch response is recovered from the matching
receipt before fresh version checks, even after another valid transition.
Zero-row mutation results also re-read the receipt before classifying the live
state, so an overlapping lease takeover preserves the original outcome.
Receipts bind actor, action, target and the complete request digest. They are
retained evidence and do not replenish admission capacity. Existing pre-repair
missing audit entries cannot be reconstructed automatically.

Migration 0013 is reserved for the separately reviewed heartbeat binding change
in the combined sprint. Integrators must preserve that migration and append
0014 after it; this focused federation branch intentionally has that gap.
The free insert is granted only when the store would accept the request: a
live non-demo owner who is the grant exporter, owns a connection side, or is
the invitation recipient/issuer; a target in an actionable state; and a current
`expectedVersion` where the store requires one. Another tenant's target, a
missing target and a stale request all take the unchanged charged path in the
same D1 batch, so they neither consume the slot nor reveal whether the target
exists (the response matches a missing target). Versions advance only through
an applied restriction or a charged resume/revision, so free admissions stay
bounded. Expansion is still blocked at both limits. No admission, ledger,
history or audit row is deleted, and the 10,000 ceiling is unchanged.

Still the operator's decision (not made here): a retention/archive policy for
admissions and ledger rows (STATE-LAYER D4), and what an owner at the ceiling
may do beyond restriction. Until that is decided, an owner at the ceiling can
restrict but cannot create, resume or revise.

Tests (`federation-restrictive-admission.test.mjs`): both exhaustion modes over
REST and MCP; uncharged first use; repeats and nonexistent targets charged;
replay and request binding; a single audit record; the live-owner requirement;
another tenant spending or probing the slot; a stale version keeping the slot;
and ten concurrent same-target admissions on real local D1, of which exactly one
is free and none is charged. On `b1c3bef` these fail with 429/409.

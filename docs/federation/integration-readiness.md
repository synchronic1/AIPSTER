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

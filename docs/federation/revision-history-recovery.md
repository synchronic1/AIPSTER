# Revision-history recovery repair

This is a focused repair stacked on PR #6 at
`8a2233099a8f11a3a3d618e8481eaf05b5c80c96`. F1/F1P remain held. It does not
enable inference, merge federation to main, or authorize deployment.

## Reproduced defect

`reviseGrant` claimed an approval, committed the grant update, and only then
inserted the superseded terms into `fabric_grant_revisions`. An interruption at
the history insert left the changed grant and spent approval persisted. Both
reconciliation branches reconstructed history from that current grant and
labelled it `version - 1`. Thus a revision from 1000 tokens to 50 recorded 50 as
the old revision's ceiling. A later pause or revision made the inferred version
or snapshot even less reliable. The old audit completion also used retry time
and could attach reconciliation to a different operation.

The original release-review probe is preserved as `release-history.test.mjs`.
`release-history-d1.test.mjs` reproduces the same interruption against real
local workerd D1. Both fail on the base commit on the 1000-versus-50 assertion,
and pass with this repair. The latter needs `revision-fixtures.mjs` copied beside
it when run on the base; no application code or baseline schema is changed.

## Invariant and write boundaries

1. Approval consumption remains the existing cross-action exclusive claim.
   There is no new authorization model or competing approval consumer.
2. The guarded grant CAS, immutable applied-operation receipt, and connection
   grant-generation increment execute in one D1 batch. The receipt insert
   immediately follows the CAS and uses SQLite `changes() = 1`; the generation
   increment likewise follows the insert. A zero-row CAS creates neither receipt
   nor generation increment. Receipt conflicts are SQL errors, never ignored.
   Fault tests on real D1 verify rollback of all three statements on SQL failure.
3. `fabric_revision_receipts` binds the stable actor/path/key operation digest,
   full canonical input digest, grant, approval, actor, before/after versions,
   complete grant row before/after JSON, approval provenance at consumption,
   and original application timestamp. Unique operation, approval and
   `(grant_id, before_version)` keys prevent reuse. No application UPDATE or
   DELETE path exists for receipts. They must be retained with operation/history
   records; they are not temporary processing leases.
4. History and audit remain idempotent post-commit completions. Their contents,
   identity and timestamp come exclusively from the applied receipt. History
   retains its existing top-level consumers/snapshot/ceilings shape and adds full
   before/after rows, operation identity and approval provenance. A conflicting
   existing history row produces an error; it is never overwritten or reported
   as a successful completion. Retry returns the original resulting revision,
   even if a later valid revision changed `last_approval_id` and current terms.
5. Replay still requires a human, live exporting owner and an accessible,
   non-quarantined, non-revoked grant. Different request data with the same
   operation is rejected. A different operation cannot reuse a spent approval.
   New effects retain the existing approval freshness, connection, snapshot,
   live-actor and version-CAS checks. Revocation is never reversed by recovery.

No interactive transaction or cross-request SQL connection is assumed. The
batch relies on [D1's documented transaction rollback on statement failure](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
The `changes()` chaining and zero-row behavior are verified on the actual local
binding, not inferred from the shim.

### Interrupted claims and processing-lease takeover

A consumed approval without an applied receipt is not evidence of success.
If it belongs to the same operation, reconciliation returns
`503 REVISION_UNCERTAIN`, preserving the router's uncertain operation state.
It does not retry the effect using a newly read snapshot. This matters when the
original attempt is still running after its processing lease expires: a newer
attempt must not finalize a terminal 409 before the original effect commits.
Once a receipt exists, the same operation reconciles normally. A claim that
committed but whose effect has no known outcome remains fail-closed.

On an effect-batch error, a conditional insert into `fabric_revision_failures`
fences the operation only if no applied receipt exists. The effect CAS checks
for this fence. These writes serialize: receipt first means the failure fence
is a no-op; fence first means even a delayed effect batch cannot apply. A
persisted fence gives the existing terminal 409/reapproval behavior. Failure
before the fence commits stays uncertain (503); a lost fence response resolves
from the persisted marker. Fences, like receipts, must not be expired with
processing leases. Fresh approval/operation handling must first resolve any
in-flight attempt. Other operations still receive 409 for a spent approval.

A known zero-row CAS also records its classified terminal status/body in the
failure fence before returning. If HTTP ledger finalization then fails, retry
recovers that original result (for example 412), rather than becoming permanently
uncertain. Failure records bind the original request digest. Independent review
found this edge on the first repair candidate; HTTP and both database engines
now cover it explicitly.

Direct store callers without `op` receive a random operation identity and
cannot reconcile by presenting the same approval alone. Retrying direct callers
must preserve `{key, path}`; processing attempt tokens may change. HTTP/MCP
already provide this stable context. No provenance is derived from an attempt
token or current mutable grant state.

### Upgrade and integration

Migration `0009_revision_receipts.sql` follows this branch's `0008_state_layer`.
It is additive and deliberately has no historical backfill. Pre-repair missing
before-images cannot be recovered from current rows; no receipt means no
invented historical recovery. Already corrupted records need a separate,
evidence-based administrative assessment, not automatic rewriting here.

Muse should integrate the repair branch into `muse/federation-control-plane`,
review conflicts in `reviseGrant`/`grantRevise`, and rerun all checks against the
exact integrated head. Production main already contains applied
`0005_write_budget.sql`; before eventual main integration, renumber the whole
unapplied federation block in order (including this receipt migration) and
update migration test lists. Do not rename the applied budget migration. This
repair does not change the public-signup branch or migrate any production DB.

## Test coverage and commands

`revision-recovery.test.mjs` runs the same matrix on SQLite and real local D1:
before/lost approval claim, before/lost batch response, before/lost history and
audit insert, SQL abort at effect/receipt/generation, repeated and concurrent
retries, claim-loser reconciliation, intervening valid revision, zero-row CAS,
actor/request/operation rejection, revoke finality, pre-receipt legacy state,
and processing-lease takeover while the original effect is still in flight.
It also covers failure before/after fence persistence and a delayed batch that
arrives after its error response and after the failure fence was written.
Tests compare complete before/after grant JSON, history payload, approval
binding, original timestamps, audits and generation counts.

`revision-router.test.mjs` exercises the real HTTP mutation wrapper at ledger
claim/finalization boundaries, before and after persistence. It covers lost
responses, lease expiry, completed replay, repeated replay and changed input.
Existing federation regressions are preserved unchanged.

The full suite contains 309 tests (260 existing plus 49 repair diagnostics,
including 22 new real local D1 cases).

From `website` on Node 24:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node --test tests/release-history.test.mjs tests/release-history-d1.test.mjs
node --test tests/revision-recovery.test.mjs tests/revision-router.test.mjs
npm run check
npm test
npm run build
npm run bundle
```

All database fixtures and identities are synthetic; local D1 blocks outbound
requests. `bundle` is Wrangler dry-run only. No production or live inference
qualification is represented by these results.

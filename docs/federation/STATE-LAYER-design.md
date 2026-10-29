# Federation state-layer design (repair options and choice)

Companion to `STATE-LAYER-contract.md`. Base `53f9e10`. Transport,
endpoints, fixture stage, canonicalizer, and `policy.mjs` unchanged.

## Design A — claim-first + single-effect batches + idempotent completions (CHOSEN)

Each mutation runs up to three durable phases:

1. **Claim** (consuming actions only): one shared conditional
   statement (`UPDATE approvals ... WHERE consumed_at IS NULL AND
   decision='approved'`, recording op/action/target). Exactly one
   claimant wins across commit/revise/resume; the claim commits
   before the effect (fail-closed burn on effect failure —
   verdict-accepted).
2. **Effect batch**: one `db.batch([...])` (D1 executes it as a SQL
   transaction; verified locally per REVIEW §D1). No assertion
   abort: every effect statement is conditional and re-pins its own
   mutable dependencies inline; zero-row effects are detected via
   `meta.changes` and mapped to precise 4xx by re-read. Claim and
   fingerprint chaining order effects so nothing lands without its
   prerequisite.
3. **Completions**: idempotent post-commit history/audit writes with
   deterministic ids, run after every success AND on every reconcile
   path.

New modules: `src/fabric/operations.mjs` (op identity, shared claim,
ledger attempt fencing helpers, redaction, audit/history ensure) and
`src/fabric/transitions.mjs` (per-mutation effect-batch builders and
post-failure mappers). `store.mjs` keeps auth pre-reads (fast-fail),
immutable-proof verification, and response shaping; `router.mjs`
keeps transport guards, threads op context (key/path/attempt/opId)
to every mutation, and uses the shared envelope. Migration 0008
adds veto/binding/fencing columns; 0007's exporter UPDATE is
corrected in place (probe-mandated: R2-6 executes the file itself;
never applied outside fixtures).

Why it meets the contract:

- I-AUTH-1/ARCH-4/R2-3: dependency predicates evaluate at the
  durable write; a suspend interleaved before the effect statement
  yields zero rows, detected and mapped (no silent commit).
- I-AUTH-2/3, ARCH-2/3, R2-1/2: exact (target, revision) bindings
  for strict actions + causal grant-generation for legacy targetless
  approvals; one shared claim across all consuming actions.
- I-CONS-1..3, ARCH-1, F1R-1: side-owned veto rows; withdrawal
  deletes caller-owned rows with own-proof only; same-side
  re-restriction converges 200.
- I-OP-1..5, ARCH-5/6/7, R2-4: retained hash + `uncertain` +
  attempt-fenced finalize/release/steal; immutable completed rows;
  metadata-only reconcile with audit ensured.
- I-LIFE-3, R2-6: approval-evidence backfill + quarantine for
  unprovable/ambiguous rows; NULL-exporter fails closed everywhere.
- I-READ-1, ARCH-8/R2-5: one eligibility builder incl. exporter,
  workspace, quarantine, and veto checks.

Costs: one shared claim path, per-mutation batch builders, shim
fidelity work (savepoint-nested batches routing through statement
methods so deterministic interleavings execute), Miniflare D1 tests;
stricter stale-intent rejection; zero probe-mechanism adaptations
(contract §9). Fan-out never multiplies statements: scope checks
use bounded EXISTS predicates, snapshots are validated by bounded
per-entry EXISTS (≤25 resources, each statement stays under D1
parameter limits), veto lists ≤ 2 sides.

## Designs considered and rejected

**B1 — CHECK-assertion abort with everything in-batch** (an earlier
draft of this repair): disproved by executable probes. An assertion
abort rolls back deterministically interleaved inner work, yielding
zero surviving uses where ARCH-3 requires exactly one; in-batch
audit makes audit-fault retries return 201-fresh where ARCH-7 and
the R2 five-creators control require 200-reconciled; an in-batch
claim rolls back on effect failure, letting a failed retry
re-consume where R2-CONTROL claim-burn requires fail-closed 409
(verdict-accepted behavior). Rejected on probe-mechanism grounds.

**B2 — enriched CAS + intent journal, no batch dependence**: keep
separate-statement execution with affected-row checks, a durable
intent journal, and a best-effort recovery sweeper completing
missing rows idempotently. Rejected: multi-row effects cannot
commit atomically, so fault windows need forward-repair code per
endpoint (more of the patching the review rejects); compensating a
lost cross-action race requires reverting an already-visible grant
mutation (observably violates version monotonicity); same migration
burden with weaker guarantees while D1 batch is available and
verified.

Verdict: A uses the platform's actual guarantee where it applies
(single-effect atomicity) and matches the probes' mandated recovery
shape where it does not (claim-first burn, post-commit
completions). B1 fails the probes; B2 re-implements transactions
badly.

## Platform guarantees relied upon (all verified, none assumed)

1. `db.batch([...])` executes as one SQL transaction; any statement
   failure rolls back all of it (D1 docs + local Miniflare check).
2. Zero-row conditional writes succeed without rollback; hence
   outcomes are detected via per-statement `meta.changes` and
   mapped by re-read (docs + local check).
3. No interactive `BEGIN`, no `SELECT FOR UPDATE`, no cross-call
   atomicity, no JS-side locks (docs + local rejection check).
4. Single-database scope: all authority rows live in one D1
   database; no distributed commit anywhere in F1.
5. Batch/param limits bound fan-out: snapshots already capped at
   25, veto lists ≤ 2 sides, list queries chunked under parameter
   limits; effect batches stay small by construction.

## Residual risks and explicit non-goals

- D1 batch limits under pathological fan-out: capped inputs +
   chunked reads; measured scale work is out of scope.
- Operation-record retention: future gate (D4); rows are small and
   bounded per key+actor.
- Execution admission, placement, quotas, output policy, revocation
   propagation to live runtimes: later-stage gates per REVIEW
   boundary table; authorization preview stays advisory.
- Attempt fencing for legacy direct store calls is status-only
   (documented §3); router-driven calls are fully fenced.

## Review record

The REVIEW.md + F1R2-QA-verdict probes are the executable design
review: every structural choice above is forced by at least one
as-written probe assertion (see the revision note in the contract
and the per-mutation table). An earlier draft of this design went
through a separate adversarial pass whose dispositions were
superseded by that probe-mechanical analysis; this record documents
scrutiny applied, not clearance granted; clearance remains with
independent exact-build QA.

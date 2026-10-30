# Federation state-layer contract (invariant ledger)

Refactor base: `53f9e10cb3edfbe8ab10d4c8aa1b683f724c0c3a`
(branch `muse/federation-control-plane`, tree verified clean, no later work).
This document is the enforceable contract for the shared state-layer
repair. It replaces endpoint-by-endpoint patching for authorization and
transitions. Transport surface, fixture stage, canonicalizer, and the
no-stitching policy matcher are unchanged.

Revision note (F1R3): an earlier draft of this contract specified
CHECK-assertion batch aborts with history/audit/outcome inside one
batch. Executable-probe analysis disproved that shape on three counts:
an assertion abort rolls back deterministically interleaved inner work
(ARCH-3 demands exactly one surviving use, not zero); in-batch audit
makes audit-fault retries return 201-fresh instead of the mandated
200-reconciled (ARCH-7, R2 five-creators); and a rolled-back claim lets
a failed retry re-consume instead of the mandated fail-closed 409
(R2-CONTROL claim-burn, accepted by the verdict as correct behavior).
The contract below specifies the unique probe-satisfying shape:
shared claim-first consumption, single-effect conditional batches with
in-effect dependency re-pinning, and post-commit idempotent
history/audit completions with reconcile-on-retry.

## 1. Authority model (agreed semantics)

- **Owner**: authenticated user id resolved by `worker.js` (session or
  API key). Disabled users fail closed; demo is read-only on fabric
  writes. A client-supplied id/label never creates authority.
- **Workspace**: owner-scoped namespace string. Nodes live in exactly
  one workspace; connection endpoints name (node, workspace) immutably.
- **Node**: immutable identity `(id, owner, workspace)` plus a static
  credential verifier. Node secrets authenticate invitation ceremonies
  and confirm a side's OWN veto withdrawal; they are never peer
  consent: presenting another side's secret withdraws nothing.
- **Consumer**: caller-supplied attribution label, matched only against
  a grant's consumer allowlist. Not authentication (later-stage gate).
- **Resource identity**: `(id, incarnation, exporter_owner)` resolved
  live at every decision. Snapshots record what was reviewed; the live
  row decides what still holds.
- **Connection incarnation**: a connection id denotes one accepted
  invitation with immutable endpoint nodes/workspaces. Every veto
  add/remove bumps `version`, which is therefore the consent clock;
  suspension changes revision, never identity. State derives from
  vetoes: `active` iff zero veto rows exist.
- **Exporter**: the recorded issuing authority of a grant
  (`exporter_id`), bound at commit from the committing session, or
  reconstructed for legacy rows ONLY from approval/preview evidence
  (never from current resource ownership alone). Rows whose issuer is
  unprovable or ambiguous are quarantined (inert), never authorized.
- **Operation identity**: `(actor_kind, actor_id, idempotency_key)`
  bound to `(method, path, canonical_body_hash)` and fenced by attempt
  tokens. Never deleted; terminal outcomes immutable.

## 2. Invariant ledger

| ID | Invariant | Enforcement point |
|----|-----------|-------------------|
| I-AUTH-1 | Every mutation re-validates actor authority and all mutable dependencies at the durable write; JS pre-reads are fast-fail only | Shared conditional claim + conditional effect batches with in-effect dependency re-pinning; post-failure mapping by re-read |
| I-AUTH-2 | Approvals bind scope terms digest, connection + revision + grant-generation, exporter/importer; `grant.revise`/`grant.resume` bind exact `(target_grant, reviewed_version)`; legacy targetless approvals fall back to the causal connection grant-generation (never wall-clock or rowid order) | Typed approval columns recorded at request; equality predicates at consume |
| I-AUTH-3 | One approval yields at most one recorded consumption across commit/revise/resume, ever | One shared conditional claim statement (`consumed_at`/`consumed_by_op`/`consumed_action`/`consumed_target`) executed before any effect; losers change nothing |
| I-CONS-1 | Each side owns its veto rows; no actor adds/removes another side's veto | Side-ownership predicates in veto writes |
| I-CONS-2 | Withdrawal requires the side owner's live session plus that side's own secret proof; a peer secret withdraws nothing | Resume endpoint withdraws caller-owned sides with valid own-proof only |
| I-CONS-3 | `active` holds iff no veto rows exist; any veto blocks admission | State derived with the veto write; authz joins veto existence |
| I-LIFE-1 | Revoked is terminal; pause/revoke bump versions | Status predicates in effect writes |
| I-LIFE-2 | Revision never changes status (no paused→enforced via revise) and never applies stale reviewed terms | Status-preserving update + binding predicates |
| I-LIFE-3 | Quarantined/issuer-ambiguous grants authorize and mutate nothing | `quarantine_reason`/NULL-exporter predicates on every path |
| I-OP-1 | Same key+actor+request converges to one effect; changed method/path/body conflicts, including after 5xx | Retained hash binding; `uncertain` state; mismatch checked first |
| I-OP-2 | Completed outcomes (success or terminal 4xx) are immutable; late attempts never overwrite them | Status predicates on finalize; completed rows match no takeover |
| I-OP-3 | Attempt fencing: only the current attempt token finalizes, releases, or steals an operation record | Token equality in every router-driven ledger write; legacy direct calls keep status-only fencing (documented) |
| I-OP-4 | Each business effect commits with its dependency checks in one batch; history and audit complete idempotently after commit and are repaired by reconcile-on-retry, never lost silently | Single-effect `db.batch()` per mutation; deterministic history/audit ids; reconcile paths ensure missing completions before reporting success |
| I-OP-5 | Replay preserves status/error shape and contains only the public projection; one-time secrets never persist | Redaction at write AND read; raw error envelopes; metadata-only reconcile |

Product decisions (explicit, not inferred): **D1** disconnect stays
reversible under vetoes (reactivation needs every vetoer's withdrawal;
a vetoed connection returns to `active` only when the last veto is
withdrawn — restriction moves terminal-ward, withdrawal restores).
Old grants persist across suspension and re-authorize on reactivation
(no silent re-grant: the same grant rows, re-evaluated live).
**D2** a `grant.commit` approval may be consumed exactly once, either
to create (M10, create-only) or to revise (M11, first use with a
recorded binding) — xor via the shared claim, never both; the new
strict `grant.revise` action with required target binds exactly
(target, revision). **D3** legacy ambiguous grants are inert until
re-issued (no un-quarantine path in F1). **D4** operation-record
retention horizon is a future gate; ledger rows accumulate boundedly
(one per key+actor) and are never deleted in F1 — except legacy
secret-bearing idempotency rows, which 0008 quarantines (fail-closed)
rather than serving. **D5** a disabled/deleted owner's vetoes persist
with no override path; recovery is re-enable the owner or open a new
relationship (fresh invitation). No admin transfer in F1.

## 3. Operation protocol (shared by REST and MCP)

States: `processing` (in-flight, lease-bound) → `completed`
(immutable) or `uncertain` (5xx seen, effect-unknown, hash retained) →
`processing` (reclaimed) → `completed`. No other transitions; no
deletes. Every router-driven ledger row carries the current caller
`attempt` token.

1. Gate (`check`): find row by (actor, key). None → insert
   `processing` with a fresh attempt token + full binding → proceed;
   on INSERT conflict (lost initial race) → re-read once and continue
   below (completed→replay, binding differs→409, else 409 pending).
   Binding (method/path/body-hash) is compared FIRST for every
   existing state — completed, processing, uncertain, quarantined —
   and any difference is 409 mismatch before any reclaim, replay, or
   execution. `quarantined` rows never replay or execute (409).
   Completed → replay redacted result. Fresh `processing` → 409
   pending. Stale `processing` or any `uncertain` with matching
   binding → conditional exact-observed reclaim to `processing` with
   a new token → proceed; lost reclaim race → re-read
   (completed→replay else 409).
2. Execute: run the mutation (claim-first, then the single-effect
   batch, then idempotent completions). Effect batches never depend
   on ledger rows: direct store callers have no ledger entry, so
   ledger fencing guards finalize/release only, while effects are
   fenced by claims, fingerprints, and version CAS.
3. Fast-fail 4xx before any effect → attempt-fenced terminal finalize
   → same response replays later.
4. Effect failure / unexpected 5xx → attempt-fenced mark-`uncertain`
   (no-op if already completed) → mapped 4xx or 500. Retry
   re-executes; convergence via op-bound entity ids, fingerprints,
   and reconcile reads, never duplicates.
5. Late attempt with an old token → all fenced predicates fail →
   no-op. Only stale `processing` and `uncertain` rows are
   reclaimable; completed rows never match any takeover predicate.

## 4. Transition shape (canonical, all mutations)

Each mutation runs at most three durable phases, in order:

1. **Claim** (consuming actions only: commit, revise, resume): one
   shared conditional statement,
   `UPDATE approvals SET consumed_at=:now, consumed_by_op=:op,
   consumed_action=:action, consumed_target=:target
   WHERE id=:id AND consumed_at IS NULL AND decision='approved'`.
   Exactly one claimant wins; losers change nothing and return
   409/conflict (or reconcile, see §5). The claim commits before the
   effect batch: a failed effect leaves the approval spent
   (fail-closed reapproval, verdict-accepted — R2-CONTROL claim-burn).
2. **Effect batch**: one `db.batch([...])` with preconstructed
   statements (D1 executes it as a SQL transaction; verified locally
   per REVIEW §D1). There is NO assertion-abort: every effect
   statement is conditional and re-pins its own mutable dependencies
   inline (row versions, statuses, connection state, version,
   generation, resource owner/incarnation, approval
   consumption fingerprint, grant effect fingerprint). Zero-row
   effects are legal outcomes, detected via per-statement
   `meta.changes`, never silent commits: a zero-row guarded effect
   maps to a precise 4xx by re-read (§6). Genuine SQL errors
   (UNIQUE/entity conflicts) abort the batch and map via
   reconcile-or-500. Claim and fingerprint chaining order effects so
   a later statement never lands when its prerequisite did not:
   e.g. a revision history row is conditional on the grant row
   carrying this approval as `last_approval_id`.
3. **Completions** (history/audit): idempotent post-commit writes
   with deterministic ids (`fgr_<grant>_<version>_<approval>` for
   revision history, `aud_<op>_<action>` for audit), conditional
   (`INSERT ... WHERE NOT EXISTS` / `OR IGNORE`). They run after
   every successful effect AND on every reconcile path, so a fault
   between effect and completion is repaired by retry (ARCH-7,
   R2-history, R2 five-creators) instead of reported as success
   with missing evidence. Audit is a post-commit observation of a
   committed effect, not part of the state transition — this
   asymmetry is probe-mandated (in-batch audit returns 201-fresh
   where 200-reconciled is required) and disclosed here.

JS pre-checks may only rely on facts immutable for the operation's
lifetime: token/node-secret VERIFIER equality (no rotation API exists;
if rotation is ever added, generation-equality predicates become
mandatory), canonical digests of never-updated rows (previews), and
pure value comparisons. Everything else — actor disabled/demo state,
row versions/statuses, connection state and vetoes, grant terms and
status, approval decision/consumption/expiry, resource
existence/owner/incarnation — is a SQL predicate evaluated at the
durable write. Timestamps use one bound `:now` (UTC ISO).

## 5. Per-mutation contract table

Legend: **LP** = linearization point (the claim commit for consuming
actions; the effect batch commit otherwise). All mutations require
the operation gate (§3) first when invoked via router; direct store
calls carry a fresh one-off op identity.

| # | Mutation | Authorized actor + live bindings | Legal source → target; preconditions | Atomic condition (LP) | Recovery / audit / history / return |
|---|----------|----------------------------------|--------------------------------------|------------------------|--------------------------------------|
| M1 | node.register | Owning live (not disabled) non-demo session; key credentials never | absent → registered; label valid | Op-bound id + conditional INSERT; actor-state predicate | Retry converges on the one row (200 metadata-only, secret never re-shown); audit ensured exactly once |
| M2 | invitation.create | Issuing-node owning session; recipient node exists, ≠ issuer | absent → issued; workspace names valid | Op-bound id + conditional INSERT + live node predicates | As M1; token one-time; 201 or 200 reconciled metadata |
| M3 | invitation.accept | Recipient-node owning session + token + node secret (immutable proofs, JS) + exact (node, workspace) | issued+unexpired → accepted + exactly one connection; terminal states never revert | Conditional flip + conditional connection INSERT in one batch; UNIQUE invitation binding backstop | Batch-atomic flip+connection; legacy accepted-without-connection completes idempotently; retry converges on the one connection without resetting its state |
| M4 | invitation.decline / revoke | Recipient side / issuer side respectively | issued → declined / revoked; else 409 | Conditional state flip | Terminal; repeats 409 (a decided invitation never re-decides) |
| M5 | connection.suspend / disconnect | Either side: owning live session or inference-key narrow | active/suspended → own veto recorded; same-side already-vetoed converges 200 (any state); from disconnected a NEW side veto is 409 | Conditional restriction UPDATE (version CAS + mirror) + chained veto-row INSERT, one batch | Veto rows append-only per side with monotonic epoch; audit each restriction; concurrent losers get 412, no silent overwrite |
| M6 | connection.withdraw-veto (resume endpoint) | Side-owning live session + that side's OWN node-secret proof; a peer secret withdraws nothing | vetoed → vetoes minus caller-owned sides proven; active iff zero vetoes remain; legacy NULL consent → 409 before proof checks | Conditional veto-row DELETEs + version-pinned state derivation, one batch | Returns withdrawn/remaining vetoes; peer vetoes untouched; no own veto → 409; no valid own proof → 403; stale version → 412 |
| M7 | preview.create | Exporting session; connection side; resources owner-controlled | absent → preview; 1–25 resources, ≥1 model/consumer, positive ceilings | Op-bound id + conditional INSERT + live ownership per entry | Fully reconstructible; retry converges (200) or replays |
| M8 | approval.request | Exporter session (`fabric.propose` for keys); nested refs authorized (404 otherwise) | preview valid+unexpired, or grant target valid → requested; records issued (connection, version, grant-generation) and, for `grant.revise`/`grant.resume`, exact (target, reviewed version) | Conditional INSERT + live predicates | Binding rows immutable once written; retry converges |
| M9 | approval.decide | Exporting owner interactive session only | requested+unexpired → approved/rejected; decided_at recorded | Conditional decision flip | Double-decide → 409; decision payload immutable after |
| M10 | grant.commit (CREATE-ONLY; never updates an existing grant) | Exporter session + unused approval | absent → enforced; approval approved+unexpired+unused; preview digest+scope match; connection active at issued version; every snapshot entry live-valid (owner==exporter, incarnation match, not imported); not quarantined | Shared claim, then one batch: conditional INSERT + grant-generation bump chained on the insert | Double-apply impossible across commit/revise/resume (D2 xor); already-consumed-for-this-grant reconciles 200; foreign consumption 409 |
| M11 | grant.revise | Exporter session + approval bound to this grant | enforced/paused same-status → new terms; exact (target, revision) for `grant.revise`, causal grant-generation for legacy `grant.commit` approvals; connection active at issued version; snapshot live-valid; not quarantined | Shared claim, then one batch: conditional status-preserving UPDATE (re-pinned deps) + generation bump chained on the update; history post-commit conditional on `last_approval_id` fingerprint | Stale → 412; consumed-by-other → 409 value; consumed-by-this-effect → 200 reconcile with history/audit ensured (reconciled history carries current terms marked `reconciled:true`: a fault between effect and completion loses the exact before-image) |
| M12 | grant.pause / revoke | Exporter session or inference-key narrow | enforced→paused; non-revoked→revoked; version CAS; never on quarantined/issuer-ambiguous rows (409, no exceptions — narrowing included) | One batch: conditional status UPDATE + generation bump chained on the update | Revoke terminal forever; audit each; losers 412, never silent success |
| M13 | grant.resume | Exporter session + resume approval bound to (target, paused revision) | paused → enforced; vector + binding + issued version current; connection active; not quarantined | Shared claim, then one batch: conditional UPDATE + generation bump; `last_approval_id` set | Single consumption; revoked always forbidden |
| M14 | deny.create / delete | Owning session; resource owned if named | absent ↔ present | Op-bound id + conditional INSERT / conditional DELETE + ownership | Audit each; delete of missing → 404 |

## 6. Post-failure mapping order (deterministic)

After any guarded zero-row outcome or batch error, re-read and return
the FIRST matching code:
404 (target/approval/preview/grant missing or invisible) → 403
(authority/ownership/human-only/key-scope/demo/disabled, missing own
proof) → 410 (approval or preview expired) → 409 (terminal-state
conflict, quarantined/issuer-ambiguous row, consumed approval,
idempotency mismatch/pending/quarantined, no-own-veto) → 412
(version/vector/binding/generation staleness) → 500 +
`uncertain` (no predicate explains the failure: fault or unknown).
Deterministic 4xx mappings finalize terminal fenced outcomes; 500
never finalizes. Race-loss outcomes are returned as values, never
thrown, so concurrent losers settle without exceptions — including a
consumed approval observed in pre-reads (a concurrent winner spent
it); other pre-read validation failures throw.

## 7. Read contract (authorization + discovery)

One shared eligibility builder feeds both: live resource exists AND
incarnation matches snapshot AND live owner == recorded exporter AND
grant enforced+unexpired AND not quarantined AND connection has zero
veto rows AND recipient (node, workspace) matches AND (consumer ∈
allowlist, action/model/route/ceilings via `policy.mjs` no-stitching
matcher) AND no covering deny. Quarantined or issuer-ambiguous grants
are ineligible everywhere. Discovery returns a resource iff some
(grant, consumer) witness is eligible; dedupe runs only over eligible
witnesses (order-independent).

## 8. Migration contract

- 0007 is corrected in place: exporter derives from
  approval→preview→exporter-node→owner evidence (with a scope-
  consistency check: preview connection/recipient must equal the
  grant's, else NULL), and `last_approval_id` from the grant's own
  creation approval. Justification (all three required, all hold):
  (a) F1 was never enabled and no production D1 exists for it
  (`wrangler.jsonc` still carries a placeholder id; staged auth
  forbids unapproved cloud creation), so no production row can carry
  the old derivation; (b) the R2-6 boundary probe executes the 0007
  file itself and asserts evidence-derived results, which is only
  satisfiable in the file; (c) 0008 re-derives and re-validates every
  exporter anyway (below), so even a hypothetical already-migrated DB
  converges. Evidence over live-owner fallback, always; missing or
  inconsistent evidence ⇒ NULL, never a guess.
- 0008 adds: `connection_vetoes` (backfilled from `vetoed_by` JSON,
  plus BOTH-sides vetoes for restrictive-state rows with no recorded
  vetoer — fail-closed, withdrawable via own sessions);
  `connections.grant_gen` (causal
  per-connection grant-mutation generation, bumped by every grant
  effect in F1R3); `approvals.decided_at`,
  `approvals.issued_connection/version/grant_gen`,
  `approvals.bound_grant_id/version`,
  `approvals.consumed_by_op/action/target`;
  `idempotency_records.attempt` (legacy rows NULL: replayable only
  without a presented token, never rebindable to a new attempt);
  `fabric_grants.quarantine_reason`;
  `UPDATE <table> SET version=1 WHERE version IS NULL` defensively
  on connections and fabric_grants; re-derive every exporter from
  approval evidence and set `quarantine_reason` wherever evidence is
  missing/inconsistent, the exporter is NULL, or any current
  snapshot owner disagrees with the evidence (changed rows stay
  inert even when the issuer is provable); quarantine (fail-closed
  status, never served) any completed idempotency row still
  containing secret-shaped keys at any depth after the top-level
  purge. No other applied migration is rewritten.
- Invariants on legacy rows: NULL-exporter or quarantined ⇒ inert
  (deny + 409 on mutation, narrowing included). Fresh rows always
  carry full bindings.
- Upgrade fixtures must cover: intact history, drifted ownership,
  missing resources/approvals/previews, secret-bearing replay rows
  (top-level and nested), NULL consent, NULL versions, legacy
  in-flight op rows.

## 9. Probe-compatibility ledger (normative for this repair)

Retained byte-unchanged and passing (37): every test in
`tests/qa-independent.test.mjs` (16), `tests/qa-ui.test.mjs` (4),
`tests/qa-f1r-stress.test.mjs` (15), `tests/qa-f1r-ui-extra.test.mjs`
(2). Dual-use commit approvals (D2), reversible disconnect (D1),
version-mismatch-first ordering, and existing API shapes are retained
for exactly this reason; the repair is verified against these files
unmodified.

New gate files (20 tests), all passing as written: all of
`tests/qa-architecture-f1r2.test.mjs` (8) and all of
`tests/qa-f1r2-boundaries.test.mjs` (12, incl. 5 already-passing
controls that must stay green). No probe-mechanism adaptation is
required: side-owned withdrawal still returns 200 for the joint-call
shape (withdrawing the caller's own side), same-side re-restriction
converges 200, single-effect batches keep the intercepted statement
prefixes (`INSERT INTO fabric_grants `, `UPDATE fabric_grants SET
consumers`) stable, and claim-first consumption preserves the
verdict-accepted burn-409. New equivalent tests ship alongside (never
replacing) these files.

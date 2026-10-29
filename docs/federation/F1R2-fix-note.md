# F1R2 fix note (F1R-1–F1R-8 repair pass)

Second independent gate on `51a8bbe` passed the 191 owner tests and all
20 prior probes but failed 9 new stress probes (`task-4/F1R-QA-verdict.md`).
This commit repairs all 8 findings on the same branch. No features added;
no F1P work.

## Fixes by finding

- F1R-1 (consent replacement): connections carry an independent veto set
  (`vetoed_by`, migration 0007; `suspended_by` retained for the legacy
  path and audit). Suspend/disconnect ADD the acting side's veto and never
  remove the peer's. Resume requires one node-secret bearer proof per
  vetoing side (`nodeKey`/`nodeKeys`), so Bob disconnecting Alice's
  suspension cannot restore admission without Alice's secret. Legacy
  NULL-consent rows still fail closed (409).
- F1R-2 (stale approval overwrite): grants record `last_approval_id`
  (set at commit, updated at revise). Revise admits only approvals newer
  (by `rowid` Lamport clock) than the grant's last applied approval;
  older approvals go 412 stale. Pre-tracking grants accept one binding
  revision, then join the clock.
- F1R-3 (double consume): revise claims the approval FIRST by
  conditional update (`consumed_at IS NULL`), then applies the grant
  write. Exactly one concurrent claimant wins; losers change nothing
  (409 value). If the grant write then loses a race, the spent approval
  requires re-approval (fail-closed, documented).
- F1R-4 (retry duplication): entity creation binds ids to the operation
  (`opEntityId`: actor + path + idempotency key) for nodes, invitations,
  previews, approvals, and denies. A same-key retry after a 5xx converges
  on the committed row (200 + `reconciled`) instead of duplicating;
  one-time secrets stay unrecoverable and are omitted with a note.
  Commits already converged via `UNIQUE(approval_id)`; revise reconciles
  consumed approvals via `last_approval_id`.
- F1R-5 (MCP error envelope): MCP terminal-failure replays — and
  returned error values — use the raw `{error, code}` shape, never
  `{ok:true}`.
- F1R-6 (discovery masking): dedupe marks resources only after a visible
  witness is found, so an ineligible grant cannot hide an eligible one.
- F1R-7 (ownership drift): grants record `exporter_id` at commit
  (backfilled for intact rows). Authorization requires the live row to
  still be held by the exporter; lifecycle authority (`actorExportsGrant`)
  uses the recorded exporter instead of whoever owns the row today.
- F1R-8 (legacy persisted secrets): migration 0007 strips secret fields
  from completed idempotency rows in place (JSON1 `json_remove` + note),
  and replay reads redact as a backstop.

## Regression coverage

- `tests/qa-f1r-stress.test.mjs`, `tests/qa-f1r-ui-extra.test.mjs`:
  independent probes committed verbatim (15 + 2).
- `tests/fabric-f1r.test.mjs`: +4 owner tests (0007 columns, exporter +
  multi-proof veto lifecycle, lost-response reconcile, purge statement).

## Results (owner runs)

- `npm test`: 212/212. `npm run check`: pass. `npm run build`: green.
- workerd smoke (`FEDERATION_ENABLED=1`): anon REST 401, `/api/health`
  ready:true; server chain stopped, port verified free.

## Accepted trade-offs (documented, not hidden)

- A revise approval spent by claim-first and then losing the grant race
  must be re-requested (rare, fail-closed).
- Reconciled secret-issuance responses omit the unrecoverable secret;
  callers register a new entity for a usable credential.
- Pre-tracking grants (NULL `exporter_id`/`last_approval_id`) use legacy
  fallback until rebound; migration backfills all intact rows.
- Verdict's spec-level gates (consumer auth, placement, execution
  leases, output auth, retention, MCP negotiation) remain later-stage
  scope, as the report itself states.

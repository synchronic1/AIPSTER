# F1R fix note (R1–R10 repair pass)

Independent gate on `c8bbd82` returned FAIL with 10 consolidated findings
(`task-4/F1-QA-verdict.md`: 13 failing probes, 7 passing controls). This
commit repairs all 10 on the same branch. No features added; no F1P work.

## Fixes by finding

- R1 (revise binds nothing): `reviseGrant` now requires the approval to be
  the acting exporter's own end-to-end decision (requested + decided by
  them), re-checks preview canonical integrity, binds preview connection /
  recipient node / workspace to the target grant (422 PREVIEW_MISMATCH),
  enforces the approval's connection revision vector (412), revalidates
  every new snapshot entry against live ownership/incarnation, and applies
  via conditional `UPDATE ... WHERE id + version + not revoked`.
- R2 (resume/revoke race): all six state transitions (grant pause/resume/
  revoke/revise, connection suspend/disconnect/resume) use conditional
  writes with affected-row checks. Race losers return 412 values (resume
  losing to revoke returns 409 revoked); revoke finality holds because no
  path leaves `revoked`. Verified: concurrent approved-resume vs revoke
  settles `revoked`.
- R3 (importer resumes disconnect): migration `0006_consent.sql` adds
  `connections.suspended_by`; suspend/disconnect record the acting side;
  resume requires that side's node secret plus ownership (403 otherwise).
  Grants on non-active connections still gate admission.
- R4 (stale incarnation): authorization resolves the live resource row and
  drops every grant whose snapshot incarnation differs (or whose resource
  is gone) before matching — fail-closed.
- R5 (approval-request leak): `requestApproval` authorizes nested
  references — preview exporter must be the actor (commit), grant exporter
  must be the actor (resume) — else 404 without metadata.
- R6 (idempotency): 4xx outcomes finalize as terminal (same-key replays
  the same failure); 5xx releases the processing record for fresh retry;
  stale `processing` rows (>10 min) can be stolen once via conditional
  update; invitation accept recovers `accepted`-without-connection by
  completing the connection idempotently (UNIQUE-guarded) instead of
  burning the invite. Double-accept with valid proofs now converges
  (200, same connection) rather than 409.
- R7 (discovery): grant-via entries require live-row incarnation match
  and at least one undenied grant consumer for inference; live
  name/incarnation reported.
- R8 (secret persistence): `storeIdempotency` strips `nodeSecret`/`token`/
  `secret` before persisting; replays return metadata + `replayNote`.
- R9 (model XSS): grant-card models escaped per value.
- R10 (error copy): `loadFederation` shows "not enabled" only on the
  flag-off 404; other failures render `fab-error` with the message.

## Regression coverage

- `tests/qa-helpers.mjs`, `tests/qa-independent.test.mjs`,
  `tests/qa-ui.test.mjs`: independent probes copied verbatim (16 + 4).
- `tests/fabric-f1r.test.mjs` (new, 4): 0006 column + consent lifecycle,
  consent denial code, replay redaction shape, lease steal.
- `tests/fabric-f1.test.mjs`: double-accept updated to recovery semantics.

## Results (owner runs)

- `npm test`: 191/191. `npm run check`: pass. `npm run build`: green.
- workerd smoke (`FEDERATION_ENABLED=1`): anon REST 401, anon MCP 401,
  unknown fabric route 404, `/api/health` ready:true; server stopped.

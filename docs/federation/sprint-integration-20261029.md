# Integrated review candidate, 2026-10-29

This repair branch combines the unique work from PRs #6, #12, #14, #18,
#20 and #26 with main `b0d1ea232fd0270690f685db7ccbf41bc8a68ee4`.
It preserves their original branches and commit ancestry. It is a concrete
replacement review candidate, not a production release or F1/F1P clearance.

## Changes and preserved boundaries

- Preserve immutable revision-history receipts and failure fences from #12.
- Preserve shared REST/MCP admission, bounded retained operation identities,
  and free restrictive admissions at budget/retention exhaustion from #14/#18.
- Preserve #20 atomic resource/owner/global heartbeat admission and its
  freshness, ownership, paging, revocation-oracle and rejected-write repairs.
- Preserve current main's patched Python worker, source/documentation pins,
  sparse checkout, Apache license and third-party notices. Installer and pairing
  actions remain unavailable. Include #26 explicit unknown-platform selection.
- Reconcile both identity reset paths, both routing imports and migration lists.
  The migration test now asserts the entire ordered suffix, rather than assuming
  federation's former 0012 is the final migration.
- Check approval ownership before expiry mutation, and recheck the live actor
  in the expiry UPDATE. Foreign owners cannot expire another owner's approval.
- Restrictive effects use shared immutable operation receipts and atomic audit
  completion. Retry recovery reads the applied outcome before fresh state/version
  checks; a later valid transition cannot rewrite the earlier response.

## Schema lineage

Applied main migrations 0001-0005 are byte-identical. The unapplied federation
lineage remains 0006-0012; heartbeat retains 0013; new restriction receipts use
0014. No applied file is renamed. Local D1 tests apply heartbeat before and
after the federation block and verify identity/budget preservation and integrity.
This does not substitute for checking a deployment's actual migration journal.
A database that used older branch-local federation names needs its own plan.

## Release handoff

The release owner should review the final exact candidate and its CI. Once
accepted as the replacement path, #6/#12/#14/#18 can close as superseded; #20 and
#26 are also included and must not be independently merged as competing copies.
Closed review artifact #21 has no unique implementation; its evidence remains
available. Do not reopen it or revive the superseded #9 alternative.

Before release, confirm the 0013/0014 migration allocation against the actual
journal and choose production heartbeat caps. Retention/archive policy remains
an operator decision: restriction works at exhaustion, expansion stays blocked.
No automated pruning of durable federation security evidence is introduced.

No main merge, deployment, production migration, credential operation, live
inference, model download, paid external compute, or F1P activation is part of
this sprint. Existing worker processes remain untouched. Local workerd D1 and
controlled worker fixtures establish local behavior, not hosted-D1 or live
inference capability. The final review report distinguishes author test runs,
independent verification, existing external receipts and inaccessible jobs.

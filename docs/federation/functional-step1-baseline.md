# Federation functional lane — milestone step 1: existing tests as-is

Worktree: `muse/federation-functional-20261102`, HEAD `ffd96fd` (origin/main).
Date (UTC): 2026-11-02. Node v24.18.1. `npm install` run once in
`website/` (devDeps `miniflare`/`workerd` needed for D1 tests); no tracked
file changes — `git status --short` clean after all runs.

## Results (each file run unmodified, exact counts from `node --test`)

| File | Tests | Pass | Fail |
|---|---|---|---|
| `website/tests/fabric-f1.test.mjs` | 21 | 21 | 0 |
| `website/tests/fabric-f1r3-d1.test.mjs` | 4 | 4 | 0 |
| `website/tests/federation-admission.test.mjs` | 10 | 10 | 0 |
| `website/tests/federation-budget-repro.test.mjs` | 1 | 1 | 0 |
| `website/tests/federation-main-upgrade.test.mjs` | 1 | 1 | 0 |
| `website/tests/federation-restrictive-admission.test.mjs` | 7 | 7 | 0 |
| Total | 44 | 44 | 0 |

## Scope statement

These are single-process synthetic-identity tests through the real worker
handler (sqlite shim or local Miniflare D1). A unit pass here is NOT a live
two-user sharing claim: no browser UI pass, no network peers, no real
identities/resources, flags default off. Two-identity isolated acceptance
against current real handlers is milestone step 2 (next).

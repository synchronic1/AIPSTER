# Reference provenance

Marker: MAC-E2E-SUCCESSOR-20261101

| File | Source | Revision | sha256 |
|---|---|---|---|
| `eif-task-contract.f6e45f5.mjs` | `website/src/inference/eif-task-contract.mjs` | `f6e45f556a48dd5f75a8e8b90992e8d9cfa0393e` (`origin/main`) | `db743c78e1102c37346d570f09748adbecc54a48d8939eb0ba36f362e1762541` |

Copied read-only with `git show origin/main:website/src/inference/eif-task-contract.mjs`.
It is a protocol codec only: no transport, credentials, placement or
authorization. `aipster_contract.py` mirrors it and the test suite re-checks the
mirror's field sets against this file on every run.

The worker branch does contain `website/` (`git cat-file -e
0763d87:website/src/inference/eif-task-contract.mjs` succeeds and that blob is
byte-identical to this copy), but this lane's sparse worktree does not
materialise `website/` on disk. The copy is therefore the only offline way to
compare the two real interfaces without Node or a full checkout.

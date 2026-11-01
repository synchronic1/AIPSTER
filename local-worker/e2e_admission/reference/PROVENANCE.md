# Reference provenance

Marker: MAC-E2E-SUCCESSOR-20261101

| File | Source | Revision | sha256 |
|---|---|---|---|
| `eif-task-contract.f6e45f5.mjs` | `website/src/inference/eif-task-contract.mjs` | `f6e45f556a48dd5f75a8e8b90992e8d9cfa0393e` (`origin/main`) | `db743c78e1102c37346d570f09748adbecc54a48d8939eb0ba36f362e1762541` |

Copied read-only with `git show origin/main:website/src/inference/eif-task-contract.mjs`.
It is a protocol codec only: no transport, credentials, placement or
authorization. `aipster_contract.py` mirrors it and the test suite re-checks the
mirror's field sets against this file on every run.

The worker branch this fixture runs against does not contain `website/`, so the
copy is the only offline way to compare the two real interfaces without Node.

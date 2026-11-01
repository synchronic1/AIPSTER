# Offline admission -> worker E2E fixtures

Marker: MAC-E2E-SUCCESSOR-20261101. Owner: Paseo successor agent
`0ac86bf6-f18a-447f-a463-13c9ac2ff86c` (offline E2E lane). New isolated namespace;
no production file is edited by this directory.

Chain under test, loopback only:

    fake AIPSTER admission (encodeCpuTask mirror)
      -> loopback fake Ganglion transport (bearer handshake)
      -> real vendored worker (run_fabric_bridge / serve_connection)
      -> real MockRuntime (resident fake runtime)

Run under the shared heavy-test gate:

```sh
cd local-worker
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$PWD/vendor/eif:$PWD" \
  python -m pytest e2e_admission -q -p no:cacheprovider
```

Requires `pydantic`, `websockets` and `pytest` from an existing environment. No
package is installed and no network request leaves 127.0.0.1.

## What the fixture proves, and what it does not

Proven (component evidence, not production E2E):

* AIPSTER's real `encodeCpuTask` payload is rejected with 422 by the worker's
  strict request schema (`allow_simulated`, `idempotency_key`), and
  `encodeBoundCpuTask`'s `placement` is rejected too.
* After dropping those fields the worker executes and binds the result to the
  dispatch identity, but the result is `simulated: true` with empty `usage`, and
  AIPSTER's own decoder rejects it.
* A `cancel` frame is silently ignored; the job runs to completion.
* The worker-local timeout is the only deadline bound; AIPSTER classifies a
  timeout as uncertain, with no retry and no proof remote work stopped.
* A fresh `Node` instance re-executes the same job id: the worker persists no
  job ledger. This is an instance restart inside one interpreter, which is
  equivalent here only because this adapter writes nothing to `state_dir`
  (asserted in the test), not an OS process restart.
* A wrong bearer is rejected once at the handshake and not retried.

The pinned reference copy is digest-checked on every run; the mirror's known
divergences (prompt length counted in code points, JSON byte-length encoding) are
documented in `aipster_contract.py`.

Not proven / BLOCKED:

* Any production dispatch path: `POST /api/jobs` is unconditionally 501 at
  f6e45f5 (source-known; not live-probed).
* Server-side admission, authentication, reservation, accounting: no inference
  admission exists in accessible source, and Node 24 / npm deps are absent.
* Qualification: `MockRuntime` is not model evidence and its usage is empty.

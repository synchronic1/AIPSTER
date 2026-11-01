# Public-clone installation evidence

Observed 2026-10-28 on Windows x64, CPython 3.12.14, uv 0.12.12.
AIPSTER base: `abc532576817a6ce1322e866b2e8f9ea958c3de8`.
Tested installation revision: `b9de0fb` on `codex/public-local-worker-20261028`.
Public EIF source: `536508832b12d993dc272e03d4f09aca53801f68`.
Later evidence-only changes do not alter installed source or test code.

Fresh clone command (not the development working tree):

```text
git -c credential.helper= -c core.autocrlf=true clone --single-branch --branch codex/public-local-worker-20261028 https://github.com/synchronic1/AIPSTER.git public-clone
cd public-clone/local-worker
uv run --no-project --python 3.12.14 python install.py
.venv/Scripts/python.exe test_installation.py
git status --short
```

Clone subprocess used `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=NUL`,
`GIT_TERMINAL_PROMPT=0` and an environment allowlist with no saved token values.
Installer used new `.venv`, no uv cache/config, disabled keyring, empty netrc and
temporary empty uv credentials directory. Python 3.12.14 and uv 0.12.12 were
already installed public tools; this was not a clean OS image or container.
No private Gitea access, saved private credentials, native binary, model weights,
production calls, paid calls or inference were used.

Results: 16/16 original blob hashes verified; 24 installed distributions compatible
(worker + 18 runtime + 5 build); all 9 tests passed; working tree remained clean.

| Check | Observed result |
|---|---|
| Byte-exact vendor integrity | Passed after Windows checkout with autocrlf enabled. |
| Installed CLI entry point | `dendrite --help` exits 0. |
| Mock inspect | Exits 0, local execution scope and simulated model. |
| Malformed/unknown config | Both subcases exit 2 with diagnostic. |
| CPU example | Loopback, managed runtime, zero GPU layers, no cloud URLs. Command constructed only; no CPU-confinement claim. |
| Network bind without token | Rejected. |
| Missing model / missing engine | Expected RuntimeFailure; subprocess creation patched to fail if attempted. Tiny magic-byte fixture is not a model. |
| Mock daemon | Real CLI subprocess, loopback HTTP health and simulated execution pass; subprocess stopped. |
| Native adapter fixture | Controlled local HTTP server checks health/model identity and exact completion payload. Synthetic response only. |

Independent Codex review caught that Windows CRLF conversion would invalidate
upstream file hashes. `local-worker/.gitattributes` now preserves vendor bytes;
a fresh local clone and the fresh public clone both passed afterward. The
installed wheel contains LICENSE and NOTICE. Runtime lock versions match the
original upstream uv.lock; build tools are separately hash locked.

No native build, real model load, GPU behavior, Linux/macOS installation, AIPSTER
admission or connected execution was verified. Existing federation holds remain.
Public CI repeats mock installation on Windows; its result is separate from
these locally observed checks. See PR checks for the eventual CI result.

## Local patch 0001: token on every bind, Host/Origin validation (2026-10-28)

Fixes review finding
[PR #14 discussion r4405943472](https://github.com/synchronic1/AIPSTER/pull/14#discussion_r4405943472)
(P2: optional loopback authentication, arbitrary Host). Base: main `7b38ba0`.
Windows x64, CPython 3.12.14, uv 0.12.12, clean `.venv` from `install.py`.

Synthetic probe against a real `dendrite serve` mock daemon on 127.0.0.1 (raw
socket requests; no browser, no DNS rebinding attack, no network scan):

| Request | Before (main) | After |
|---|---|---|
| Start `serve` on loopback without token | starts | exits 2 |
| `GET /v1/node`, no token, Host `127.0.0.1:port` | 200 | 401 |
| `GET /v1/node`, no token, Host `attacker.example:port` + Origin | 200 | 400 |
| `POST /v1/execute`, no token, Host `attacker.example:port` | 200 | 400 |
| `GET /healthz`, Host `attacker.example:port` | 200 (returns node_id) | 400 |
| `GET /v1/node`, valid token, Host `127.0.0.1:port` | 200 | 200 |
| `GET /v1/node`, valid token, Host `attacker.example:port` | 200 | 400 |

`test_installation.py` now has 14 tests. The five new ones cover missing, wrong,
malformed and non-ASCII tokens on every protected route; 19 hostile or non-canonical
Host values (ports, IPv6, userinfo, trailing dot, numeric aliases); a hostile
Origin, `null` and a path-bearing Origin; the absence of CORS headers on a preflight;
derived and explicit remote-bind allow-lists, including IPv6 and proxy Host without
a port; and invalid `allowed_hosts` entries. The daemon test also sends raw
duplicate, missing and hostile Host headers. All 14 pass on the patched tree.
Run against the unpatched upstream `api.py`/`config.py`, the new tests record
33 failures and 1 error (the non-ASCII token raised a 500).

`verify_vendor.py --check-patches` reverses the recorded patch in an isolated
temporary tree and reproduces both upstream SHA-256 values. `--restore-from` a
fresh public EIF clone at the pinned commit rebuilds byte-identical patched
files. An appended byte is detected as a hash mismatch.

Compatibility: the optional fabric bridge and control-plane heartbeat are outbound
clients and do not use these inbound routes. A network bind already required a
token; it now also requires `advertise_url` or `allowed_hosts`. Loopback quickstart
clients must send the bearer token. No native engine, model, inference or AIPSTER
connection was exercised.

## Local patch 0002: Ganglion fabric resident-only binding (2026-11-01)

Base: AIPSTER `d1de902eb90067459615714941ea048f719d9edd`. Branch
`claude/worker-ganglion-integration-20261101`. macOS arm64, CPython 3.12.13 with
pydantic 2.13.5, httpx 0.28.1, websockets 17.1, fastapi 0.141.1 and pytest from
an existing virtual environment. No package was installed and no model was
loaded or run. Tests import the vendored package via `PYTHONPATH` and run with
`PYTHONDONTWRITEBYTECODE=1` so the vendor allowlist stays byte-exact.

```text
cd local-worker
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$PWD/vendor/eif" python -m pytest \
  test_installation.py test_fabric_bridge.py -q \
  -k "not installed_cli and not mock_daemon_health_and_execution"
```

Result: **36 passed** on the patched tree (24 new fabric tests + 12 installation
tests, including `verify_vendor.py --check-patches`). The two deselected cases
resolve `dendrite`/the `dendrite` executable from the host environment rather than
this vendor tree, so they are not evidence for this patch. `verify_vendor.py`
reports 16 files against the pinned commit: 10 upstream-identical, 6 locally
patched (patch 0001: `api.py`, `config.py`; patch 0002: `fabric.py`, `node.py`,
`runtimes/base.py`, `runtimes/llama.py`). Reversing both patches reproduces the
upstream hashes, and forward-applying both to those upstream bytes reproduces the
committed files byte-for-byte.

The original patch author recorded **17 of 24 fail** (7 pass) for the same test
file with patch 0002 reversed in an isolated tree, covering job-id binding,
exact/resident admission, the under-lane residency guard, fingerprint-aware
managed residency, timeout and post-timeout behavior, permanent handshake/close
rejection, probe handling, connect-failure quarantine and fabric-job `last_error`
sanitization. **Those counts are an unverified historical author claim**: the
reversal log was not retained, and the prepared reproduction was deferred and not
executed, so nothing in this lane reproduces "17 of 24" at this candidate. What
was run here and is reproducible is `verify_vendor.py --check-patches` (exit 0),
which reverses both recorded patches in an isolated temporary tree and reproduces
the pinned upstream SHA-256 values.

The new tests use a local fake fabric WebSocket and the mock runtime only. They
cover: authenticated connect; one immediate heartbeat; resident-only capacity in
the cloud snapshot (including a changed model file identity); single result bound
to the job ID; duplicate suppression during and after execution and after a
capacity rejection; unknown model, capability mismatch, missing model, unknown
field and chat-frame denial before load; model-switch refusal; busy 429; timeout
504 with exactly one error and no local retry; disconnect cancellation with no
result; malformed/oversized/unknown frames; a single heartbeat loop; `probe_chat`
answered by a heartbeat with no result; no prompt or token in logs, error frames,
`last_error` or the local snapshot; permanent 401 handshake rejection without
retry; 4001 replacement and 4003 revocation stop states; and attach quarantine
only after an unanswered sent request, not after connect-phase failures.

The worker's cloud snapshot was also checked against the Ganglion reference
sanitizer and scheduler in the AiTinkerersVenice checkout at its then-HEAD
`f5223d39`, unmodified at the time of the check. That checkout's HEAD has since
advanced to `fe5ef6c07e3147debb33028629f77e29541531b5` (2026-11-01 08:46:05
-0800), so `f5223d39` is not that repository's current HEAD and this check was
not rerun here. Offline, `sanitizeNodeSnapshot` accepted both a resident and a
cold snapshot, and
`placementCandidates` returned the resident model while returning no placement
for the cold/non-resident model. That check used the existing `fabric` checkout's
`tsx` and a local JSON snapshot; no fabric connection or credential was used.

Limits: the deployed fabric was not contacted, no credential was read, no node
was enrolled, no live task or inference ran, and the AIPSTER dispatch path remains
absent. The Ganglion contract has no streaming, cancel frame or transmitted
deadline, so the worker enforces only its local request timeout; this is recorded
in [EXECUTION-GAPS.md](EXECUTION-GAPS.md).

### Carried forward onto `origin/main`

The patch-0002 work above was authored on `d1de902eb90067459615714941ea048f719d9edd`.
PR #62 could not merge as-is, so it was reconciled onto
`origin/main f6e45f556a48dd5f75a8e8b90992e8d9cfa0393e` as
`9c2c479caa87e8a555482278095f72d7c1a37bcb` (local only). In that reconcile the
eight patch-0002 artifacts — `patches/0002-fabric-resident-binding.patch`,
`provenance.json`, `test_fabric_bridge.py`, `vendor/eif/NOTICE` and the four
patched `vendor/eif/dendrite` modules — are byte-identical to the reviewed tree,
while `pairing.py` and its lifecycle tests stay on the newer `origin/main` R4
sender-lock work. An independent coordinator re-ran `test_fabric_bridge.py`
against a local fake fabric and mock runtime at `9c2c479`. That run is recorded
in `/private/tmp/aipster-mac-pr62-reconcile/COORDINATOR-FABRIC-VALIDATION.md`:
**24 passed in 4.20 s**, no live daemon, model, provider or credential. It
belongs to `9c2c479` and was not rerun at the successor candidate below; the
successor's own fabric evidence is its 36-passed run, which is a separate run at
a different commit.

A successor candidate on top of `9c2c479` restores the patch-0002 documentation
this section belongs to (`README.md`, `EXECUTION-GAPS.md`, `LICENSING.md` and this
file had been carried over from `main` without it, leaving the shipped
`LICENSING.md` change notice claiming a pre-patch file count) and adds
`test_docs_consistency.py`, which fails on `9c2c479` and passes here. Offline
results at that candidate, all run serially under the shared heavy-test lock with
bytecode writes disabled and synthetic fixtures only:

```text
test_installation.py + test_fabric_bridge.py   36 passed, 2 deselected
test_docs_consistency.py                        5 passed
test_macos_lifecycle.py                        12 passed
test_sender_lock.py                             4 passed
test_pairing_lifecycle.py                      10 passed, 1 skipped (Windows-only)
test_pairing.py                                38 passed
verify_vendor.py --check-patches               16 files: 10 upstream-identical,
                                               6 locally patched
```

No package was installed; the interpreter was an existing CPython 3.12.13
virtual environment. The deployed fabric, a node enrollment, a Fabric Access
Token, a live model and the AIPSTER dispatch path were not touched.

A later documentation-only delta on that candidate changes no runtime, vendor or
provenance byte; it corrects report accuracy (initial `fabric.state`, the
`f5223d39` then-HEAD attribution, and the provenance of the reversal and
coordinator evidence). Those runs were therefore not repeated, and the only suite
rerun for the delta is `test_docs_consistency.py`.

`test_docs_consistency.py` is a bounded structural check: it asserts headings,
recorded counts, patch names and limit vocabulary across the four documents. It
does not execute the worker, verify semantic or security truth, or catch an
omission such as a missing state name in a prose list. Passing it means the
documentation is internally consistent with `provenance.json`; it is not a
complete truth proof.

One vendor documentation limitation is left unchanged: the comment at
`vendor/eif/dendrite/node.py:36` calls the fabric block "local operator
visibility only", which is misleading after the activated security work even
though the block itself is secret-free. Editing vendor bytes would require a
provenance bump, so it is recorded here rather than changed.

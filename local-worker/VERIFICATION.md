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

Result: **32 passed** on the patched tree (20 new fabric tests + 12 installation
tests, including `verify_vendor.py --check-patches`). The two deselected cases
resolve `dendrite`/the `dendrite` executable from the host environment rather than
this vendor tree, so they are not evidence for this patch. `verify_vendor.py`
reports 16 files against the pinned commit: 10 upstream-identical, 6 locally
patched (patch 0001: `api.py`, `config.py`; patch 0002: `fabric.py`, `node.py`,
`runtimes/base.py`, `runtimes/llama.py`). Reversing both patches reproduces the
upstream hashes.

Against the same test file with patch 0002 reversed in an isolated tree, **13 of
20 fail** and 7 pass. The failures cover job-id binding, exact/resident admission,
the under-lane residency guard, timeout and post-timeout behavior, permanent
handshake/close rejection, and attach-quarantine scoping. They are the
falsifiable before/after evidence for this patch.

The new tests use a local fake fabric WebSocket and the mock runtime only. They
cover: authenticated connect; one immediate heartbeat; resident-only capacity in
the cloud snapshot; single result bound to the job ID; duplicate suppression
during and after execution; unknown model, capability mismatch, missing model and
unknown field denial before load; model-switch refusal; busy 429; timeout 504 with
exactly one error and no local retry; disconnect cancellation with no result;
malformed/oversized/unknown frames; a single heartbeat loop; no prompt or token in
logs or error frames; permanent 401 handshake rejection without retry; 4001
replacement and 4003 revocation stop states; and attach quarantine only after an
unanswered sent request.

Limits: the deployed fabric was not contacted, no credential was read, no node
was enrolled, no live task or inference ran, and the AIPSTER dispatch path remains
absent. The Ganglion contract has no streaming, cancel frame or transmitted
deadline, so the worker enforces only its local request timeout; this is recorded
in [EXECUTION-GAPS.md](EXECUTION-GAPS.md).

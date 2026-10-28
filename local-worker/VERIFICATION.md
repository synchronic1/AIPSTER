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

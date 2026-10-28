# Standalone local worker

This fork includes the public Dendrite worker source; no EIF checkout, private
Gitea access, API credentials, native binary or model download is needed for the
mock quickstart. This is a standalone installation, **not an AIPSTER execution
connection**. `/api/jobs` remains disabled. Mock output is explicitly simulated.

## Tested installation

Windows x64, CPython **3.12.14**, uv **0.12.12**. The upstream package declares
Python >=3.11, but this installation is qualified only on the version above.
Linux/macOS commands below are provided for adaptation, not claimed tested support.
Native IK compilation and real model inference have not been tested in this PR.

Install Git and [uv 0.12.12](https://github.com/astral-sh/uv/releases/tag/0.12.12)
using the appropriate official release for your OS. Ensure `uv --version` reports
0.12.12. Obtain Python 3.12.14 using `uv python install 3.12.14` if needed.
Python and uv are prerequisites; they are not bundled.

From PowerShell, after this PR is integrated (until then clone its branch):

```powershell
git clone https://github.com/synchronic1/AIPSTER.git
cd AIPSTER/local-worker
uv run --no-project --python 3.12.14 python install.py
.\.venv\Scripts\dendrite.exe inspect --config configs/mock.toml
.\.venv\Scripts\python.exe test_installation.py
.\.venv\Scripts\dendrite.exe serve --config configs/mock.toml
```

The installer verifies every vendored source hash, refuses an existing `.venv`,
installs hash-locked wheels from public PyPI, builds the local package offline
with pinned build dependencies, and checks installed dependency compatibility.
It disables inherited package indexes, uv configuration, saved uv credentials,
netrc and keyring lookup for installation. No secrets are needed or requested.
Network access to public Python distribution/PyPI hosts is required on first use.
The locks pin dependency artifacts, not a bit-for-bit native build or a promise
that upstream distribution hosts will remain available.

In a second terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:8090/healthz
Invoke-RestMethod http://127.0.0.1:8090/v1/node
Invoke-RestMethod -Method Post http://127.0.0.1:8090/v1/execute -ContentType application/json -Body '{"capability":"summarize","model_id":"mock-summary","prompt":"Synthetic installation check","max_tokens":16}'
```

Expect `status=ok` and `simulated=true` on execution. `/healthz` checks daemon
liveness only. It does not prove that a real model/engine is installed or ready.
`/v1/node` exposes local machine information; use loopback on a trusted single-user
machine. Loopback without a token is not isolation from other local users.
Do not expose this old worker to a network or configure its optional cloud bridge
as part of this quickstart. No AIPSTER token/endpoint belongs in these examples.

For Unix shells, the corresponding entry points are `.venv/bin/python` and
`.venv/bin/dendrite`. Those platforms require their own clean-install retest.

## Optional real engine preparation (not needed for the mock check)

The worker does not contain llama-server. The separately obtained native source
pin is `ikawrakow/ik_llama.cpp` commit
`3bb386eb68ffee0a5dc7db21da0735d594929eeb`. Its root license is MIT, with ggml,
llama.cpp and ik_llama.cpp authors credited; dependencies retain their notices.
See the pinned [license](https://github.com/ikawrakow/ik_llama.cpp/blob/3bb386eb68ffee0a5dc7db21da0735d594929eeb/LICENSE)
and [build instructions](https://github.com/ikawrakow/ik_llama.cpp/blob/3bb386eb68ffee0a5dc7db21da0735d594929eeb/docs/build.md).
Source inspection establishes CMake >=3.14 and a C++17 compiler; Windows needs
an appropriate C++ build environment. CUDA is optional for NVIDIA acceleration,
not a prerequisite for a CPU-only build. Example CPU-only configuration:

```text
git clone https://github.com/ikawrakow/ik_llama.cpp.git
cd ik_llama.cpp
git checkout --detach 3bb386eb68ffee0a5dc7db21da0735d594929eeb
cmake -S . -B build-cpu -DGGML_CUDA=OFF -DGGML_METAL=OFF -DGGML_VULKAN=OFF -DLLAMA_CURL=OFF -DLLAMA_BUILD_SERVER=ON
cmake --build build-cpu --config Release --target llama-server
```

These native build commands were checked against public source, not executed.
Place the resulting executable on PATH or set a forward-slash absolute path in
`configs/cpu.toml`. For Windows multi-config builds inspect `build-cpu/bin/Release`;
other generators commonly use `build-cpu/bin`. Verify your actual output path.
GPU backends must remain disabled for this CPU-first example. Optional GPU builds
require upstream-supported hardware/toolkits and a separate configuration;
neither GPU operation nor AIPSTER GPU placement is qualified here.

Acquire a compatible GGUF separately from a model publisher, accept that model's
own terms, verify its published digest and architecture support at the pinned IK
revision, and set the local `path` in `configs/cpu.toml`. No particular model or
redistribution right is implied. Do not use the tiny GGUF-magic test fixture as a
model. Available RAM must cover weights plus KV cache, context and runtime overhead;
there is no universal RAM minimum without selecting a model and quantization.
The mock check needs no GPU or model storage; allow roughly 1 GiB free disk/RAM
for tooling as a conservative planning allowance, not a measured minimum.

`dendrite inspect --config configs/cpu.toml` reports availability without loading a
managed model. `serve` starts the daemon; an explicit load/execute request would
start real inference, outside this PR's verification. Do not infer CPU confinement
from `gpu_layers=0`: the public worker lacks the newer device/KV/environment controls.

## Stop, uninstall and troubleshoot

Stop the foreground server with Ctrl+C and verify the port is closed. Managed
engines are stopped on normal daemon shutdown; attach mode does not own its server.
After stopping, uninstall by deleting only this checkout's `local-worker/.venv`
and optional `local-worker/.state`. Keep models/engines you installed separately
unless you deliberately choose to remove them. The installer changes no service,
startup task, global Python package or cloud configuration.

| Symptom | Action |
|---|---|
| Existing `.venv` | Use a fresh clone, or stop the daemon and remove that exact local venv. |
| uv version mismatch | Install the pinned uv release; do not silently update the lock. |
| Hash mismatch | Restore from the exact public commit using `verify_vendor.py`; investigate changes. |
| Port 8090 occupied | Stop the old instance or choose a free loopback port in the config. |
| Invalid TOML/unknown field | CLI exits 2; use the provided strict examples. |
| Model unavailable | Check real GGUF path/magic and engine PATH; daemon health alone is insufficient. |
| Runtime binary not found | Set the actual compiled executable path; no automatic native download occurs. |
| TLS/index failure | Check access to public PyPI; installer deliberately ignores private indexes/proxies. |

## Provenance and updates

`vendor/eif` has 14 upstream Python modules plus original `pyproject.toml` and
`uv.lock`, copied byte-for-byte from public EIF
`536508832b12d993dc272e03d4f09aca53801f68`. `provenance.json` is the allowlist and
SHA-256 record. All modules are retained because CLI/API imports transitively use
them, including the optional fabric bridge; no separate server/scheduler, Oxen
tools, tests, machine configs, private history or binaries are copied. Sanitized
configs and installation tests live outside the vendor directory. Runtime logic
is not forked into a second implementation.

Verify: `python verify_vendor.py`. Restore exact pinned files only:
`python verify_vendor.py --restore-from PATH_TO_PUBLIC_EIF_CLONE`.
For an update, review the new public commit, every allowlisted diff, new imports,
rights and notices; deliberately update the pin/hashes in a PR. The restore tool
does not automatically follow a branch or accept new hashes. Regenerate
`requirements.lock` with uv 0.12.12 `uv export --locked --no-dev --no-emit-project
--format requirements-txt --project vendor/eif --output-file requirements.lock
--no-config`; regenerate build dependencies with `uv pip compile
build-requirements.in --generate-hashes --output-file build-requirements.lock`.
Review public indexes, license metadata and artifact hashes, then repeat a clean
installation and synthetic tests. Do not hand-patch vendor scheduling/auth logic.

See [licensing findings](LICENSING.md), [execution gaps](EXECUTION-GAPS.md), and
[verification evidence](VERIFICATION.md).

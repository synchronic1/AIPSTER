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

From PowerShell in a fresh directory (these commands match the tested Windows x64 setup):

```powershell
git clone --filter=blob:none --no-checkout https://github.com/synchronic1/AIPSTER.git
cd AIPSTER
git sparse-checkout set --no-cone /local-worker/ /LICENSE
git fetch origin 3fa309cb08461ea046ee23e801404911c1f3bcc2
git checkout --detach 3fa309cb08461ea046ee23e801404911c1f3bcc2
cd local-worker
uv run --no-project --python 3.12.14 python install.py
.\.venv\Scripts\dendrite.exe inspect --config configs/mock.toml
.\.venv\Scripts\python.exe test_installation.py
$env:DENDRITE_API_TOKEN = .\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(32))"
.\.venv\Scripts\dendrite.exe serve --config configs/mock.toml
```

The sparse checkout contains the worker and the root `LICENSE` only; the latter
is required by [the licensing record](LICENSING.md). The worker code is checked
out at the reviewed, security-fixed revision above, while this README and the
linked evidence can be updated independently.

`serve` refuses to start without `DENDRITE_API_TOKEN` (at least 32 characters),
including on loopback. Generate a fresh random value per machine; do not reuse a
cloud or AIPSTER credential. `inspect` and the tests need no token.

The installer verifies every vendored source hash, refuses an existing `.venv`,
installs hash-locked wheels from public PyPI, builds the local package offline
with pinned build dependencies, and checks installed dependency compatibility.
It disables inherited package indexes, uv configuration, saved uv credentials,
netrc and keyring lookup for installation. No secrets are needed or requested.
Network access to public Python distribution/PyPI hosts is required on first use.
The locks pin dependency artifacts, not a bit-for-bit native build or a promise
that upstream distribution hosts will remain available.

## Update an existing source install

Use this procedure when the checkout already has local changes from a reviewed
pairing overlay (for example, an `f3e115e` checkout with the `adfe357`
`pairing.py` compatibility fix applied by hand). A plain `git checkout` would
abort on those local changes; the hash gate below verifies the overlay is
exactly the reviewed file before discarding it. Run the `git` steps from the
`AIPSTER` repo root (the directory above `local-worker`):

```powershell
git status --short
```

Continue only if the single modified file is `local-worker/pairing.py`. If
anything else changed, back it up and use a fresh clone instead.

1. Stop the running `heartbeat-loop` sender terminal with Ctrl+C. Old senders
   hold no lock, so confirm only one sender runs afterwards.
2. Fetch the reviewed revision (current pin `3fa309c`):
```powershell
git fetch origin 3fa309cb08461ea046ee23e801404911c1f3bcc2
```
3. Hash-gate the overlay: the LF-normalized local `pairing.py` must equal the
   reviewed blob:
```powershell
$blob = .\local-worker\.venv\Scripts\python.exe -c "import hashlib,pathlib;b=pathlib.Path('local-worker/pairing.py').read_bytes().replace(b'\r\n',b'\n');print(hashlib.sha1(b'blob '+str(len(b)).encode()+b'\x00'+b).hexdigest())"
$want = git rev-parse 3fa309cb08461ea046ee23e801404911c1f3bcc2:local-worker/pairing.py
if ($blob.Trim() -ne $want.Trim()) { Write-Output 'STOP: pairing.py does not match the reviewed overlay; use a fresh clone instead' }
```
   If it prints STOP, do not continue; use a fresh clone.
4. Discard the verified overlay:
```powershell
git checkout -- local-worker/pairing.py
```
5. Move to the reviewed revision:
```powershell
git checkout --detach 3fa309cb08461ea046ee23e801404911c1f3bcc2
```
6. Keep `.venv` and do not rerun `install.py`: there are no lock or vendor
   changes between `f3e115e` and `3fa309c`.
7. Restart one `heartbeat-loop` sender from `local-worker`. Pairing state
   lives in `%LOCALAPPDATA%\AIPSTER-Worker` and survives the update.

## Pairing with AIPSTER

Installing never shares anything. To link this computer to your AIPSTER
account, sign in to the dashboard, open My Compute, and use Pair this
computer to mint a one-time code (10-minute expiry, single use). In a second
terminal in this same `local-worker` directory, run:

```powershell
.\.venv\Scripts\python.exe pairing.py pair
```

Type the code when prompted (it is not echoed). Do not paste it or the stored
sender key into an agent conversation. Pairing registers this computer and
stores a sender key privately. It exits without starting the sender. Explicitly
start it in that terminal, next to the daemon's `serve` terminal:

```powershell
.\.venv\Scripts\python.exe pairing.py heartbeat-loop --config configs/mock.toml
```

Mock always reports `usable=false`. Heartbeats prove reachability only, never
inference readiness; `/api/jobs` remains disabled. Choose Done or reopen My
Compute after pairing to refresh the resource list. If the key is revoked or
expires, the sender exits asking for a fresh pairing code. `pairing.py status`
shows secret-free local status and marks old success as stale.

No packaged installer is published yet: the built 0.1.0 package predates the
API edge-compat fix and will not be published, so tray pairing arrives with
the next published qualified installer. Until then, packaged installs cannot
pair; use this source checkout. The published installer will supervise the
heartbeat sender while serving and show the pairing overlay (unpaired /
registered / reachable / stale / repair-required) in the menu and
`aipster-worker tray status`. A busy daemon port never blocks pairing or the
sender: they need no local port. When AIPSTER publishes a qualified
installer, update packaged installs by reinstalling from its reviewed pin
(uninstall preserves pairing by default).
Status belongs to the selected pairing generation: a previous sender's status,
including an in-flight response finishing after re-pairing, is not attributed
to the new key or resource. Unbound older status records await a fresh heartbeat.

To disconnect, stop both sender and daemon terminals with Ctrl+C, discard the
worker-local daemon token, and revoke this resource's heartbeat key in the
dashboard Keys panel. Then forget local pairing:

```powershell
.\.venv\Scripts\python.exe pairing.py unpair
```

Local unpair does not revoke the server key. Deleting `.venv` or `.state` alone
does not remove private pairing credentials from the worker data directory.
If any pairing file cannot be removed, unpair exits nonzero and reports
incomplete cleanup. Stop the sender or other process holding the file, revoke
the server key, and retry; an already missing file is harmless.
Preserve unrelated models and engines. This source setup adds no startup task,
service or automatic update. Packaged-install tray pairing will be documented
with the published installer.
See [pairing/storage integration details](PAIRING-INTEGRATION.md). For unqualified
POSIX adaptation the corresponding Python entry point is `.venv/bin/python`.

## Serving inference jobs (dark by default)

This checkout can run *leased* inference jobs for its paired resource against a
local upstream (Ganglion or llama-server — any OpenAI `/v1`-shaped local server
that lists its models works). It is dark by default in both directions: nothing runs unless you start
it here, and the server keeps `POST /api/jobs` at `INFERENCE_DISABLED` (every
worker job route 404s) unless `INFERENCE_ENABLED` is set. No live deployment,
live job route or live inference was exercised to add this; see
[execution gaps](EXECUTION-GAPS.md).

Prerequisites:

- a paired worker (`pairing.py pair`) whose heartbeat key is bound to a
  resource; the same private credential is reused, never copied or re-minted;
- a running upstream — Ganglion or, on macOS, a plain `llama-server` — on
  `http://127.0.0.1:8471` (or `AIPSTER_GANGLION_URL`, `--upstream-url`,
  `--ganglion-base`). The address must be loopback unless you pass
  `--allow-non-loopback-ganglion`; remote mode is not qualified.
- if your upstream requires a token, set `AIPSTER_GANGLION_TOKEN` in the
  environment. Do not put it on a command line, in a config file or in pairing
  state.

```powershell
.\.venv\Scripts\python.exe pairing.py serve-jobs --once   # one poll cycle, then exit
.\.venv\Scripts\python.exe pairing.py serve-jobs          # keep serving (Ctrl+C)
```

| Flag | Meaning |
|---|---|
| `--upstream-url URL` | Upstream base URL (default `http://127.0.0.1:8471`, or `AIPSTER_GANGLION_URL`). `--ganglion-base` is an alias |
| `--runtime-id ID` | Runtime this worker claims: `ganglion` (default) or `llama-server`. Anything else exits 2 |
| `--allow-non-loopback-ganglion` | Permit a non-loopback upstream base. Unqualified; refuses otherwise |
| `--interval SECONDS` | Base idle poll interval (default 2). Grows while idle, capped at 30 |
| `--models-cache-ttl SECONDS` | How long the upstream model list is cached (default 30) |
| `--once` | Poll once and exit; still takes the single-runner lock |

Per job the runner: leases one job from `GET /api/worker/jobs/next` with the
stored heartbeat key; validates the leased envelope strictly; checks the model
against the upstream `GET /v1/models`; then makes one non-streaming
`POST /v1/completions` (`temperature: 0`, timeout = the deadline minus now, no
redirects, no retries) and posts `{lease_id, status, result}` to
`POST /api/worker/jobs/:job_id/result`. A `404` on completions means the route
does not exist, so one single-message `/v1/chat/completions` fallback is tried;
every other failure is final. Behaviour is identical against either upstream;
only the runtime identity you configure changes.

The lease frame is `{job_id, lease_id, envelope, deadline_at}`: `job_id` and
`lease_id` are opaque strings and `deadline_at` is integer Unix milliseconds.
The envelope is nested, as the coordinator builds it
(`website/src/inference/dispatch-coordinator.mjs`):

```
{ protocol: "aipster-bound-cpu-internal/1",
  task: { capability: "complete", model_id, prompt, max_tokens, temperature: 0,
          allow_simulated: false, idempotency_key,
          placement: { device: "cpu", node_id, runtime_id: "ganglion" } },
  binding: { op_id, generation, runtime_instance, model_fingerprint, deadline_at } }
```

`protocol` must match exactly; `task` is validated field by field
(`capability` `complete`, `placement.device` `cpu`, node id equal to this
resource, runtime id equal to the configured `--runtime-id` — `ganglion` or
`llama-server` — model, prompt, `max_tokens` 1..4096, `temperature` present
and 0, `allow_simulated` present and false, no unknown fields); `binding` must
carry exactly those five fields, with `binding.deadline_at` equal to the lease
`deadline_at` and in the future. There is no flat-envelope form: an envelope
without the protocol wrapper is refused.

A failure is always reported as `failed` with a stable `reason`
(`ENVELOPE_INVALID`, `MODEL_UNAVAILABLE`, `GANGLION_UNAVAILABLE`,
`GANGLION_HTTP_ERROR`, `GANGLION_TIMEOUT`, `GANGLION_INVALID_RESPONSE`,
`EMPTY_CONTENT`, `DEADLINE_EXCEEDED`) and no content, so it can never be
mistaken for a successful result. The failed result is exactly
`{reason, detail?, elapsed_ms?, usage?, cache?}` — no request, node, runtime,
model, `simulated` or `content` field, because a failure claims nothing about
the job's identity. A success is exactly
`{request_id, node_id, runtime_id, model_id, runtime_instance,
model_fingerprint, simulated: false, content, elapsed_ms, usage, cache}`;
`runtime_id` is the configured runtime identity, and `runtime_instance` and
`model_fingerprint` are echoed from the lease binding — never invented. Both
shapes match L2's validator in `website/src/inference/worker-transport.mjs`.

Before calling the upstream the job id is written to a private started-job ledger
(`jobs-started.json` in the worker data dir). A job whose result post was never
confirmed is therefore not re-executed after a restart: the outcome stays
uncertain instead of being guessed. Only one `serve-jobs` runs per data dir
(`jobs.lock`); a second one exits 6, matching the heartbeat sender's
`SENDER_RUNNING`. A revoked key exits 4 (pairing again required); a malformed
lease frame or unreadable ledger exits 2; five consecutive transport/5xx
failures exit 5. Prompts and completions are never logged, and neither the
heartbeat key nor the Ganglion token is printed.

On macOS and other POSIX systems `serve-jobs` stops on `SIGTERM` or `SIGINT`
(the signal launchd and Ctrl+C send): the request is recorded, a completion
already handed to Ganglion is allowed to finish and report, and the process
then exits 0 without re-running anything. A second signal restores the default
action, so a wedged upstream can still be killed. The job lock is created
user-only (`0600`) and opened without following symlinks; a lock path that
cannot be used exits 2 rather than being misreported as a second runner.

`status`, `heartbeat-once`/`heartbeat-loop`, `pair` and `unpair` are unchanged,
and heartbeats still prove reachability only: `usable` stays false for the mock
config, and running jobs here does not change what the dashboard reports.

In a second terminal, set `$env:DENDRITE_API_TOKEN` to the same value, then:

```powershell
$auth = @{ Authorization = "Bearer $env:DENDRITE_API_TOKEN" }
Invoke-RestMethod http://127.0.0.1:8090/healthz
Invoke-RestMethod http://127.0.0.1:8090/v1/node -Headers $auth
Invoke-RestMethod -Method Post http://127.0.0.1:8090/v1/execute -Headers $auth -ContentType application/json -Body '{"capability":"summarize","model_id":"mock-summary","prompt":"Synthetic installation check","max_tokens":16}'
```

Expect `status=ok` and `simulated=true` on execution. `/healthz` is the only
unauthenticated route: it checks daemon liveness, returns no node identity, and
does not prove that a real model/engine is installed or ready. Every other route
returns 401 without the bearer token. `/v1/node` exposes local machine information;
keep the token private and use loopback on a trusted machine.

Requests must name an allowed `Host`. On a loopback bind that is exactly
`127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`; anything else (for example
a DNS-rebound `attacker.example:<port>`) gets 400 before authentication runs. A
browser `Origin` header, when present, must also be one of those authorities or the
request gets 403. The API sends no CORS headers, so other web origins cannot read
responses. A network bind additionally needs `advertise_url` or an explicit
`[node] allowed_hosts = ["worker.lan:8090"]` (exact `host[:port]` values; no
wildcards), or `serve` refuses to start. Derived Origins are scheme-exact:
`http://` for the daemon's own addresses and the `advertise_url` scheme for
that name. Explicit `allowed_hosts` accept both `http://` and `https://` Origins.
Explicit entries *replace* the derived defaults. So a loopback daemon behind a
proxy or tunnel that forwards the public Host must list that name **and** the
loopback names, e.g. `["worker.example.com", "127.0.0.1:8090", "localhost:8090"]`.
`advertise_url` alone does not add a name to a loopback bind.
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
| `serve` exits 2 asking for `DENDRITE_API_TOKEN` | Set a fresh random value of at least 32 characters (see quickstart). |
| 401 from `/v1/...` | Send `Authorization: Bearer <token>` with the exact token the daemon started with. |
| 400 `Host not allowed` / 403 `Origin not allowed` | Use `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`; for a network bind set `advertise_url` or `allowed_hosts`. |
| Model unavailable | Check real GGUF path/magic and engine PATH; daemon health alone is insufficient. |
| Runtime binary not found | Set the actual compiled executable path; no automatic native download occurs. |
| TLS/index failure | Check access to public PyPI; installer deliberately ignores private indexes/proxies. |

## Provenance and updates

`vendor/eif` has 14 upstream Python modules plus original `pyproject.toml` and
`uv.lock` from public EIF `536508832b12d993dc272e03d4f09aca53801f68`. Fourteen
files are byte-for-byte upstream. `dendrite/api.py` and `dendrite/config.py` carry
AIPSTER local patch [0001](patches/0001-require-token-and-validate-host.patch),
a security fix that requires the API token on every bind and validates Host/Origin.
Each patched file has a change notice at the top. `provenance.json` is the
allowlist and SHA-256 record: `upstream_sha256` identifies the pinned upstream
bytes and `sha256` the patched bytes in this tree. The patch is not upstream. All modules are retained because CLI/API imports transitively use
them, including the optional fabric bridge; no separate server/scheduler, Oxen
tools, tests, machine configs, private history or binaries are copied. Sanitized
configs and installation tests live outside the vendor directory. Runtime logic
is not forked into a second implementation.

Verify: `python verify_vendor.py` (add `--check-patches` to prove that reversing
the recorded patches reproduces the upstream hashes; needs Git). Restore from the
exact pinned commit and reapply the recorded patches:
`python verify_vendor.py --restore-from PATH_TO_PUBLIC_EIF_CLONE`.
For an update, review the new public commit, every allowlisted diff, new imports,
rights and notices; deliberately update the pin/hashes in a PR. The restore tool
does not automatically follow a branch or accept new hashes. Regenerate
`requirements.lock` with uv 0.12.12 `uv export --locked --no-dev --no-emit-project
--format requirements-txt --project vendor/eif --output-file requirements.lock
--no-config`; regenerate build dependencies with `uv pip compile
build-requirements.in --generate-hashes --output-file build-requirements.lock`.
Review public indexes, license metadata and artifact hashes, then repeat a clean
installation and synthetic tests. Do not hand-patch vendor files: any change goes
in a new numbered file under `patches/`, recorded in `provenance.json` with
upstream and patched hashes, and the vendored files keep their change notices.
On an upstream update, rebase or retire each patch and re-verify.

See [licensing findings](LICENSING.md), [execution gaps](EXECUTION-GAPS.md), and
[verification evidence](VERIFICATION.md).

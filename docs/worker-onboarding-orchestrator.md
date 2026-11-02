# Worker onboarding orchestrator (candidate)

Status: implementation candidate on `codex/worker-onboarding-20261101`, based on
`974a345206c2ca06954c42a069b2da6e3b547ea1`. It is **not published**, not wired
into the published setup packet, and not a claim that a live worker, model, or
inference path has been qualified. Windows x64 is the only qualified platform;
macOS and Linux remain explicitly experimental.

## One command

From a worker checkout:

```sh
cd local-worker
./setup-worker.sh run --packet-stdin
```

The packet (the same v2 packet shown in AIPSTER) is fed on stdin. The helper
extracts exactly one `PAIRING CODE:` field; the code is never accepted as an
argument. A pipe or a private terminal prompt is required. Do not use a shell
here-document that puts the code in shell history.

Windows x64:

```powershell
cd local-worker
.\setup-worker.ps1 run --packet-stdin
```

Direct (advanced; the caller must already have a usable `uv 0.12.12`):

```sh
python3 setup_worker.py run --packet-stdin \
  --data-dir "$HOME/.local/share/aipster-worker" \
  --allow-unqualified-platform   # only on macOS/Linux
```

Other commands: `check`, `install`, `pair`, `start`, `verify`, `status`.
`run` is `check -> install -> pair -> start -> verify`.

## Phases and resumability

| Phase | What it does | Re-entry behavior |
|---|---|---|
| `check` | platform, Python >= 3.9, loopback config, `uv 0.12.12`, >= 1 GiB disk, checkout files | read-only; no state write |
| `install` | runs the reviewed `install.py` once | existing complete `.venv` is skipped; partial `.venv` fails and is never deleted |
| `pair` | calls `pairing.cmd_pair` in-process; stores the heartbeat credential privately | an existing valid pairing is preserved and does not consume a code |
| `start` | one daemon, one sender; verifies an existing instance first | a healthy matching daemon is reused; the sender's own lock prevents duplicates |
| `verify` | health, node identity, heartbeat freshness, optional explicit inference | reports each fact separately; no inference by default |

If pairing was interrupted or its outcome is unknown, the next `run` stops with
exit 4 and asks the operator to check AIPSTER status/dashboard. Only an explicit
`--retry-pair` allows a new code. This avoids burning a single-use code blindly.

State is a private, non-secret `setup-state.json` under the worker data dir:

```json
{
  "schema": "aipster-worker-setup/1",
  "updated_at": "2026-11-01T00:00:00Z",
  "phases": {
    "check":  {"state": "passed", "at": "..."},
    "install":{"state": "passed", "at": "..."},
    "pair":   {"state": "in_progress", "at": "..."},
    "start":  {"state": "partial", "at": "..."},
    "verify": {"state": "passed", "at": "...", "inference": "not-exercised"}
  },
  "processes": {
    "daemon": {"pid": 1234, "origin": "http://127.0.0.1:8090", "log": "..."},
    "sender": {"pid": 1235, "log": "..."}
  }
}
```

No code, token, or heartbeat key is written to state, output, argv, or logs by
the orchestrator. A corrupt state file is reported and replaced with a fresh
non-secret record; it never blocks a safe retry.

## Private pairing code and token

Code sources (mutually exclusive):

* `--packet-stdin` — read a bounded setup packet from a pipe; extract one field.
* `--code-stdin` — one line from a pipe, or a no-echo `getpass` prompt on a TTY.
* `--code-fd N` — read from an inherited descriptor.

There is deliberately no `--code`. Validation rejects whitespace, control
characters, shell syntax, overlength values, missing/ambiguous packet fields,
and non-TTY packet reads. The code is passed to `pairing.cmd_pair` in memory by
constructing its argparse namespace directly.

The daemon token is created/reused through
`packaging/aipster_tray/firstrun.ensure_private_token` (0600 / Windows user ACL)
and passed only in the daemon child environment. It is never printed.

## Redaction and process logs

`setup_worker.register_secret()` records values actually handled in memory
(pairing code, daemon token, heartbeat key). `redact()` removes those exact
values plus `aip_live_*`/`aip_test_*` and `Bearer ...` shapes. `--debug` prints
a sanitized traceback: frame file/line/function and the exception type, never
the raw traceback or unredacted exception text.

Daemon and sender stdout/stderr go to owner-only files under `data/logs`, and
the orchestrator displays only a bounded tail with known values redacted.
Owner-only storage is necessary but **not a guarantee that a child program
never writes a secret to its own log**. The regression test deliberately writes
a synthetic heartbeat key into a child log and asserts that the displayed tail
is redacted while the private file still contains it. Treat the log directory as
private diagnostic state, not as publishable evidence.

## Private uv bootstrap (HOLD, not in this candidate)

The first candidate requires an existing `uv 0.12.12`; the wrappers fail closed
with exit 3 if it is missing or different. They do not install or upgrade a
global tool. Private pinned-uv cold-start bootstrap is explicitly **HOLD** and
is being developed as a separate follow-up commit on the same branch. Until
that commit lands and its synthetic archive/digest/runner tests pass, this
candidate must not advertise one-command cold-start completion: a machine with
no suitable uv still needs an operator-provided uv 0.12.12.

## Dependency-injection contract (for QA)

Construct one session; all hooks are optional and default to the real
implementation:

```python
Setup(
    root=Path, data_dir=Path, config=Path, api_base=str,
    name=None, allow_unqualified=False, retry_pair=False, verify_inference=False,
    runner=callable, spawner=callable, http=object, pairer=callable,
    token_provider=callable, sender_lock_probe=callable, which=callable,
    port_open=callable, platform_name=str, machine=str,
    sleep=callable, clock=callable, out=callable, err=callable,
    install_timeout=900.0, start_timeout=20.0, heartbeat_wait=15.0,
    poll_interval=0.25,
)
```

Hook shapes actually used by the implementation:

* `runner(argv, *, cwd, env, timeout, capture) -> object` with `returncode` and
  `stdout`; used for `uv --version` (`capture=True`) and `install.py`.
* `spawner(argv, *, cwd, env, log_path) -> handle` where `handle` has `pid`,
  `poll()`, `terminate()`, `wait(timeout=...)`; used for daemon/sender.
* `http.request(method, url, token=None, payload=None, timeout=...) ->
  (status, dict_body, detail)`; loopback-only in production.
* `pairer(code) -> int` replaces `pairing.cmd_pair`; `token_provider(create) ->
  Optional[str]`; `sender_lock_probe(data_dir) -> bool`; `which(name) -> path`;
  `port_open(host, port) -> bool`.
* `out(line)` / `err(line)` capture user-facing diagnostics.
* `clock()` / `sleep(seconds)` make bounded waits deterministic.

Public methods: `check()`, `install(report=None)`, `pair(code)`, `start(report=None)`,
`verify()`, `status()`, `run(code)`. Do not require private helper names.

Exit codes: `0` ok, `2` usage, `3` prerequisite/platform/install/token/daemon
start, `4` pairing/repair required, `5` network/uncertain, `75` another setup
process holds the lock, `130` interrupted.

## Runnable synthetic fixture driver

```sh
cd local-worker
python3 setup_worker_fixture.py                 # all scenarios, JSON to stdout
python3 setup_worker_fixture.py --scenario resume --json-out /tmp/report.json
```

Scenarios: `happy`, `resume`, `duplicate-sender`, `verify-honesty`. The driver
uses the real `Setup` methods and real `pairing.cmd_pair` against a loopback
fake claim API, with fake runner/spawner/HTTP. Every report is JSON with
`live_network=false`, `live_credentials=false`, `live_services=false`,
`live_inference=false`, per-check results, and a transcript. It is suitable for
a genuine Codex or Muse harness session: the harness runs the command, not a
simulated provider call, and no live credential or service is touched.

Expected current result: all four scenarios pass. Labels distinguish
`mock-simulated` from real inference; the default verify path prints
`inference=NOT EXERCISED`.

## Compatibility and manual approvals

* Windows x64: qualified code path; not exercised on a Windows host in this
  candidate's tests. PowerShell wrapper is statically checked only.
* macOS/Linux: experimental; the orchestrator requires
  `--allow-unqualified-platform`.
* First install needs network access to public PyPI and uses hash-locked
  wheels; `install.py` is reused, not duplicated. The uv bootstrap also needs
  network access to the official GitHub release.
* Pairing consumes a single-use code and creates a server-side resource.
  Unpairing locally does not revoke the server key; revoke it in AIPSTER Keys.
* `--verify-inference` is opt-in and sends one execute request. The default
  verification never exercises inference and never claims readiness.
* No automatic update, no service installation, no firewall/privacy-profile
  changes, and no global tool installation are performed.
* This candidate has not been pushed, published, or merged. No packet or
  `WORKER_COMMIT` pin was changed.

## Minimal future `app.js` packet change (not applied)

Precondition: the worker revision published in `WORKER_COMMIT` actually contains
`local-worker/setup-worker.sh`, `setup-worker.ps1`, `setup_worker.py`, and
`uv_bootstrap.py`. Until then, the published packet must keep the current
choreography; pointing it at unpublished files would be a false instruction.

Minimal contract for a separately claimed packet region:

1. Add a per-OS onboarding command next to `workerCommands(os)`:
   * POSIX: `./setup-worker.sh run --packet-stdin`
   * Windows: `.\setup-worker.ps1 run --packet-stdin`
2. Replace Steps 3–6 (`install`, token creation, two-terminal serve/verify,
   pairing/sender) with: run that one command and feed the packet through
   stdin, never as an argument. Keep the existing `PAIRING CODE:` field so the
   helper can extract it privately.
3. Keep Step 1 (inspect machine) and Step 7 (disconnect/uninstall). Keep the
   mock-vs-inference warning and the "running worker is not inference" text.
4. Require the agent to report the helper's phase results and exact exit code.
   A `verify` output of `inference=NOT EXERCISED` must not be presented as
   inference readiness.
5. Do not add a here-document or command substitution containing the code.
   If the agent cannot feed stdin privately, it must stop and report that,
   rather than placing the code in shell history.

## Not covered

No live pairing, enrollment, worker/model/sender start, inference, GMH/JJP
call, secret generation, publication, push, PR, merge, deploy, installer
packaging, or Windows/macOS/Linux end-to-end run was performed for this
candidate.

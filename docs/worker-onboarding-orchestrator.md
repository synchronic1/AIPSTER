# Worker onboarding orchestrator (candidate)

Status: implementation candidate on `codex/worker-onboarding-20261101`, based on
`974a345206c2ca06954c42a069b2da6e3b547ea1`. It is **not published**, not wired
into the published setup packet, and not a claim that a live worker, model, or
inference path has been qualified. Windows x64 is the only qualified platform;
macOS and Linux remain explicitly experimental.

**Cold-start claim:** the private uv bootstrap covers a missing or mismatched
`uv`, but it still needs a system Python 3.9+ to run. A host with neither a
suitable uv nor Python is a known unfinished edge, so this candidate does not
claim universal one-command cold-start completion.

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

## Target machine (ONB 04)

An assistant can run a command in its own sandbox or on another host. Before
the first mutation, `install`, `pair`, `start`, and `run` compute a machine
fingerprint from hostname + platform + architecture (never the checkout path)
and record it as `target` in the private checkpoint. Later runs on a different
machine stop with `TARGET_CHANGED` before touching pairing, install, or the
worker.

`--expect-target FINGERPRINT` asserts the machine the user selected. A mismatch
exits 2 with `TARGET_MISMATCH`, writes no checkpoint, runs no installer, and
spawns nothing. `check` prints the fingerprint but does not mutate, so an agent
can compare it with the machine the user chose before running `run`.


## Phases and resumability

| Phase | What it does | Re-entry behavior |
|---|---|---|
| `check` | platform, Python >= 3.9, loopback config, `uv 0.12.12`, >= 1 GiB disk, checkout files | read-only; no state write |
| `install` | runs the reviewed `install.py` once | existing complete `.venv` is skipped; partial `.venv` fails and is never deleted |
| `pair` | calls `pairing.cmd_pair` in-process; stores the heartbeat credential privately | an existing valid pairing is preserved and does not consume a code |

`run` reads the packet/code only after `install` completes and immediately
before the pairing claim, so slow prerequisite work cannot spend the
short-lived code's window. A blocked prerequisite never reads the code at all.

| `start` | one daemon, one sender; verifies an existing instance first | a healthy matching daemon is reused; the sender's own lock prevents duplicates |
| `verify` | health, node identity, heartbeat freshness, optional explicit inference | reports each fact separately; no inference by default |

`verify` prints the declared target and the five readiness facts separately on
every outcome, including failure:

```
verify: target=connection (usability and inference are separate facts)
verify: fact installed=yes (local .venv and dendrite)
verify: fact paired=yes (private pairing store)
verify: fact reachable=yes (fresh authenticated heartbeat at ...)
verify: fact usable=false (heartbeat usable flag; not proof of inference)
verify: fact inference-qualified=no (not exercised)
```

A connection target can therefore complete with `usable=false` and
`inference-qualified=no`. Simulated output is labelled `mock only`. A single
`--verify-inference` execute request is reported as exercised but never as
qualification.


If pairing was interrupted or its outcome is unknown, the next `run` stops with
exit 4 and asks the operator to check AIPSTER status/dashboard. Only an explicit
`--retry-pair` allows a new code. This avoids burning a single-use code blindly.

Reconciliation limit: the reviewed client (`local-worker/pairing.py`) exposes
only `POST /api/pairing/claim` and `POST /api/resources/{id}/heartbeat`; there
is no supported read or lookup endpoint, so this orchestrator cannot query
authoritative state itself and does not invent one. The authoritative check is
the operator's existing dashboard/status view, after which `--retry-pair`
resumes. Automating that lookup is a controller decision, not an onboarding
implementation decision.

## Checkpoint integrity (ONB 05 / ONB 06)

The private checkpoint (`setup-state.json`, `aipster-worker-setup/1`) is the
only record of which phases completed and whether a pairing claim may have
been sent. A damaged or foreign checkpoint is therefore **not** replaced by a
fresh record: doing that would forget a pending claim and let the next run
guess that a restart is safe.

Before any JSON is parsed, the checkpoint is opened with `lstat` plus
`O_NOFOLLOW`, rejected if it is a symlink or Windows reparse point, required to
be a regular file, and bounded to 4 MiB. Then:

| Condition | Result |
|---|---|
| missing or empty | a new record is created (normal first run) |
| unreadable, not regular, or oversized | blocked, exit 3, code `STATE_UNREADABLE` |
| invalid JSON | blocked, exit 3, code `STATE_UNREADABLE` |
| non-object, wrong `schema`, or malformed phase/process types | blocked, exit 3, code `STATE_SCHEMA` |
| symlink / reparse point | blocked, exit 3, code `STATE_SYMLINK` |

On every one of those blocks the file is left byte-for-byte unchanged, the
pairing store is untouched, and no installer, spawn, claim, or other network
request occurs. Prose and `--json` report the same code and exactly one next
action: keep the checkpoint for diagnosis, check AIPSTER status, move it aside
only after that check, then rerun. Valid checkpoints, including an
`in_progress` or `uncertain` pair phase, remain resumable exactly as before, so
this change cannot silently convert an unknown outcome into a clean one.

Constructor failures use the same stable path: `setup_worker.py --json` emits
one `aipster-worker-setup-status/1` document (never a traceback), and prose
prints a single sanitized `BLOCKED` line.

## Structured status (ONB 10)

`--json` replaces prose on stdout with exactly one versioned document
(`aipster-worker-setup-status/1`); diagnostics are suppressed in that mode so
an agent can parse stdout without scraping. The document agrees with the exit
code:

```json
{
  "schema": "aipster-worker-setup-status/1",
  "command": "verify",
  "target": "connection",
  "outcome": "complete",
  "stage": "verify",
  "exit_code": 0,
  "retryable": false,
  "next_action": null,
  "reason": null,
  "facts": {
    "installed": {"value": "yes", "source": "local .venv and dendrite"},
    "paired": {"value": "yes", "source": "private pairing store"},
    "reachable": {"value": "yes", "source": "fresh authenticated heartbeat", "observed_at": "..."},
    "usable": {"value": "false", "source": "last heartbeat flag", "authoritative": false},
    "inference_qualified": {"value": "no (not exercised)", "source": "not exercised"}
  },
  "observed_at": "2026-11-01T00:00:00Z"
}
```

Outcomes: `complete`, `blocked`, `incomplete`, `failed`, `cancelled`. Only a
blocked or incomplete result is `retryable`; a complete connection result has
`next_action: null` even when inference is unavailable. `usable.authoritative`
is always `false` until a controller readiness read exists. No token, code,
heartbeat key, or private path appears in the document.

`reason` is always present and has the same `{code, detail}` shape as the
pre-session document, so a client sees one schema with one shape. On failure it
uses the in-process block if one was recorded; otherwise it surfaces the
requested phase's blocking record, or the most recent blocked/uncertain phase.
A pending `pair` intent therefore reports `reason.code = "uncertain"` and the
`--retry-pair` recovery action from the `status` command instead of the generic
default. `detail` is redacted; a complete result has `reason: null`.

## Owned-resource rollback (ONB 24)

Rollback is **not implemented in this candidate** and is **BLOCKED** on the
reviewed Muse helper, not merely on its code existing. Muse candidate
`6894b772e049ee2270cfb6bb94964c731dc0f3ff` provides `setup_ownership.py` with
`create_ledger`, `claim_new_file`, `claim_new_process`, `rollback`, and
`redacted_diagnostics`, but root/QA have open safety findings on sampled
large-file hashes and external check/action races. No destructive automatic
cleanup is wired until that review closes; then the DeepSeek owner integrates
it here in a separate commit. Cancellation currently leaves the checkpoint and
reports residue; it deletes nothing.



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
the orchestrator. A corrupt or foreign state file is **not** replaced: it is
reported as a blocked diagnostic, left unchanged, and never treated as a safe
retry (see Checkpoint integrity).

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

An exception that escapes a phase is reported by **phase and exception type**
(`INTERNAL … RuntimeError during start; message suppressed`), never by its
message: a helper can fail while formatting a value this process never handled
and therefore cannot register or redact. The `--debug` traceback likewise ends
with `<Type>: [message suppressed]`. A client that needs the code should read
`reason.code`, not prose.

Daemon and sender stdout/stderr go to owner-only files under `data/logs`, and
the orchestrator displays only a bounded tail with known values redacted.
Owner-only storage is necessary but **not a guarantee that a child program
never writes a secret to its own log**. The regression test deliberately writes
a synthetic heartbeat key into a child log and asserts that the displayed tail
is redacted while the private file still contains it. Treat the log directory as
private diagnostic state, not as publishable evidence.

## Pinned uv bootstrap (cold start)

The wrappers first use an existing `uv 0.12.12` (from `AIPSTER_UV` or `PATH`).
If it is missing or a different version, they do **not** fail back to the user
and do **not** upgrade/replace a global uv. They run `uv_bootstrap.py` with the
system Python:

```sh
python3 local-worker/uv_bootstrap.py --print-path
```

The helper:

1. Loads `local-worker/uv-artifacts-0.12.12.json`, which pins the official
   Astral release source, the five accepted asset names, and each **archive**
   SHA-256 (not the detached `.sha256` file digest).
2. Selects only the asset matching the current OS/architecture. Unknown
   combinations are refused before any download.
3. Downloads the archive into `<worker data>/uv-bootstrap/0.12.12/`, a
   user-private directory established through `pairing.private_dir`.
4. Verifies the fixed SHA-256 **before** opening the archive.
5. Rejects absolute paths, `..`, control characters, symlinks/hardlinks/device
   members, encrypted zip members, oversized members, and archives that do not
   contain exactly one `uv` (or `uv.exe`) binary. It extracts only that member.
6. Writes the binary with 0700 permissions and records its digest in a private
   cache marker. Reuse re-verifies the binary digest.
7. Runs `uv --version` and requires exactly `0.12.12`.

The wrapper then adds the private directory to `PATH`, sets `AIPSTER_UV`, and
executes `uv run --no-project --python 3.12.14 python setup_worker.py ...`.
Those environment changes are scoped to that child; the global uv installation
and user PATH are untouched.

Remaining cold-start edge: the bootstrap itself needs a system Python 3.9+.
If none exists, the wrapper exits 3 with that exact limitation. It does not
download or install Python. `uv run --python 3.12.14` may download that Python
interpreter on first use, as the reviewed install path already did; that is a
network action and needs the operator's normal approval.

Qualification status: Windows x64 is the first qualified target. macOS and
Linux bootstrap paths are experimental; `setup_worker.py` still requires
`--allow-unqualified-platform` there. All bootstrap tests use synthetic
archives and fake downloader/digest/extractor/runner hooks; none downloaded or
executed a real uv binary on the development Mac.

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
    hostname=callable, expect_target=str,
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
* `hostname() -> str` feeds the target fingerprint; `expect_target` is the
  caller's asserted fingerprint (`None` disables the assertion).
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

Scenarios: `happy`, `resume`, `duplicate-sender`, `verify-honesty`,
`target-mismatch`, `stale-heartbeat`, `structured-status`,
`checkpoint-corrupt`. The driver
uses the real `Setup` methods and real `pairing.cmd_pair` against a loopback
fake claim API, with fake runner/spawner/HTTP. Every report is JSON with
`live_network=false`, `live_credentials=false`, `live_services=false`,
`live_inference=false`, per-check results, and a transcript. It is suitable for
a genuine Codex or Muse harness session: the harness runs the command, not a
simulated provider call, and no live credential or service is touched.

Expected current result: all eight scenarios pass. Labels distinguish
`mock-simulated` from real inference; the default verify path prints
`inference=NOT EXERCISED`. `target-mismatch` proves a wrong-machine run writes
no checkpoint, runs no installer, and spawns nothing; `stale-heartbeat` proves
a stale `usable=true` beat is reported as `fact usable=unknown` and never
`reachable`; `checkpoint-corrupt` proves a damaged checkpoint is preserved and
no installer, spawn, or claim is attempted.

### Private-input mode (`--packet-stdin`)

The scenarios above supply the code from a Python callable, so they do not
prove that an agent can drive the private stdin channel. `--packet-stdin` does:
it calls the **real** `setup_worker.read_private_code` parser on stdin, accepts
**only** the published synthetic fixture code, and then runs the **real**
`Setup.run` engine against temp roots with `FakeRunner`, `FakeSpawner`,
`FakeHttp`, and the loopback claim API.

Create the private packet once (0600, refuses to overwrite, never taken from
argv):

```sh
python3 setup_worker_fixture.py --write-fixture-packet "$HOME/.aipster-fixture/synthetic-packet.txt"
```

The exact documented packet (`aipster-setup-worker-harness-packet/1`) is:

```
AIPSTER agent setup packet v2.

SYNTHETIC FIXTURE - NOT A REAL PAIRING CODE

  PAIRING CODE: pair-01234567-89AB-CDEF-GHJKMNPQ

This packet belongs to local-worker/setup_worker_fixture.py. ...
```

Then the one-command invocation, with the private file redirected on stdin:

```sh
python3 setup_worker_fixture.py --packet-stdin \
  --json-out "$HOME/.aipster-fixture/report.json" \
  < "$HOME/.aipster-fixture/synthetic-packet.txt"
```

The process emits one sanitized JSON report (no transcript that could carry
input) with `synthetic_only=true`, the four `live_*` flags false, an
`accepted` flag for the input, the engine's own
`aipster-worker-setup-status/1` document, `installed` / `paired` /
`reachable` / `usable` / `inference_qualified` as separate facts (usable is
never authoritative), and per-check results. Any other code, an empty stream,
or a terminal (`PACKET_TTY_REFUSED`) is refused before the engine starts and
reported as a blocked status document without echoing the input. No real
credential, account, endpoint, install, enrollment, worker, or inference is
involved; `--verify-inference` only sends one request to the fake loopback
node and still reports `inference_qualified=no`.

## Worker continuity (ONB 08)

The daemon and sender are spawned with `stdin=DEVNULL`, output to owner-only
logs, `close_fds=True`, and `start_new_session=True` on POSIX
(`CREATE_NO_WINDOW` on Windows). Closing the initiating terminal or agent
session therefore does not signal the worker, and the launcher never waits on
or terminates a healthy daemon it started. Nothing enables autostart; a reboot
still requires an explicit launch.


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

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

## Interface agreement: what an agent runs (ONB 02 / ONB 10)

Two distinct invocations, both stdin-redirected from a private file. Nothing
is passed as an argument that could appear in shell history or `ps`.

**Real onboarding** (mutates this host; needs a genuine packet):

```sh
cd <worker checkout>/local-worker
./setup-worker.sh run --packet-stdin --json < <packet file>
```

`--json` emits one `aipster-worker-setup-status/1` document on stdout; human
diagnostics go to stderr. Optional, mutually compatible flags:
`--data-dir DIR`, `--config TOML`, `--expect-target FINGERPRINT`,
`--allow-unqualified-platform` (macOS/Linux), `--retry-pair` (only after the
operator confirms the resource is still unpaired), `--verify-inference`
(explicit, one request, never reported as qualification). `status` and `check`
never mutate; `check` is the safe pre-flight and prints the target
fingerprint.

**Synthetic qualification** (no install, no network, no credentials; the
synthetic fixture packet only):

```sh
cd <worker checkout>/local-worker
python3 setup_worker_fixture.py --packet-stdin --verify-inference \
  --json-out <report path> < <fixture packet file>
```

Exit `0` = every check passed, `1` = a check failed or the report was
suppressed because a code/token appeared in it. The report carries
`passed`, `readiness` (installed / paired / reachable / usable /
inference-qualified), `synthetic_only: true`, and
`live_network/live_credentials/live_services/live_inference: false`.
Create the fixture packet with
`python3 setup_worker_fixture.py --write-fixture-packet <path>` (0600,
`O_EXCL`).

### Phase-to-exit-code table

How `run` composes the phases, exactly:

1. Target guard, then `check`. A blocked check returns 3 and nothing else
   runs.
2. `install`. A non-zero install returns its code and nothing else runs.
3. The packet/code is read late; an unreadable or malformed source returns 2
   and pairing is never attempted (an empty source yields no code, which
   `pair` reports as 4).
4. `pair` runs **before** `start`, always — it is not conditional on `start`.
5. `start` is attempted **even when `pair` failed** (the daemon does not need
   pairing; the sender is skipped when unpaired).
6. `verify` runs only when `start` returned 0.
7. The returned code is: `start`'s code if `start` failed; otherwise `pair`'s
   code if `pair` failed; otherwise `verify`'s code. So `pair` = 5 followed by
   `start` = 3 returns **3**, not 5.

| Phase / situation | Exit | Outcome | Meaning and next action |
|---|---|---|---|
| any: bad flags, unresolvable packet/code source, invalid code syntax, target mismatch or target change | 2 | failed | Fix the invocation. No mutation; `reason.code` names the fault. |
| `check`: platform other than Windows x64 without `--allow-unqualified-platform`, Python < 3.9, `uv` not 0.12.12, < 1 GiB disk, bad loopback config, missing checkout files | 3 | blocked | Fix the prerequisite; the wrapper can bootstrap the pinned `uv`. |
| `install`: partial `.venv`, installer failure, missing checkout files | 3 | blocked | Remove only `local-worker/.venv` and rerun; a partial tree is never deleted. |
| `pair`: cannot establish private storage (directory/ACL failure) | 3 | blocked | Fix the data-dir permissions/ownership; nothing was claimed. |
| `pair`: store unreadable, previous attempt uncertain, no code supplied, claim rejected, local store missing after success | 4 | blocked | Repair the store or obtain a new code. Uncertain: check AIPSTER status/dashboard first, then `--retry-pair` only if still unpaired. |
| `pair`: network failure, or an exception after the claim was dispatched | 5 | incomplete | The code may be consumed. Check status/dashboard before any retry. |
| `start`: worker not installed, check blocked, port held by an unresponsive service, healthy service this data dir cannot prove or whose token it rejects, daemon could not spawn, daemon healthy but rejected the setup token, sender could not spawn | 3 | blocked | Read the log tail printed to stderr; an unhealthy daemon that did start is stopped through the ownership ledger. |
| `start`: daemon exited, never became healthy, health ok but the node check failed, something answers that is not this worker, sender exited with any code other than 4 or 6 | 5 | incomplete | Retry `start`; the checkpoint is preserved and nothing is deleted. |
| `start`: sender key revoked/expired (sender exit 4) | 4 | blocked | Pair again; install is preserved. |
| `start`: not paired (sender skipped), sender lock already held, another sender owns the data dir (sender exit 6), sender started or heartbeat observed | 0 | complete | Reaching 0 here means the connection target met; it does not mean usable or inference-qualified. |
| `verify`: daemon not healthy, node check failed with any status other than 401/403, inference exercise failed, heartbeat stale/failed/awaiting/unreadable | 5 | incomplete | Retry later; nothing was deleted. |
| `verify`: config/node section invalid, private daemon token missing, node identity rejected (401/403) | 3 | blocked | Run `start` with the right data dir, or repair pairing; a revoked credential surfaces as 401/403 here, never as 4. |
| `verify`: facts disagree (e.g. `usable=false`) | 0 | complete | Connection target met; usability and inference are separate facts. |
| any: another setup process holds the lock | 75 | blocked | Wait for it; nothing was mutated. |
| any: Ctrl-C / interrupt | 130 | cancelled | The checkpoint is preserved and nothing is deleted. |
| any: internal failure after dispatch | 2 | failed | `reason.detail` is `"<Type> during <command>; message suppressed"`; rerun with `--debug` for frames and the exception type only. |
| `status` | 0, or 2 when the pairing status helper fails | complete / failed | Read-only; never mutates, never consumes a code. |

Reserved: exit `6` is the sender's own "already running" code. `start` maps
it to exit `0` (complete) rather than surfacing an error. `verify` has no
reachable pair-required path today: the only `EXIT_PAIRING` branch there
requires a present pairing manifest and a `not-paired` heartbeat at the same
time, which cannot both hold.

`--json` never changes an exit code; the document's `outcome` and `exit_code`
always agree with the table above.

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

The QA-accepted Muse ownership API is integrated as the **only** destructive
path in the engine. `setup_ownership.py` is copied byte-identically from Muse
`d94b77f` (API v1.1.1; sha256
`1a0950fd3a4f1c69ae1fe49648413cfa47b329aa9050595f95dfc736a67e142d`) and is
never edited here; findings route back to Muse `a2a`. The engine loads that
file **by location**, not by module name, and attests that the resolved path
is its own `local-worker/setup_ownership.py`: an embedding that imported
another lane's copy first therefore cannot supply the component silently, and
the import fails closed if the vendored file is not the one bound.

Wired today — one path only, a daemon that never becomes healthy after
`start`:

1. `create_ledger(roots=[root, data_dir], attempt_id="setup-<uuid12>",
   preserved=PreservedGuard(...))`. Preserved entries are the checkpoint file
   and the pairing meta/status/key files, so rollback can never delete the
   evidence a human needs.
2. `claim_new_process(ledger, pid, process_ops)` records the child the engine
   itself just spawned.
3. `rollback(ledger, file_ops, process_ops)` runs with identity-bound deletes
   and no group signals. If it reports `complete=False`, it is retried once
   with `prior=<previous report>` so the residual set is recomputed rather than
   dropped.
4. Exactly one `rollback: ...` line is printed with
   `redacted_diagnostics(report)` — counts and refusal categories, never a
   path, PID, or token.

The orchestrator supplies the missing `stop_owned` adapter as `OsProcessOps`,
and grants it real signal authority only when the engine owns the spawner:

* The default adapter is installed **only with the default spawner**. With an
  injected spawner the adapter is `None` unless the caller passes one
  explicitly, because a synthetic handle's PID may belong to an unrelated host
  process; passing `process_ops=` is an explicit grant. With no adapter the
  daemon-failure path stops the live `Popen` handle the engine created and
  never looks at the host PID table.
* `probe(pid)` does an `os.kill(pid, 0)` existence precheck first, so a
  nonexistent or already-reaped PID costs no subprocess. It returns `None`
  **only when the process is proven absent** (`ProcessLookupError`, `/proc`
  gone, or `ps` reporting "no such process"). An identity that cannot be
  observed — unsupported platform, unreadable `/proc`, `ps` missing, timed
  out, or unparsable — raises `OwnershipError`, so rollback records a
  retryable `error` residual instead of reporting a running daemon as stopped.
  On Linux identity is the start time from `/proc/<pid>/stat` plus
  `/proc/<pid>/exe` and the directory owner; on macOS it is
  `ps -o lstart= -o uid= -o comm= -p <pid>`.
* `stop_owned(pid, expected)` re-verifies the full identity tuple
  `(start_time, executable, owner)` before signalling. A mismatch raises
  `Refusal("PID reused (birth identity mismatch)", "reuse")` and **sends no
  signal** — a recycled PID is never killed. Only after that check does it
  send `SIGTERM`, poll for a bounded interval, re-verify identity, then send
  `SIGKILL`. No process groups are signalled.

Fail-safe behaviour, unchanged from before:

* If the ledger refuses the claim (normally because the child already exited,
  or a synthetic handle has no real PID), the engine falls back to the live
  `Popen` handle it owns by construction: `terminate()` then a bounded
  `wait()`. No unowned PID is ever signalled.
* A reused/mismatched PID or an unobservable identity is reported as a
  residual and left alone.
* Cancellation, Ctrl-C, and every other failure path still delete nothing and
  leave the checkpoint. No file claim (`claim_new_file` / `claim_new_dir`) is
  wired yet, so an install, `.venv`, or private store is never removed by
  rollback.

Gaps in this integration (routed to Muse `a2a`, not patched here): the
fallback path is outside the ledger, so its outcome is not counted in the
rollback diagnostics; `ps lstart` text is locale- and platform-formatted and
has one-second resolution, which is fine for same-session comparison but is
not a stable cross-tool identity format; and the fallback `Popen.terminate()`
targets the child's process group (the session the engine itself created), so
"single PID only" holds for `OsProcessOps`, not for that handle.

## Setup state

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
    poll_interval=0.25, file_ops=object, process_ops=object,
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
* `file_ops` / `process_ops` are the Muse ownership adapters passed to
  `rollback`. `file_ops` defaults to `ownership.OsFileOps()`. `process_ops`
  defaults to the engine's `OsProcessOps` **only when the spawner is also the
  default**; with an injected spawner it defaults to `None`, so the daemon stop
  uses the injected handle and no host PID is probed. A fake needs
  `probe(pid) -> identity | None` (raise on "cannot observe") and
  `stop_owned(pid, expected) -> bool`; the author tests pass the real
  `OsFileOps` over temp roots with a fake `process_ops`, so no real process is
  signalled. The fixture driver does the same.

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

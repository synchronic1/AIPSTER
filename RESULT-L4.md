# RESULT-L4 — macOS native compatibility lane (Phase A)

Marker: **DS-INFERENCE-L4-MACOS-20261101**
Lane: L4 (macOS native compatibility) of the AIPSTER inference integration.
Status: **PHASE A COMPLETE — waiting for the L3 branch (`ds/worker-ganglion-20261101`).**

## 1. Environment (verified, not assumed)

| Item | Value |
|---|---|
| cwd | `/Users/peterjohannmedina/.paseo/worktrees/3pb25u4o/ds-worker-macos` |
| Branch | `ds/worker-ganglion-macos-20261101` |
| HEAD | `f6e45f556a48dd5f75a8e8b90992e8d9cfa0393e` (= `origin/main`, "Merge pull request #61") |
| Worktree clean | yes (`git status --porcelain` empty) |
| macOS | 26.4.1, build 25E253 |
| Arch | arm64 (Apple Silicon) |
| System python3 | 3.9.6 at `/usr/bin/python3` |
| Test interpreter | CPython **3.12.13** (`/Users/peterjohannmedina/Documents/SysDev/AiTinkerersVenice/.venv/bin/python`, used read-only) |
| Repo pin | `local-worker/.python-version` = `3.12.14`; uv on PATH is **0.10.3**, not the pinned 0.12.12 |
| Deps | fastapi 0.141.1, pydantic 2.13.5, websockets 17.1, httpx 0.28.1, pytest 8.4.2 (pre-existing venv) |

System `python3` is 3.9.6, so the suite cannot run on it; the pinned 3.12 interpreter is
required. No package was installed and no toolchain was changed.

## 2. RECONCILE — prior Mac work (what exists, where, what overlaps)

### 2.1 PR #62 — `macos/worker-qualification-20261101` (draft, head `2fdba86`)

Read (not merged, not modified): PR body, `gh pr diff --name-only`, and the commits
`b0a1e26` → `2817b66` → `2fdba86`. 16 files, +2183/−135 vs `b0a1e26`.

Covers **POSIX lifecycle and tray process control**, not the new job path:

- `test_macos_lifecycle.py` — **new, 12 tests**, stdlib only: cancel closes only verified
  descendants; deadline-bounded shutdown with no orphan listener; disconnect before/after
  response (single dispatch vs unknown/no replay); restart preserves node id without
  repair; no duplicate sender in one controller; owner-only private storage; unreadable
  directory; venv path with spaces passed as argv list; `shlex.quote` display; WorkerChild
  descendant cleanup; second sender exits without beating.
- `pairing.py` — adds a `sender_lock` **context manager** (`pairing.py:638`) plus
  `_fd_lock_exclusive` (`:616`); held ⇒ exit `EXIT_USAGE = 2`.
- `packaging/aipster_tray/child.py` — POSIX **process-group stop**: `start_new_session=True`,
  `os.getpgid`, `killpg(SIGTERM)` then `killpg(SIGKILL)` (`:130,145,152`).
- `controller.py` / `backend_headless.py` — shell-safe **display quoting** (`shlex.join` on
  POSIX, `subprocess.list2cmdline` on Windows); display only, not argv.
- `vendor/eif/**` + `patches/0002-fabric-resident-binding.patch` + `test_fabric_bridge.py`
  (**20 tests**) — the **EIF/Dendrite fabric** resident-model binding: WebSocket to a
  Ganglion-compatible fabric, resident-only admission, deadline, duplicate suppression.
- `provenance.json`, `README.md`, `VERIFICATION.md`, `test_pairing_lifecycle.py` (0o300
  repair expectation).

Known limitation stated in the PR itself: the branch is based on `b0a1e26`, which is **not
on main**, so it carries 10 Ganglion files that main does not have; and its
`sender_lock` (exit 2) **conflicts** with main's shipped R4 API `_hold_sender_lock` /
`sender_lock_held` / `EXIT_SENDER_RUNNING = 6` (`pairing.py:74,616,663`, from `bb665c9`).
It has to be reconciled before anything of it can land.

### 2.2 Earlier Mac DeepSeek successor lanes (`/private/tmp/paseo-successor-20261101/`)

Read (reports only; nothing re-run from those trees):

- `worker/CANDIDATE.md` + `worker/RESULT.json` — candidate **`101ff94`**
  (`successor/worker-integration-20261101`, local only), chain
  `f6e45f5` → `9c2c479` (PR62 reconcile) → `e0c202e` (docs/runtime repair) → `101ff94`
  (docs-only). It **keeps main's R4 sender lock**, carries the 8 patch-0002 fabric
  artifacts byte-identical to `0763d87`, and adds `test_docs_consistency.py`. Not pushed.
- `authority/REVIEW-WORKER-101ff94.md` — **APPROVE** for `101ff94` as a docs delta, with
  protected-path byte identity verified. Restates the same residual limits.
- `e2e/REPORT.md` — offline fixture harness (`09862ee`): fake admission → fake loopback
  Ganglion transport → **real vendored fabric bridge** → MockRuntime. 8 tests.
  Key recorded gaps that matter for L4: **no durable job ledger** (a fresh `Node` after
  mid-flight teardown re-executes the same job id ⇒ replay), **no cancel verb**, the only
  bound is the worker-local timeout, `simulated: true` results are rejected by AIPSTER's
  decoder, and cancellation/accounting are absent rather than invented.
- `FINAL-HANDOFF.md` — confirms no push/merge/deploy/enrollment and that CI needs
  uv 0.12.12 + Node 24 + a Windows runner, none present.

### 2.3 Which macOS fixes already exist (as of my HEAD `f6e45f5`)

| Fix | On main | In PR #62 | In `101ff94` |
|---|---|---|---|
| POSIX group kill on child stop | **No** (`child.py:183,357` use `proc.terminate()`) | Yes | Yes (via reconcile) |
| Sender lock | Yes — R4 `_hold_sender_lock`/exit 6 | Different API (exit 2) | Yes — main's R4 |
| Shell-safe tray display quoting | **No** | Yes | Yes |
| macOS lifecycle regression suite | **No** | Yes (12) | Yes |
| Fabric resident binding (patch 0002) | **No** (only patch 0001) | Yes | Yes |
| Docs↔provenance consistency test | **No** | No | Yes (5) |

So on my branch, **none of PR62's macOS fixes and none of the successor's docs/fabric work
are present**. They exist only in local/unmerged refs (`2fdba86`, `101ff94`) and remain
reachable in the shared object DB for reference.

### 2.4 Overlap with the new `inference_worker` path

The new path (aipster.net `POST /api/jobs` → coordinator → worker `GET /api/worker/jobs/next`
→ one-shot local Ganglion `POST /v1/completions` on `127.0.0.1:8471` → `POST .../result`)
shares **only** the `local-worker` shell with the prior work; the dispatch transport is
different (plain HTTP polling vs. the EIF WebSocket fabric):

- **Shared, reusable as-is:** `pairing.py` private-storage primitives (`private_dir`,
  `write_private`, `restrict_file`, `check_private_store`), heartbeat/status/pairing files,
  and the `pair_lock`/`_fd_lock_exclusive` flock pattern. `test_pairing*` suites and the
  R4 sender lock are unaffected by a new command.
- **Adjacent but not the same code:** PR62's POSIX group stop targets tray `WorkerChild`
  processes; a `serve-jobs` daemon needs its own SIGTERM/SIGINT handling. PR62's
  `sender_lock` is for the heartbeat sender, not the job loop, and conflicts with main.
- **Genuinely new (nothing exists yet):** the started-job ledger (the e2e lane proves the
  current worker replays after restart), the loopback-only Ganglion check (with `::1` vs
  `127.0.0.1`), the deadline → timeout arithmetic, and any HTTPS/certificate-store path to
  `aipster.net`.
- **Current tree check:** `grep` over the worktree finds **no** `inference_worker`,
  `serve-jobs`, `/api/worker/jobs`, `jobs/next` or `8471` reference anywhere in
  `local-worker/`, `website/` or `docs/`. `/api/jobs` is still `INFERENCE_DISABLED` (501) per
  `website/tests/integration-boundaries.test.mjs:63`. Nothing of the new path exists here
  yet, so there is no duplicate macOS work to undo.

## 3. Baseline test runs on macOS (tests I ran)

Harness (mine, in `/private/tmp/l4-20261101/`): every run holds
`/private/tmp/aipster-mac-heavy-tests.lock` exclusively via `run_with_lock.py` (fcntl
`LOCK_EX`), with `PYTHONDONTWRITEBYTECODE=1`, `PYTHONPATH=<worker>/vendor/eif`,
`TMPDIR=/private/tmp/l4-20261101/tmp`, and no cache provider. Interpreter: the pre-existing
CPython 3.12.13 venv, read-only.

### 3.1 `origin/main` @ `f6e45f5`

```text
python test_installation.py                       Ran 14 tests   OK            1.955 s
python -m unittest test_pairing test_pairing_security \
  test_pairing_windows_storage test_pairing_lifecycle \
  test_pairing_e2e test_sender_lock test_source_update -v
                                                  Ran 85 tests   OK (skipped=13)  47.408 s
```

- Zero failures, zero errors. 73 passed, 13 skipped.
- Skips: 11 `test_pairing_windows_storage` ("native Windows storage contract"), 1
  `test_pairing_lifecycle` ("Windows sharing semantics"), 1 `test_pairing_e2e` class-level
  ("node or website/node_modules missing; cannot run E2E" — Node 24 is absent here).
- Logs: `logs/main-installation.log`, `logs/main-unittest.log`.

### 3.2 PR #62 head @ `2fdba86` (throwaway worktree, since removed)

```text
python test_installation.py                       Ran 14 tests   OK            2.045 s
python -m unittest test_pairing test_pairing_security \
  test_pairing_windows_storage test_pairing_lifecycle test_pairing_e2e -v
                                                  Ran 74 tests   OK (skipped=13)  44.108 s
python run_unittest_repo_packaging.py <worker> test_macos_lifecycle test_fabric_bridge
                                                  Ran 32 tests   OK            8.659 s
verify_vendor.py --check-patches                  16 files: 10 upstream-identical, 6 patched (exit 0)
```

- `test_sender_lock.py` and `test_source_update.py` do not exist on that branch (they are
  main-only), so 74 rather than 85 for the core list. 32 = 12 `test_macos_lifecycle` +
  20 `test_fabric_bridge`.
- **Harness artifact reproduced:** without the shim, `test_macos_lifecycle` fails 4/32 with
  `ModuleNotFoundError: No module named 'packaging.aipster_tray'`. Root cause confirmed:
  `local-worker/packaging/` has no `__init__.py`, so it is a namespace portion and the PyPI
  `packaging` regular package wins the path scan. The shim appends
  `<worker>/packaging` to `packaging.__path__`; no repository file was changed. This matches
  the artifact the successor lane documented.
- Worktree was created with `git worktree add --detach` under `/private/tmp/l4-20261101/`
  and removed afterwards (`git worktree remove --force`); it is gone from `git worktree list`.
- Logs: `logs/pr62-installation.log`, `logs/pr62-unittest.log`,
  `logs/pr62-macos-fabric.log` (pre-shim failure), `logs/pr62-macos-fabric-shim.log` (green).

### 3.3 What these numbers mean

`f6e45f5` is green on macOS for everything main ships. The macOS-specific gaps are not
mainline failures; they live in the unmerged PR62/successor candidates and in the code paths
the new inference worker has not written yet.

## 4. Local node probe (read-only, no POSTs, no loads)

A Dendrite node **is** running on this Mac (the AiTinkerersVenice instance already noted in
prior reports; the same protected PIDs — untouched):

| Process | PID | Endpoint |
|---|---|---|
| `dendrite serve --config .dendrite/mac.toml` (via `uv run --offline --no-sync`) | 90049 (parent 90048) | **127.0.0.1:8090** |
| `llama-server … --alias qwen3-1.7b@68468069… --port 8081` | 90054 | 127.0.0.1:8081 |
| Ollama.app `ollama serve` | 46351 | (Ollama default) |

Single GET on each documented route, 5 s timeout, no credential read, no mutation:

```text
GET http://127.0.0.1:8090/v1/models
HTTP/1.1 404 Not Found
server: uvicorn
content-type: application/json
{"detail":"Not Found"}

GET http://127.0.0.1:8090/v1/node
HTTP/1.1 401 Unauthorized
server: uvicorn
content-type: application/json
{"error":"Invalid or missing Dendrite token"}
```

Interpretation: the running node exposes **no `/v1/models` route** (the OpenAI-compatible
surface belongs to the engine on 8081, not to Dendrite), and `/v1/node` is behind the
patch-0001 token check, so an unauthenticated loopback caller gets a uniform 401 body. The
response shapes above are recorded as observed; nothing was authenticated and no token was
sought.

**No Ganglion server is running.** Nothing is listening on **8471**, and no process matches
`ganglion`. So the inference worker's default upstream (`http://127.0.0.1:8471`) has no
target on this machine today, and Phase B cannot include a live `/v1/completions` call
(which is prohibited anyway).

## 5. Phase B — prepared, not started

Waiting for the coordinator to publish `ds/worker-ganglion-20261101`. On receipt I will:
fetch it, merge into `ds/worker-ganglion-macos-20261101`, run the full suite including
`test_inference_worker.py`, and fix macOS-only failures failing-first. The checklist I will
hold it to:

1. Ledger private storage: `0700` dir, `0600` files, `O_EXCL` create, no symlink following.
2. `fcntl` locking on POSIX vs the Windows mutex path.
3. SIGTERM/SIGINT during poll **and** during a Ganglion call: no re-execution, honest exit.
4. Monotonic deadlines across sleep/wake.
5. `/private/var` vs `/var` temp paths.
6. IPv6 `::1` vs `127.0.0.1` in the loopback check.
7. HTTPS to `aipster.net`: macOS certificate trust store.
8. Optional if green: `local-worker/packaging/macos/` launchd user-agent plist for
   `serve-jobs`, KeepAlive on crash only, no secrets in logs, no auto-install, validated
   with `plutil -lint` in a test.

## 6. Rules honoured

No push, no PR comment/approval, no merge, no deploy, no call to aipster.net, no credential
or private-storage read, no live inference POST, no model load/unload, no change to running
services or to `/Users/peterjohannmedina/Documents/SysDev/AIPSTER`. The only writes outside
this worktree were the throwaway worktree under `/private/tmp/l4-20261101/` (removed) and
this report.

## 7. Evidence index

| Path | What |
|---|---|
| `/private/tmp/l4-20261101/logs/main-installation.log` | 14 passed @ `f6e45f5` |
| `/private/tmp/l4-20261101/logs/main-unittest.log` | 85 tests, OK, 13 skips @ `f6e45f5` |
| `/private/tmp/l4-20261101/logs/pr62-installation.log` | 14 passed @ `2fdba86` |
| `/private/tmp/l4-20261101/logs/pr62-unittest.log` | 74 tests, OK, 13 skips @ `2fdba86` |
| `/private/tmp/l4-20261101/logs/pr62-macos-fabric.log` | 4 errors before the packaging shim (harness artifact) |
| `/private/tmp/l4-20261101/logs/pr62-macos-fabric-shim.log` | 32 passed @ `2fdba86` |
| `/private/tmp/l4-20261101/run_with_lock.py` | exclusive shared-lock runner |
| `/private/tmp/l4-20261101/run_unittest_repo_packaging.py` | harness-only packaging shim |

Reports **read** (not re-run): PR #62 body/diff, `worker/CANDIDATE.md`,
`worker/RESULT.json`, `authority/REVIEW-WORKER-101ff94.md`, `e2e/REPORT.md`,
`FINAL-HANDOFF.md`.

---

# PHASE B — L3 integration on macOS

Marker: **DS-INFERENCE-L4-MACOS-20261101 / PHASE B**
Status: **green, committed locally, not pushed.**

## B.1 Integration

| Item | Value |
|---|---|
| L3 branch | `origin/ds/worker-ganglion-20261101` @ **`30008c0ef95b2aa332b49f6dcc9af4421e12caf5`** (SHA verified after `git fetch`; matches the coordinator's) |
| Merge | `git merge --no-ff` → merge commit **`0fd428a53d7c33b44c651410b4980efb07c87460`** (clean, no conflicts) |
| Fix commit | **`aa0e8bdd89606e370a875013c6177f034c55e1e7`** — macOS lane changes, 4 files, +310/−21 |
| Branch | `ds/worker-ganglion-macos-20261101`, local only |

`30008c0` is `origin/main` + 5 commits (coordinator + failing-first tests + job
runner + nested-wire conformance). It brings `local-worker/inference_worker.py`
(792 lines), `test_inference_worker.py` (58 tests), the `serve-jobs` CLI and
`pairing.py` env/token wiring, plus the internal website dispatch coordinator
(`website/src/inference/dispatch-coordinator.mjs`, its tests/fixtures and
`docs/dispatch-coordinator.md`), which I carried **unchanged and did not touch**.

**Wire shapes unchanged.** The envelope (`{protocol, task, binding}`), the
succeeded key set and the failed key set are untouched; `git diff` over
`inference_worker.py` contains no result- or envelope-key line. No disagreement
with L3's shapes is recorded.

## B.2 Counts (tests I ran, native macOS, pinned 3.12 venv, shared lock held)

| Run | Result |
|---|---|
| L3 suite as merged, before any change | `test_inference_worker` — **58 passed**, 32.305 s |
| New macOS/POSIX cases, before the fix | **6 failed** of 7 (exact failures listed below) |
| New macOS/POSIX cases, after the fix | **7 passed**, 4.819 s |
| `test_inference_worker` final | **67 passed**, 37.311 s |
| **Full local-worker suite** (`test_pairing test_pairing_security test_pairing_windows_storage test_pairing_lifecycle test_pairing_e2e test_sender_lock test_source_update test_inference_worker`) | **152 tests, OK (skipped=13), 85.259 s** |
| `test_installation.py` | 14 passed, 2.023 s |
| `verify_vendor.py --check-patches` | exit 0 — 16 files: 14 upstream-identical, 2 locally patched |
| `packaging/macos/test_launchd_template.py` | 5 passed; `plutil -lint -s` exit 0 |
| Signal tests repeated 3× | 3 passed each time (2.67–2.69 s), no flake |

The 13 skips are the same platform skips as the Phase A baseline (11 native
Windows storage, 1 Windows sharing semantics, 1 E2E class needing Node).

## B.3 Checklist findings (each fix has a failing-first test)

**1. POSIX private storage for the started-job ledger — one real defect, fixed.**
The ledger itself was already sound: `pairing.write_private` uses `mkstemp` +
`restrict_file` (0600) + `os.replace`, and `pairing.private_dir` verifies an
existing dir is owner-only and 0700. But the **job lock was created 0644** on
POSIX: `_hold_lock` used `open(path, "a+b")`, while the Windows branch already
passed `0o600`. Fixed with `os.open(..., 0o600)` plus `fchmod` for a
pre-existing file. Test: `test_posix_lock_file_is_created_private` (failed with
0644, passes with 0600). The data dir is still 0700 either way, so this was
hygiene, not exposure.

**2. fcntl locking vs exit 6 — two real defects, fixed.**
A `jobs.lock` that is a **symlink was followed** and flock-ed through
(`open()` follows links); and any lock failure — wrong file type, unreadable —
was reported as `[JOBS_RUNNING] another serve-jobs already holds this data dir`
with exit **6**, sending an operator after a process that does not exist.
Now: POSIX opens with `O_NOFOLLOW` and the file is `fchmod`-ed 0600; only
`EACCES/EAGAIN/EWOULDBLOCK` (real contention, and `EACCES` for the Windows
`msvcrt` path) returns `None` → `JOBS_RUNNING`/exit 6; every other failure is
`PRIVATE_STORAGE`/exit 2. Tests:
`test_posix_linked_lock_path_is_refused` (was exit 0 and flock-ed the outside
file), `test_posix_unusable_lock_fails_closed_without_claiming_a_runner` (was
exit 6 with the wrong message). The documented second-runner exit 6 is
unchanged, and `test_second_runner_exits_jobs_running` still passes.

**3. SIGTERM/SIGINT during poll and during a Ganglion call — the biggest gap, fixed.**
There was **no signal handling**. Measured before the fix: SIGTERM during an
idle poll → killed by signal (**-15**, no message, no unwinding); SIGTERM during
a completion → **-15** with the completion abandoned; SIGINT during a poll →
`KeyboardInterrupt` through `pairing.main` → **130**. Nothing was *re-executed*
(the ledger is written before the call), but none of it was an honest exit, and
a signal death is exactly what a crash-only `KeepAlive` would restart.
Now `JobRunner.run` installs POSIX handlers: the first signal sets a stop flag
and wakes the idle wait; the loop leaves **between** jobs; a completion already
handed to Ganglion is allowed to finish and post before exiting; a second signal
restores the default action so a wedged upstream can still be killed. Exit 0.
Tests (subprocess, fake servers): `test_sigterm_during_idle_poll_exits_cleanly`,
`test_sigint_during_idle_poll_exits_cleanly`,
`test_sigterm_during_completion_posts_the_result_once` (asserts exactly one
completion, one `succeeded` result posted, job present in the ledger, no
`Traceback`, exit 0). Behaviour change to flag: **SIGINT now exits 0, not 130**,
for `serve-jobs` only (`pair`/heartbeat keep 130).

**4. Monotonic deadlines across sleep/wake — analysed; caveat documented, no code change.**
Lease validity is wall-clock based (`deadline_at` vs `int(time.time()*1000)`) at
validation, again after the model listing, and `started` elapsed is measured on
`time.monotonic`. That ordering is correct and is now pinned by
`test_deadline_expiring_during_model_listing_fails_without_completion` (a stalled
monotonic clock cannot make an expired lease executable; nothing is recorded as
started). The residual, unfixable-in-stdlib caveat: the socket timeout is derived
as `monotonic_now + wall_remaining`, and **Darwin's `CLOCK_MONOTONIC` excludes
system sleep**, so a Mac that sleeps mid-completion can let that one call
outlive `deadline_at`. macOS has no `CLOCK_BOOTTIME`. The consequence is bounded
and honest: the job is already in the ledger (never re-run), the result is posted
with the real `elapsed_ms`, and the coordinator's lease decides. I did **not**
convert a completed job into a `failed` report to "enforce" the deadline, because
that would invite a remote retry and a double execution — the worse outcome.

**5. `/private/var` vs `/var` temp paths — verified, test added.**
macOS reaches `/private/var` through the `/var` symlink and
`tempfile.gettempdir()` returns such a prefix-only path. `private_dir` and
`_restrict_path` examine the **final** component, so a prefix symlink is
correctly accepted. `test_private_store_reached_through_the_var_symlink_prefix`
builds a data dir under `/var/tmp`, asserts the path really is symlinked, and
checks 0700 dir / 0600 lock / 0600 ledger.

**6. IPv6 `::1` vs `127.0.0.1` — already correct, now pinned.**
`LOOPBACK_HOSTS` holds all three forms and `urlparse` normalises `[::1]` to
`::1`. `test_loopback_ganglion_bases_cover_ipv6_and_localhost` pins
`127.0.0.1`, `localhost`, `[::1]` and `https://[::1]` as accepted, and
`[::2]`, `[2001:db8::1]`, `0.0.0.0`, `127.0.0.2` as refused (fail-closed). No
code change was needed.

**7. HTTPS certificate store — no code change; environment fact recorded.**
`pairing.post_json` / `get_json` use `build_opener(NoRedirects())` with no custom
`SSLContext`, so the interpreter's default trust store applies, and
`check_api_base` already requires `https` for any non-loopback base. On this
machine the pinned venv (Homebrew CPython 3.12.13) resolves
`ssl.get_default_verify_paths().cafile = /opt/homebrew/etc/openssl@3/cert.pem`
(192 CA certificates) — HTTPS to `aipster.net` would verify here. Caveat for
other installs: that path is Homebrew-specific; an interpreter without a CA
bundle would fail closed at TLS, not silently skip verification.

**8. Optional launchd template — added.**
`local-worker/packaging/macos/dev.aipster.worker.serve-jobs.plist`: user agent
that runs `pairing.py --data-dir … serve-jobs`, `KeepAlive = {SuccessfulExit:
false}` (restart on crash/non-zero only, so a 0 exit from a stop signal stays
stopped), `ThrottleInterval 30`, explicit log paths, **no** environment block
and no token, no `--allow-non-loopback-ganglion`, visible `__PLACEHOLDER__`s and
nothing that installs it. Validated by `plutil -lint -s` (exit 0) and by
`packaging/macos/test_launchd_template.py` (5 tests).

## B.4 What a live Mac run would need

Nothing on this machine can execute a job end to end. A live qualification needs
**either** (a) a **Ganglion** OpenAI-compatible server on the Mac listening on
`http://127.0.0.1:8471` (or `AIPSTER_GANGLION_URL`) with a resident model listed
at `/v1/models`, **or** (b) a **separately approved Dendrite adapter** — the
running node here is Dendrite on `127.0.0.1:8090`, which is token-gated and has
no `/v1/models` route, and its engine on 8081 is not an AIPSTER runtime. I built
no adapter and made **no Dendrite calls in Phase B** (the only probes were the
two authorised GETs in Phase A). Until one of those exists, qualification rests
on the fake upstreams. The server side is dark in any case: `POST /api/jobs`
stays `INFERENCE_DISABLED`, and no live AIPSTER call was made.

## B.5 PR #62 — deliberately not merged; what the job runner could use

No group-kill, tray or lifecycle code was brought into this branch. Of PR #62's
fixes, only these bear on `serve-jobs`:

| PR #62 fix | Bearing on the inference worker |
|---|---|
| POSIX process-group stop (`child.py` `killpg`) | **Not applicable** — `serve-jobs` spawns no children; there is nothing to orphan. |
| `test_macos_lifecycle.py` (12 regressions) | **Useful as a model, not as code.** Its deadline-bounded shutdown / no-orphan / no-replay cases are the closest prior art; the equivalents for the job loop are the signal and ledger tests added here. |
| `sender_lock` context manager, exit 2 | **Not adopted.** It conflicts with main's R4 lock (exit 6); the job lock keeps exit 6 and the README's documented contract. |
| `_fd_lock_exclusive` / flock pattern | Already equivalent in `_hold_lock`; nothing to port. |
| Tray display quoting (`shlex.join`) | **Not applicable** — the runner has no display or console launch path. |
| Owner-only private-storage expectations | Already enforced by `pairing.private_dir`/`write_private`; the gap was the lock file, fixed here. |

If PR #62's group-kill work is ever wanted for a *tray-spawned* worker that
supervises a model server, that is a different component and should land
separately.

## B.6 Flags for the coordinator (no wire-shape change requested)

1. `serve-jobs` now exits **0** on SIGTERM/SIGINT (was -15/130). Anything that
   treats 130 as the Ctrl+C signal should be told.
2. A stop never abandons an in-flight completion; the job finishes and posts.
   Bounded by the lease deadline, which can be slightly exceeded after a Mac
   sleep (B.3 item 4).
3. The Windows lock path still has no `O_NOFOLLOW` equivalent, so a junction or
   reparse-point `jobs.lock` can be followed there. Out of this lane's scope;
   noted rather than guessed at.
4. `StartedLedger._load` still reads an existing `jobs-started.json` through a
   symlink (writes are refused). Inside a 0700 owner-only dir this is
   defence-in-depth only; not changed.
5. `test_launchd_template.py` must be run as a script
   (`python packaging/macos/test_launchd_template.py`), not imported as
   `packaging.macos.*`, for the same namespace-`packaging` reason recorded in
   Phase A.

## B.7 Phase B evidence

| Path | What |
|---|---|
| `/private/tmp/l4-20261101/logs/l3-inference.log` | 58 passed at merge, before changes |
| `/private/tmp/l4-20261101/logs/l4-inference-full.log` | 65 passed (58 + 7 new) |
| `/private/tmp/l4-20261101/logs/l4-full-unittest.log` | 150 tests OK at the first green full run |
| `/private/tmp/l4-20261101/logs/l4-final-unittest.log` | **152 tests OK (13 skips), 85.259 s** at `aa0e8bd` |
| `git show aa0e8bd` | the four-file fix and its failing-first tests |
| `local-worker/packaging/macos/` | launchd template + its 5 tests |

Rules honoured in Phase B: no push, no PR comment/approval, no merge to main, no
deploy, no `aipster.net` call, no credential or private-storage read, no live
inference POST, no model load, no Dendrite call, no change to running services or
the main checkout. Local commits only.

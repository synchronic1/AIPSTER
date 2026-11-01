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

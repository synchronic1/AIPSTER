# macOS portable packaging: exact-source intake (cloud artifact-QA lane)

Status: **HOLD, waiting for the exact patch.** No candidate source has been received.

This file covers only the cloud portable packaging and artifact-QA lane. It is
not a native UI writer and makes no native build claim. Control and source
integration belong to the native Mac owner (onRequest `643673fa`). The native
packaging lane (onRequest `12f866c4`) keeps the candidate and source handoff.

## Candidate identity (expected, not present here)

| Field | Value |
|---|---|
| Candidate | `f48ec58` on `muse/mac-fabric-endpoint-20261104` |
| Local path (Mac) | `/private/tmp/aipster-muse-mac-fabric-20261104` |
| Preserved base | `dd56912` (this is **not** public `main`) |
| Cloud public main at intake | `0e6b60890c736207664d122c62e39d8c4affd2fa` |
| Cloud presence | neither `f48ec58` nor `dd56912` resolves; no remote `muse/mac-fabric-*` branch |

Intake rule: accept only a patch or bundle whose commit SHA is `f48ec58` and
whose parent chain reaches `dd56912`. Do not rebuild it from public main, do
not guess the source, and do not replace main wholesale. A `git bundle` or
`git format-patch dd56912..f48ec58` is acceptable if it reproduces `f48ec58`
byte-for-byte (`git rev-parse HEAD` equals the full `f48ec58…` SHA after applying it).

## Cloud runner facts

- Ubuntu 24.04.5 LTS, x86_64, Linux 6.18; Python 3.13.18.
- None of these exist here: `plutil`, `iconutil`, `sips`, `hdiutil`, `pkgbuild`, `codesign`, `launchctl`, PyObjC, or AppKit.
- Known environment trap: the system `site-packages/packaging` (PyPI)
  shadows the repo's namespace dir `local-worker/packaging/`. Run with
  `python3 -S` or from a clean venv. Otherwise 4 tests in `test_macos_lifecycle` fail
  with `ModuleNotFoundError: packaging.aipster_tray`, which is an environment
  artifact and not a source defect.

## Baseline evidence (public main `0e6b608`, Linux)

| Check | Result |
|---|---|
| `python3 -S -m unittest test_macos_lifecycle` (cwd `local-worker`) | 12 ran, OK, 1 skipped (macOS-only) |
| `python3 -m unittest test_launchd_template` (cwd `packaging/macos`) | 5 ran, OK, 1 skipped (`plutil` is macOS-only) |
| `py_compile packaging/icon/icon.py` | OK |

## Portable tests to run on the exact patch (cloud-runnable)

These are defined here and run only once `f48ec58` is in hand. Each one is stdlib-only
and runs on Linux.

1. **Manifest**
   - The manifest is valid JSON. It records the version, the source pin (`f48ec58`), and an artifact name, size and `sha256` that match the bytes on disk.
   - The payload list is sorted, has no duplicates, uses relative POSIX paths, and has no `..` or absolute entries.
   - `payload_size` equals the sum of the file sizes, and each file's `sha256` matches when recomputed.
   - The `SHA256SUMS` line agrees with `artifact_sha256`. This mirrors the Windows `build.py` manifest shape.
   - The manifest holds no secret patterns (the same regex as `test_launchd_template`), no absolute home paths, and no `/private/tmp` build paths.
2. **Icon**
   - Any generated mac icon assets come from `packaging/icon/icon.py` geometry, with no third-party art.
   - If an `.icns` file or iconset PNGs ship, parse the `icns` header and type codes (`ic07`–`ic14`, `is32`/`il32` as present) and check that each PNG decodes with a correct size.
   - The 16/32 px legibility renders exist.
   - The state-dot semantics stay local-process only: the honesty gate in `aipster_tray/state.py` still passes.
3. **Import**
   - Every new or changed Python module imports on Linux with no AppKit or PyObjC present, and any mac backend import is lazy or guarded the way `controller.py` guards `backend_win32`.
   - `backend_headless` still drives the full controller.
   - No import-time side effects: no launchd calls, no file writes outside a temp data dir, and no network.
4. **Artifact (static)**
   - If a `.app` tree, zip or tarball is provided, list its contents and check them against the manifest.
   - `Info.plist` parses with `plistlib`. It has a `CFBundleIdentifier` under `dev.aipster.*`, a version equal to the manifest version, and no `LSUIElement` or login-item claim beyond what the patch declares.
   - The launchd template passes the existing `test_launchd_template` assertions: restart on crash only, with no secrets.
   - There are no symlinks escaping the bundle and no world-writable modes.
5. **Regression**
   - Rerun the baseline rows above, plus `windows/test_packaging.py` and the headless parts of `qualify.py` if shared `aipster_tray` code changed.

## Boundary: requires an authorized Mac executor

The following cannot be produced or verified in this cloud lane, and no claim is made for them:

- building the `.app` bundle
- PyObjC or AppKit runtime and the menu-bar UI
- `plutil -lint`, `iconutil`, `codesign` or notarization
- loading or unloading with `launchctl`
- native install or uninstall
- Gatekeeper behavior

Each needs an authorized Mac executor under the native Mac owner.

## Constraints kept

- No UI or backend edits.
- No installer, runtime, config, credential, migration, security or production changes.
- The rejected gate exception is preserved, and DGM stays off with cap zero.
- No public reviews, acceptance or approval.

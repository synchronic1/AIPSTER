<!-- Built with Meta Muse. -->
# AIPSTER local-worker packaging

Ships the reviewed standalone worker (`local-worker/`, `ganglion-dendrite 0.1.0`,
source pin `242c530`) as genuine platform installers. Users never need
Git, uv, or a system Python to run the packaged worker.

## Tooling decision (Windows x86-64 first)

| Candidate | Verdict | Reason |
|---|---|---|
| PyInstaller 6.x (freeze) + NSIS 3.x (installer) | **chosen** | Freeze runs from the same `uv pip install --require-hashes --only-binary` venv as `install.py`, so the hash-locked supply chain is preserved end to end. NSIS gives a real consent-based wizard (location choice, license, opt-in autostart defaulting off) plus a reviewable uninstaller. Both are actively maintained; PyInstaller 6.22.x supports CPython 3.12. |
| BeeWare Briefcase (MSI/DMG/AppImage) | rejected | Single-tool cross-platform story, but it installs app dependencies with plain pip (`==` pins, no `--require-hashes`), a supply-chain downgrade this project does not accept. |
| pynsist | rejected | Purpose-built for this shape, but last released January 2023 (2.8); effectively unmaintained. Windows-only. |
| Nuitka | rejected | Compiler approach: slow builds, larger audit surface, commercial-leaning support; no benefit for an I/O-bound local server. |
| cx_Freeze | rejected | Maintained but lower-profile; still needs a separate installer wrapper, so no advantage over PyInstaller. |
| PyOxidizer | rejected | Upstream development stalled; not a maintained foundation. |

License note: PyInstaller is GPL-2.0-or-later WITH a bootloader exception that
permits frozen applications under any license. The exception note ships in
`licenses/` inside every install. The worker itself stays Apache-2.0.

## Layout

```text
packaging/
  README.md                  this file
  BUILD-REPORT.md            latest qualified build: hashes, tests, screenshots, gaps
  aipster_tray/              tray controller (Windows backend; portable core)
    state.py                 pure state/menu/balloon model + honesty gate + state file
    child.py                 worker child lifecycle (no-window spawn, job object, logs)
    ipc_win32.py             single-instance mutex + window-message commands
    controller.py            state machine, supervision, CLI, message pumps
    backend_win32.py         tray icon/menu/balloons via ctypes (zero new deps)
    backend_headless.py      stub backend: full behavior, zero shell calls
    backend_base.py          backend interface
    firstrun.py              shared first-run setup (data dir, token, config)
    win32.py                 typed ctypes bindings (untyped calls truncate handles)
  icon/
    icon.py                  original tray icon generator (stdlib only)
    ICON.md                  icon design + regeneration
    tray.svg                 vector master
  windows/
    build.py                 orchestrated build: locked venv -> freeze -> licenses -> NSIS -> manifest
    dendrite.spec            PyInstaller spec (three exes, one shared directory)
    cli_entry.py             frozen `dendrite` CLI entry (serve/inspect)
    launcher.py              frozen `aipster-worker` entry (foreground server + tray CLI)
    tray_entry.py            frozen `aipster-tray` entry (windowed tray controller)
    default.toml             default config template (loopback, mock engine, simulation only)
    worker.nsi               NSIS installer script (per-user, consent-based)
    icons/                   tray-ok/warn/off multi-resolution ICOs (generated)
    installer-build.in       build-tool pins; compiled to hash-locked installer-build.lock
    installer-build.lock     hash-pinned PyInstaller toolchain (generated, committed)
    qualify.py               packaged-app qualification (full + coexistence profiles)
    screenshots.py           drives the real installer UI for UX screenshots
    build/                   scratch (gitignored): venv, freeze output
    dist/                    artifacts (gitignored): Setup exe, manifest.json, SHA256SUMS
```

## Tray architecture (Windows)

`aipster-tray.exe` is the primary desktop entry (windowed: no console). It
runs a hidden controller window, supervises at most one `dendrite serve`
child, and presents state through a backend:

- `backend_win32`: real tray icon (state-colored ICO), popup menu rendered
  from `state.menu_model`, balloon notifications. Needs an interactive
  desktop; reviewed by reading + owner-VM capture (see BUILD-REPORT.md).
- `backend_headless`: identical controller behavior with zero shell calls.
  Everything behind the menu (states, IPC, supervision, recovery) is covered
  through this backend by `qualify.py`, including on headless CI.

States describe the **local worker process only**: stopped, starting,
running, port_busy, error. There is deliberately no connected or
inference-ready state — pairing is not implemented and dispatch stays
disabled — and `state.check_honest` fails the import if any shipped template
overclaims. The menu carries a disabled "Pairing: not implemented" line.

Single instance per data directory: a named mutex plus window-message IPC
(`tray status|start|stop|restart|quit`, also via `aipster-worker tray ...`
for visible console output). A second launch reuses the running instance
(status balloon, worker relaunched if stopped) and exits 0; it never starts
a duplicate worker or fights for the port.

Ownership: the child is spawned with `CREATE_NO_WINDOW`, piped into a
size-bounded rotating log (1 MiB x3), and — on normal desktop launches —
joined to a kill-on-close job object, so a parent crash can never orphan a
worker. Quit stops the owned child, removes the icon, and exits; nothing
else is signaled. Crashes restart with backoff (1s/5s/15s, max 3 per 5 min)
then park in an honest error state; a busy port never restart-loops.
`data/state.json` records state, detail, pid, endpoint, restarts, and
version on every transition plus a 30s heartbeat.

Job-object caveat: under a sandboxed launcher the process already belongs to
a job that forbids nesting, so assignment fails. That failure is logged with
its Win32 reason (`confined=False confine_error=...`), and the strict
orphan-kill test runs only where confinement engaged. Explicit Quit/stop
paths terminate the child directly and work everywhere.

macOS/Linux have no tray backend in this milestone; the controller core
(`state`, supervision design) is portable, and non-Windows runs refuse with
a clear message instead of pretending.

## Security properties (Windows)

- Per-user install, no elevation: default `$LOCALAPPDATA\Programs\AIPSTER-Worker`,
  registry under HKCU only. No service, driver, firewall rule, or network touch.
- Install location is selectable (Directory page). Shortcuts (Start Menu,
  desktop, optional) launch the stable installed tray exe.
- Autostart is an explicit opt-in, default OFF (components page checkbox, or
  scripted `/AUTOSTART=1`). It registers a per-user login entry, not a system
  service; the UI labels it exactly that. Uninstall always clears it.
- First run creates `%LOCALAPPDATA%\AIPSTER-Worker\` holding `config.toml`,
  `api-token.txt`, `state/`, `logs/`. The token is 256-bit `secrets.token_urlsafe`,
  stored user-ACL-only (`icacls /inheritance:r /grant:r <user>:F`), injected via
  `DENDRITE_API_TOKEN`, and never printed or logged. Rotation: delete
  `api-token.txt` (or `aipster-worker --rotate-token`) and restart.
- Default bind is loopback-only (`127.0.0.1:8090`); the mock engine is simulated
  and downloads nothing. Host/Origin/token enforcement is the worker's own
  reviewed code, unchanged by packaging.
- Upgrade/reinstall never touches the data directory, so config, token, state,
  and logs survive. Uninstall removes the app, shortcuts, and registry, and
  preserves the data directory by default; a removal checkbox (or scripted
  `/REMOVEDATA=1`) deletes the default data dir on explicit choice. A custom
  `AIPSTER_WORKER_DATA` folder is never touched by uninstall.
- The installer and app ship no website source, dev tests, secrets, machine
  configs, or model weights. The manifest lists every shipped file with SHA-256.

## Build & qualify (Windows x86-64)

The token directory and existing/new token files must belong to the current
process user. First run establishes a protected DACL containing only that
user's SID and fails closed if it cannot; token publication is atomic and a
concurrent first-run winner is retained. File-backed tokens are re-read for
every tray child start; explicitly inherited environment tokens keep priority.
IPv6 loopback probes and displayed URLs use the configured address family.
Crash restart closes the old job handle before launching the next child.

Uninstall removes only files listed in the build's generated payload include
and empty directories. An install location containing unrelated user files
remains on disk with those files preserved. Explicit `/REMOVEDATA=1` remains
the separate default-data removal choice. Builds include the exact pinned
CPython distribution's `LICENSE.txt`, alongside dependency notices, and run
`windows/test_packaging.py` before freezing. Qualification verifies native ACLs
by SID and protection state rather than localized `icacls` display strings.

Prerequisites: Windows 10 1809+ / 11 x86-64, `uv 0.12.12` on PATH,
NSIS 3.13 (`makensis` on PATH; `winget install NSIS.NSIS`), network to PyPI.

```powershell
cd local-worker
python packaging/icon/icon.py                 # regenerate ICOs after mark changes
python packaging/windows/build.py            # -> packaging/windows/dist/
python packaging/windows/qualify.py          # full profile (refuses if a live install exists)
python packaging/windows/qualify.py --app-dir packaging/windows/build/freeze/app
                                             # coexistence profile: behavior-only, no install touch
$env:AIPSTER_SCREENSHOTS_OK=1                # screenshots pop wizard windows on the
python packaging/windows/screenshots.py      # interactive screen: never run while
                                             # the user is active, and never in CI
```

Profiles: `qualify.py` without flags installs/uninstalls and owns the HKCU
singletons; it refuses when a live install is registered. With `--app-dir`
it tests the frozen behavior (console + tray matrices) without installing
anything, using dynamic ports so a live worker keeps 8090. Installer paths
print explicit SKIP lines in coexistence; CI runs the full profile on fresh
runners.

`screenshots.py` drives the real desktop UI with keystrokes. It refuses to run
without `AIPSTER_SCREENSHOTS_OK=1`, verifies the wizard window before every
keystroke, and aborts if the wizard is closed externally — keystrokes must
never land in another application. `qualify.py` is silent and headless-safe.

Owner-VM tray verification (manual; no isolated desktop exists on the dev
machine): install, launch from the shortcut, confirm the tray icon appears
(Windows 11 hides new icons in the overflow flyout — expected), right-click
for the menu (status lines, dashboard/logs/pairing items, Start/Stop, Quit),
re-run the shortcut (status balloon, no duplicate), Quit (icon gone, port
freed). Behavior behind every item is headless-covered; the VM proves pixels.

Reproducibility pins: CPython 3.12.14 (via uv), `requirements.lock`,
`build-requirements.lock`, `installer-build.lock` (all `--require-hashes`),
vendor tree verified by `verify_vendor.py --check-patches`, NSIS 3.13.
`build.py` records every pin plus the source SHA in `dist/manifest.json`.
The Setup exe itself is not byte-reproducible (NSIS embeds timestamps); the
payload inventory in the manifest is the stable comparison surface.

## Signing status

Builds are **unsigned**. Windows SmartScreen will show an "Unknown publisher"
warning. Do not disable OS security features. The supported trust path until a
release is signed is: download only from the AIPSTER GitHub release page and
verify the SHA-256 against `SHA256SUMS` / the dashboard checksum.

Blocker (needs an owner account action, not a code change): an EV/OV
code-signing certificate enrolled for the release workflow, then
`signtool` signing of the frozen exes and the Setup exe in CI.

## Staged platform plan

| Target | Format | Status |
|---|---|---|
| Windows x86-64 (10 1809+/11) | NSIS Setup exe, PyInstaller one-dir payload, tray | **this change** |
| macOS Apple Silicon (14+) | signed + notarized DMG, PyInstaller payload, menu bar | pending: build on macOS runner, Apple Developer signing, notarization ticket |
| macOS Intel (13+) | signed + notarized DMG, PyInstaller payload, menu bar | pending: same, Intel runner |
| Linux x86-64 (glibc 2.31+) | AppImage or .deb, PyInstaller payload, tray | pending: oldest-supported glibc build image, desktop entry |
| Linux ARM64 | AppImage or .deb | pending: depends on native-wheel availability for psutil/pydantic-core |

One identical binary cannot run across these OSes; each target gets its own
native build and qualification. Unsupported targets stay visibly pending in the
dashboard (see `website/public/app/app.js` `INSTALLERS`).

## Dashboard wiring

The Connect card renders a download only for entries shaped
`{ available: true, url, sha256, version }` with a releases/download URL and a
64-hex checksum. Until the release owner uploads, a qualified-but-unpublished
platform is shaped `{ available: false, packaged: true, version, sha256,
built_from }`: the card shows the version, checksum, and build source with an
honest "release file not published yet" state and no link. The wired hash is
the qualified clean-tree build; the release owner rebuilds from the merge
commit and re-verifies before upload.

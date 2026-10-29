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
  windows/
    build.py                 orchestrated build: locked venv -> freeze -> licenses -> NSIS -> manifest
    dendrite.spec            PyInstaller spec (two console exes, one shared directory)
    cli_entry.py             frozen `dendrite` CLI entry (serve/inspect)
    launcher.py              frozen `aipster-worker` entry (first-run setup + foreground server)
    default.toml             default config template (loopback, mock engine, simulation only)
    worker.nsi               NSIS installer script (per-user, consent-based, data-preserving)
    installer-build.in       build-tool pins; compiled to hash-locked installer-build.lock
    installer-build.lock     hash-pinned PyInstaller toolchain (generated, committed)
    qualify.py               packaged-app qualification (scrubbed environment, install/uninstall)
    screenshots.py           drives the real installer UI for UX screenshots
    build/                   scratch (gitignored): venv, freeze output
    dist/                    artifacts (gitignored): Setup exe, manifest.json, SHA256SUMS
```

## Security properties (Windows)

- Per-user install, no elevation: default `$LOCALAPPDATA\Programs\AIPSTER-Worker`,
  registry under HKCU only. No service, driver, firewall rule, or network touch.
- Install location is selectable (Directory page).
- Autostart is an explicit opt-in, default OFF (components page checkbox, or
  scripted `/AUTOSTART=1`). It registers a per-user login entry, not a system
  service; the UI labels it exactly that.
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
  preserves the data directory by default (the final page says where it is).
- The installer and app ship no website source, dev tests, secrets, machine
  configs, or model weights. The manifest lists every shipped file with SHA-256.

## Build & qualify (Windows x86-64)

Prerequisites: Windows 10 1809+ / 11 x86-64, `uv 0.12.12` on PATH,
NSIS 3.13 (`makensis` on PATH; `winget install NSIS.NSIS`), network to PyPI.

```powershell
cd local-worker
python packaging/windows/build.py            # -> packaging/windows/dist/
python packaging/windows/qualify.py          # silent install, server tests, uninstall
$env:AIPSTER_SCREENSHOTS_OK=1                # screenshots pop wizard windows on the
python packaging/windows/screenshots.py      # interactive screen: never run while
                                             # the user is active, and never in CI
```

`screenshots.py` drives the real desktop UI with keystrokes. It refuses to run
without `AIPSTER_SCREENSHOTS_OK=1`, verifies the wizard window before every
keystroke, and aborts if the wizard is closed externally — keystrokes must
never land in another application. `qualify.py` is silent and headless-safe.

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
| Windows x86-64 (10 1809+/11) | NSIS Setup exe, PyInstaller one-dir payload | **this change** |
| macOS Apple Silicon (14+) | signed + notarized DMG, PyInstaller payload | pending: build on macOS runner, Apple Developer signing, notarization ticket |
| macOS Intel (13+) | signed + notarized DMG, PyInstaller payload | pending: same, Intel runner |
| Linux x86-64 (glibc 2.31+) | AppImage or .deb, PyInstaller payload | pending: oldest-supported glibc build image, desktop entry |
| Linux ARM64 | AppImage or .deb | pending: depends on native-wheel availability for psutil/pydantic-core |

One identical binary cannot run across these OSes; each target gets its own
native build and qualification. Unsupported targets stay visibly pending in the
dashboard (see `website/public/app/app.js` `INSTALLERS`).

## Dashboard wiring

The Connect card renders a download only for entries shaped
`{ available: true, url, sha256, version }` with a releases/download URL and a
64-hex checksum. This change ships the Windows package and its SHA-256 to the
release owner; the button flips to available when the release owner uploads the
verified artifact, in a follow-up diff that only touches that entry.

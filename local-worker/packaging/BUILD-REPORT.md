<!-- Built with Meta Muse. -->
# Windows worker build report — installer + tray milestone

## Qualified artifact

| Field | Value |
|---|---|
| Artifact | `AIPSTER-Worker-0.1.0-win64-setup.exe` |
| Size | 13,074,277 bytes |
| SHA-256 | `7f463aae8ac1e620f8794335810a0959e039e5f7d2a1f0b955f0b4613eae0e5d` |
| Built from | `cd715b3daf4acad24e527f6946ea380fa991a1bc` (clean tree) |
| Payload | 96 files: 3 exes, 3 tray ICOs, licenses, default config, build manifest |
| Worker | ganglion-dendrite 0.1.0, source pin `242c530` + patch `0001` (verified) |
| Toolchain | CPython 3.12.14, uv 0.12.12, NSIS 3.13, PyInstaller 6.22.3 (all hash-pinned) |

Full per-file hashes: `packaging/windows/dist/manifest.json` + `SHA256SUMS`
(gitignored; regenerable from the commit above with `build.py`).

Reproducibility evidence (two same-source builds compared): 96/96 payload
paths identical, 91/96 byte-identical. The 5 that vary are the 3 frozen exes
+ `base_library.zip` (PyInstaller/CPython embed timestamps) and `BUILD.json`
(which records `built_at` + the artifact hash). Pins, toolchain, source SHA
and all 91 data files are stable; `payload_size` matches while the NSIS
`artifact_size` varies with compression. Verification is therefore
rebuild-from-source-SHA + re-qualify, not byte-match.

## What this milestone ships

- **Genuine per-user installer**: license page, selectable location, Start
  Menu + desktop shortcuts to the stable installed tray exe, autostart
  opt-in defaulting off (`/AUTOSTART=1` scripted), 3-exe running check,
  Add/Remove entry, uninstall that clears shortcuts/startup/registry and
  preserves data by default (removal checkbox default-off, `/REMOVEDATA=1`).
- **Windowed tray app** (`aipster-tray.exe`, no console): supervises one
  `dendrite serve` child (no-window spawn, kill-on-close job confinement,
  rotating logs), five honest local-only states (never "connected" or
  "inference ready" — the import-time honesty gate fails the build otherwise),
  single-instance-per-data-dir with window-message IPC
  (`status|start|stop|restart|quit`, also via `aipster-worker tray ...`),
  second-launch reuse, crash backoff (3 per 5 min, then parked error), busy-port
  fast path, `state.json` + heartbeat. Menu: dashboard, logs, disabled
  "Pairing: not implemented" line, Start/Stop, Quit.
- **Original tray icon**: peach "A" on a dark tile with a state dot; ICOs
  verified legible at 16px; `packaging/icon/icon.py` is the editable source.
- **Dashboard**: Windows entry is now `packaged` (version + SHA-256 + build
  source shown, no link) instead of "coming soon"; macOS/Linux stay honestly
  unavailable. No URL is wired: there is nothing to download until the release
  owner publishes the verified file.
- **CI**: `worker-installer-build.yml` builds + qualifies (full profile) on
  `windows-2025`, then drives `screenshots.py` on the runner desktop and
  uploads the wizard/console/uninstall PNGs as run-scoped review artifacts
  (pinned `upload-artifact` v5). Publishes no release.
- **Review fixes in this build**: restart reload re-reads the filed token
  (only a parent-preset env token wins); the port probe is family-aware
  (busy only when every resolution fails) with one bracketed-IPv6 URL
  builder; token ACL hardening verifies by read-back with diagnostics and
  qualify distinguishes a restricted OS context (recorded NOTE) from an
  app failure.

## Tests observed (this machine)

- `qualify.py --app-dir <build output>` (coexistence): **52 PASS, 0 FAIL** —
  PE subsystems (tray windowed, launcher/CLI console), ICO validity (7 PNG
  sizes incl. 16/32/48), pure state/menu/honesty/rotation/instance-tag checks,
  IPv6/port-probe matrix (`http_origin` bracketing, bound/free IPv4+IPv6,
  multi-address all-fail, unresolvable-host), reload/preset token checks,
  headless tray matrix T1–T12 (run, reuse, status/stop/start/restart/quit via
  CLI, crash restart, bounded giveup + manual recovery, port-busy + retry,
  token secrecy, strict fresh-run ACLs, confinement observability, token
  rotation across restart: old 401/new 200 through the frozen exes),
  no listeners left.
  4 explicit skips: install/registry/shortcuts/uninstall (live install owns
  the HKCU singletons — covered by the CI full profile) and the strict
  parent-death orphan kill (no job nesting under this sandboxed launcher;
  strict wherever confinement engages).
- CI full profile (`windows-2025`, runs `40932568817` + `40935178276`):
  **0 failures** — silent install, registry/shortcuts, autostart
  default-off, console-launcher matrix, tray matrix T1–T12, uninstall
  preserve + `/REMOVEDATA=1`. Both token-ACL checks record `[restricted
  ACL context]` (runner `icacls` strips inheritance yet `SYSTEM` +
  `BUILTIN\Administrators` persist as explicit ACEs — proven environmental
  by the identical-command scratch probe; strict user-only passes on a real
  machine).
- Website: **262/262** `npm test`, plus `npm run check` and `npm run build`
  green, lockfile untouched.
- Live install preserved throughout: same worker PID before/after, healthy
  on 8090, registry + Start Menu intact (verified, not assumed).

## Screenshots

CI `windows-installer-screenshots` artifact, run `40935178276` (isolated
runner desktop, never the owner's screen; all PNGs eyeballed):
`01-welcome`, `02-license` (Apache text renders), `03-components`
("Start when I log in" unchecked by default; desktop shortcut checked),
`04-directory` (temp path prefilled, editable, Browse offered),
`05-installing` + `06-finish` (byte-identical: install finished in <3s, both
show the Finish page; "Start AIPSTER Worker now" unchecked; honest
"Nothing is shared or paired" copy), `07-start-menu` (caught Explorer's
"Working on it..." spinner twice — the listing itself is log-verified as
`['AIPSTER Worker.lnk', 'Uninstall.lnk']`; the driver now waits for the
entries before shooting), `08-worker-console` (firstrun/config/`listen:`
lines, uvicorn up; the token-ACL warning renders with user/rc/aces and no
secret; token path only, never the value),
`09-uninstall-confirm`, `10-uninstall-data-choice` ("Also remove my worker
data" unchecked by default), `11-uninstall-data-notice` ("was preserved.
Delete that folder manually if you want it gone"), `12-uninstall-finish`.
Log asserts: `installed: True`, `install removed: True`,
`data preserved: True`.
- **Tray/menu screenshots: blocked, honestly deferred.** No isolated GUI
  environment exists on this machine (no Windows Sandbox binary, no VM, no
  elevation), and UI tests on the active desktop are prohibited. The Win32
  backend is ctypes reviewed-by-reading (typed bindings, handle discipline);
  every behavior behind the menu is headless-covered. The owner VM runs the
  manual tray verification in `packaging/README.md` (icon in overflow,
  menu, reuse balloon, Quit) and captures pixels there.

## Known incident (this machine)

An earlier screenshot run popped the Setup wizard on the active desktop; the
user clicked through it and launched that temp test build, which still runs
(PID 2367672, sim-only loopback). No autostart was set and no token was ever
displayed. The driver now requires `AIPSTER_SCREENSHOTS_OK=1`, verifies the
wizard before every keystroke, and aborts if it is closed externally.

## Remaining gaps (not claimed as done)

1. Signature: builds are unsigned (owner action: code-signing cert + CI).
2. Tray/menu pixels: owner-VM capture + eyeball review (behavior covered).
3. ~~CI full-profile result on the PR~~ RESOLVED: 0 failures on
   `windows-2025` (runs `40932568817`, `40935178276`).
4. macOS/Linux installers: staged, visibly pending (portable controller
   core; no backends yet).
5. Pairing/connected/inference-ready: unimplemented by design; no state,
   string, or screenshot claims otherwise.
6. Release upload + dashboard `available` flip: release-owner action after
   rebuilding from the merge commit and re-verifying the hash.
7. Desktop-opt-out path and the *checked* uninstall data-removal box:
   compiler-checked, owner-VM eyeball (the unchecked box + preserve notice
   are CI-captured in shots 10–11; `/REMOVEDATA=1` is headless-covered).

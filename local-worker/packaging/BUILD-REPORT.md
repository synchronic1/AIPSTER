<!-- Built with Meta Muse. -->
# Windows worker build report — installer + tray milestone

## Qualified artifact

| Field | Value |
|---|---|
| Artifact | `AIPSTER-Worker-0.1.0-win64-setup.exe` |
| Size | 13,073,826 bytes |
| SHA-256 | `b7e2b27668d3b659114dee11da442acccdac51fcd291aa9fb5682e7181b611fe` |
| Built from | `d689d2e7c1982bf843a5ec477a3be821c1948588` (clean tree) |
| Payload | 96 files: 3 exes, 3 tray ICOs, licenses, default config, build manifest |
| Worker | ganglion-dendrite 0.1.0, source pin `242c530` + patch `0001` (verified) |
| Toolchain | CPython 3.12.14, uv 0.12.12, NSIS 3.13, PyInstaller 6.22.3 (all hash-pinned) |

Full per-file hashes: `packaging/windows/dist/manifest.json` + `SHA256SUMS`
(gitignored; regenerable from the commit above with `build.py`).

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
  `windows-2025`; uploads nothing, publishes no release.

## Tests observed (this machine)

- `qualify.py --app-dir <build output>` (coexistence): **0 failures** —
  PE subsystems (tray windowed, launcher/CLI console), ICO validity (7 PNG
  sizes incl. 16/32/48), pure state/menu/honesty/rotation/instance-tag checks,
  headless tray matrix (run, reuse, status/stop/start/restart/quit via CLI,
  crash restart, bounded giveup + manual recovery, port-busy + retry, token
  secrecy, fresh-run ACLs, confinement observability), no listeners left.
  4 explicit skips: install/registry/shortcuts/uninstall (live install owns
  the HKCU singletons — covered by the CI full profile) and the strict
  parent-death orphan kill (no job nesting under this sandboxed launcher;
  strict wherever confinement engages).
- Website: **262/262** `npm test`, plus `npm run check` and `npm run build`
  green, lockfile untouched.
- Live install preserved throughout: same worker PID before/after, healthy
  on 8090, registry + Start Menu intact (verified, not assumed).

## Screenshots

- Wizard (from `dist/shots/`, gitignored): `01-welcome`, `02-license`
  (Apache text renders), `03-components` (autostart off by default),
  `04-components-autostart-checked` (actually unchecked — the scripted toggle
  missed; opt-in is qualify-covered via `/AUTOSTART=1`), `05-directory`
  (temp path prefilled), `06-installing` (**shows the Finish page**: install
  finished in <3s; "Start now" unchecked by default).
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
3. CI full-profile result on the PR (install/uninstall/registry/shortcut
   paths untested locally by design).
4. macOS/Linux installers: staged, visibly pending (portable controller
   core; no backends yet).
5. Pairing/connected/inference-ready: unimplemented by design; no state,
   string, or screenshot claims otherwise.
6. Release upload + dashboard `available` flip: release-owner action after
   rebuilding from the merge commit and re-verifying the hash.
7. Desktop-opt-out and uninstall-checkbox UI paths: compiler-checked, owner-VM
   eyeball (scripted equivalents `/AUTOSTART`-style and `/REMOVEDATA=1` are
   headless-covered).

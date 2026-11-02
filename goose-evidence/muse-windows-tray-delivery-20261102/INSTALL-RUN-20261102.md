# AIPSTER Worker (Windows tray): install/run instructions

Lane: GOOSE-WINDOWS-TRAY-DELIVERY-20261102 (Muse). Source `cd5c2ef`.
Status: NO qualified artifact exists yet for this source — no install is
possible from these instructions until the artifact below exists. Nothing here
is executed; JJP install additionally requires the rollout procedure in
`STATUS-AND-ROLLOUT-20261102.md` and exact approval.

## 1. Obtain the artifact (gating precondition)

- Source: rebuilt from the reviewed merge commit (current lane `cd5c2ef`;
  release owner re-verifies at build time), re-qualified, SHA-256 recorded.
- At lane close: local heavy build NOT admitted (commit-free 18,952 MB <
  24 GB gate, re-measured 2026-11-02); no `worker-installer-build.yml` run
  exists on `main` — recent successes are PR-branch review builds
  (`ds/inference-integration-20261101 @5bf623c` run 41363198300,
  `muse/worker-connect-followup @235733d` run 41224722515), neither built
  from current source.
- CI artifact inspection (2026-11-02, read-only API): both successful runs
  expose ONLY `windows-installer-screenshots` (~360 KB, unexpired) — no
  Setup exe, no `manifest.json`, no `SHA256SUMS` is uploaded by the
  workflow. There is no downloadable installer artifact in CI, current or
  stale. No artifact was downloaded (the inference-branch run is out-of-lane
  scope); no workflow dispatch was triggered (not authorized).
- Concrete unblock paths (both approval-gated): (a) local rebuild when
  commit-free clears ≥24,000 MB with a coordinator-granted heavy slot
  (18,324 MB at last re-measure — still blocked); (b) authorized
  `worker-installer-build.yml` dispatch or release-owner rebuild +
  re-qualify from the merge commit, then wire that exact verified artifact.
- CI trigger-scope inspection (2026-11-02, read-only): the workflow runs on
  `pull_request` touching `local-worker/**`, `LICENSE`, or itself, plus
  parameterless `workflow_dispatch`. Before the workflow change below, a push
  + CI run on the docs-only tray branch could not yield a qualified
  downloadable artifact, for two independent reasons: (1) the branch changed
  only `goose-evidence/*.md`, matching none of the PR paths-filter entries;
  (2) the workflow
  uploads ONLY `dist/shots/*.png` (14-day retention) — the Setup exe,
  `manifest.json`, and `SHA256SUMS` are built and full-profile-qualified on
  the runner (`build.py` then `qualify.py`, no `--app-dir`) but never
  uploaded, so every artifact is ephemeral by design ("publishes no
  release"). Closing this path needs a reviewed workflow change adding an
  installer-artifact upload plus push/PR/dispatch authorization — the upload
  part is now implemented (status note at end of §1, review requested,
  unpushed). The documented release path stands: release-owner hand build
  from the merged commit with the same pinned script, independent review,
  hand upload.
- Qualified artifact OBTAINED 2026-11-02 via authorized demo-program path:
  PR [#66](https://github.com/synchronic1/AIPSTER/pull/66) (draft, unmerged),
  CI run 41402089398 `success`, artifact `windows-installer-qualified`
  (13,140,652 bytes zipped): `AIPSTER-Worker-0.1.0-win64-setup.exe`
  (13,152,228 bytes, SHA-256
  `f9d038b05e13f72e260627ef452a0a13f7348f61126a144b26749556044dbdde`),
  `manifest.json` (SHA-256
  `fd31997aa9ed2510d0a9aba4c810d941ef8e7b19f0489ee7925407f5a77ea8af`,
  both matching `SHA256SUMS`), source `e8a3926b33476051dc93d14a638b1eae2120b34c`
  (PR merge commit: this branch + current main), clean tree, 98 payload files
  incl. `aipster-tray.exe`, toolchain CPython 3.12.14 / uv 0.12.12 /
  NSIS 3.13 / PyInstaller 6.22.3. Manifest keys are identity-only; secret
  scan clean. Review evidence only — NOT a release, NOT published to
  GitHub Releases, NOT installed anywhere.
- Run receipt (re-verified read-only 2026-11-02): workflow "Worker installer
  build" (`worker-installer-build.yml` @ PR head `60e0da9`), event
  `pull_request`, run created 06:46:58Z; runner `windows-2025`; pinned actions
  checkout v6 `d23441a`, setup-uv v7 `94527f2`, upload-artifact v5 `330a01c`;
  toolchain uv 0.12.12 / CPython 3.12.14 / NSIS 3.13 / PyInstaller 6.22.3
  (from manifest). Download scratch dir outside worktree; exe hash MATCHES
  `SHA256SUMS`. Second required check green: Public site asset and build
  checks 3m54s (run 41402089555). Mergeable UNKNOWN (GitHub recompute) —
  do not merge.
- Workflow change implemented 2026-11-02 on this branch (review APPROVED
  60e0da9, PR opened): `worker-installer-build.yml` gains a `windows-installer-qualified`
  upload (Setup exe + manifest + SHA256SUMS, 14-day retention,
  `if-no-files-found: error`, same pinned upload-artifact v5 SHA,
  success-only so only qualified runs publish it). Targeted validation 16/16
  PASS (YAML validity, trigger paths incl. self, pinned action, bounded
  retention, exact upload paths, pre-screenshots capture, no release step, no
  secret references, review-evidence header). Awaiting independent review
  verdict before push/PR/CI run; full proof is the CI run itself.
- Trust path only: download from the AIPSTER GitHub release page and verify
  the SHA-256 against `SHA256SUMS` / the dashboard checksum. Builds are
  **unsigned**: Windows SmartScreen shows "Unknown publisher". Do not disable
  OS security features.

## 2. Install (attended)

1. Close any running AIPSTER worker first (the installer aborts, exit 2
   silent, over `aipster-tray.exe` / `aipster-worker.exe` / `dendrite.exe`).
2. Run the Setup exe for your user account only (no elevation, no service,
   driver, or firewall rule).
3. Wizard: confirm the install location (must be the stable destination, not
   a Temp directory), accept the license, leave "Start when I log in" OFF
   unless explicitly wanted (per-user login entry, not a system service).
4. Finish page: "Start AIPSTER Worker now" is unchecked by default — check it
   only to launch immediately.

## 3. Run (tray-first)

- Launch from the Start Menu or desktop shortcut (`AIPSTER Worker`); both
  target `aipster-tray.exe`, never the bare daemon. The tray icon appears in
  the notification area (Windows 11 may hide it in the overflow flyout).
- First run creates `%LOCALAPPDATA%\AIPSTER-Worker` (`config.toml`,
  `api-token.txt`, `state/`, `logs/`) and serves simulated (mock) compute on
  `127.0.0.1:8090`. Nothing is shared, paired, or contributed.
- Right-click the icon: status lines, Pair (opens the console prompt — type
  the dashboard code there, never into the tray), Connect, Start/Stop,
  Settings (`config.toml`), Copy endpoint address (host:port only, never
  tokens), logs, Quit. A second launch reuses the running instance (status
  balloon, no duplicate worker).
- A heartbeat proves reachability only, never inference readiness.

## 4. Remove

- Uninstall removes the app, shortcuts, and registry; the data directory is
  preserved by default. Check "Also remove my worker data" (or
  `/REMOVEDATA=1`) only to delete it. A custom `AIPSTER_WORKER_DATA` folder
  is never touched.
- Token rotation: delete `api-token.txt` and restart (approval-gated on
  shared machines).

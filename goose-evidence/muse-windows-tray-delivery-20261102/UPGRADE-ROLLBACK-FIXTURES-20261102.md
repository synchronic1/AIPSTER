# Upgrade/rollback fixtures: disposable old/new package + data fixtures

Lane: GOOSE-WINDOWS-TRAY-DELIVERY-20261102 (Muse). Source `74b9d21`.
Status: SPECIFICATION ONLY — not executed. Every fixture below requires the
precondition in `INSTALL-RUN-20261102.md` §1 (reviewed, qualified LOCAL
artifact) plus heavy admission, a coordinator-granted slot, and exact
approval. No fixture touches the live Temp worker, the live sender chain,
enrollment `r_9c27cd5f`, or port 8090.

## Why fixtures, not runs

- No qualified artifact exists for current source (CI successes are
  `ds/inference-integration-20261101 @5bf623c` and
  `muse/worker-connect-followup @235733d` — neither is current main, and the
  former is out-of-lane scope). Local build is heavy-blocked.
- Installer/registry/shortcut behavior cannot be fixture-proved at source
  level; the source-level invariants it depends on are already covered by the
  standing suites (`PackagingTests` 20/20 pinned-venv, `pure_tests` 22/22).

## Fixture definitions (all disposable, temp dirs only)

- Synthetic data only: `pairing.json` carries a `TEST-` enrollment id (never
  the live one), synthetic `config.toml`, synthetic worker `state` file, and
  a synthetic `api-token.txt` created inside the temp dir. No real
  credentials; nothing leaves the temp dir; temp dirs destroyed on completion.
- Old package = the qualified artifact installed once (`v0.1.0+build.1`);
  there is no qualified prior version, so "upgrade" means reinstall-in-place
  and version-forward installs once a newer qualified artifact exists. The
  Temp screenshot payload is never an "old package".

## Fixture matrix (execute in order, stop on first FAIL)

- U1 upgrade-in-place preservation: install → populate disposable data +
  marker file → silent reinstall (exit 0) → assert token file byte-identical,
  `pairing.json`/config/marker intact, registry `InstallDir` still the stable
  destination, shortcuts still tray-pointing. Mirrors `qualify.py`
  full-profile "reinstall preserves token + marker".
- U2 conflict detection: with the tray/worker running from the fixture
  install, run Setup silent → assert exit 2, zero deletions, registration
  preserved. Then approved stop via tray Quit, rerun → exit 0.
- U3 failed-upgrade retry: locked-payload abort → assert registration
  preserved with uninstaller in place, retry succeeds after stop. Mirrors
  `uninstall_failure_matrix` (locked-payload abort, running-process abort).
- U4 rollback-to-clean: uninstall (default, no `/REMOVEDATA`) → assert app
  files gone, data dir fully preserved (names/hashes vs pre-change snapshot);
  `/REMOVEDATA=1` variant on a SECOND disposable data dir only → assert
  default data dir removed, custom-dir fixture never touched.
- U5 sender single-flight across upgrade: with a synthetic external sender
  holding the lock, Start → assert `EXIT_SENDER_RUNNING` recognition, no
  second heartbeat process. Mirrors `TraySenderExternalTests`.

## Approval gates (each step)

Heavy slot + artifact SHA recorded before U1; Peter approval before U2-stop,
before any `/REMOVEDATA=1` (U4), and before destroying temp dirs if retention
is requested. Receipt records: artifact SHA-256, fixture data hashes
(name/size/SHA-256 only), exit codes, and the exact commands run.

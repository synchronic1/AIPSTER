# Worker pairing: packaging/launcher integration handoff

Owner: pairing session (this branch). Consumer: the separate
worker-installer/tray session, which owns `packaging/` exclusively.
This document is the coordination interface — pairing-side changes here
never edit `packaging/` files; installer-side wiring is described so it
can land without a pairing-session edit.

## What the pairing slice provides (this branch)

- `local-worker/pairing.py` and `private_storage_win32.py` — standard library
  only (urllib/TLS, hashlib and native Win32 ctypes). No new third-party
  dependency, so no `requirements.lock` / `installer-build.lock` change.
  - `pair`: exchanges a dashboard code for `{resource_id, heartbeat key}`,
    stored user-private (`pairing.json` manifest + the private
    `heartbeat-key.<generation>.txt` it names). File permissions are 0600,
    directories 0700, and Windows uses a protected current-user DACL, verified
    by native read-back. Only immediately exclusive-created directories and
    empty temp files may normalize the process's default owner to its user SID.
    Existing foreign-owned paths, including Administrators-owned paths, fail
    closed. The helper is shared byte-for-byte with the installer; no PowerShell
    ACL process, privilege change or elevated fallback is used.
    Permission failures stop pairing before the claim or secret publication.
    Honors `AIPSTER_WORKER_DATA` and the installed
    `%LOCALAPPDATA%/AIPSTER-Worker` layout.
  - `heartbeat-once` / `heartbeat-loop`: bounded sender (60 s default,
    30 s floor above the 25 s server window; honors 429/Retry-After;
    exit 4 `RePairRequired` on revoked/expired keys; bounded reconnect
    backoff). `usable` is false unless a real engine is verified (mock
    always false: reachable-but-not-usable).
  - `status` (secret-free) / `unpair` (local forget; server key stays
    live until revoked in the dashboard — printed every time). Failed attempts
    replace success status; `status` derives staleness after five minutes.
    Every heartbeat status binds the sender's captured pairing snapshot
    (origin, resource and selected key generation). Re-pairing ignores older,
    unbound or mismatched status, even when an old in-flight beat writes last.
    Unpair ignores only missing files; any other deletion/enumeration failure
    reports incomplete cleanup and returns nonzero, without a success claim.
- `local-worker/test_pairing.py` — 38 standard-library unit tests (fake
  in-thread API; 3 POSIX-only tests skip on Windows), including the product
  User-Agent and sanitized edge-block diagnostics. The qualified runtime is
  Python 3.12.14; source declares Python ≥ 3.11.
- `local-worker/test_pairing_e2e.py` + `website/scripts/pairing-e2e-bridge.mjs`
  — 7 cross-language scenarios (real CLI against real `worker.js` over
  loopback): two-user isolation, repeat startup + quota, lost-response
  reclaim + rotation, expired/replayed/foreign codes, revocation, delete,
  disabled owner, stale strip, secret-free output, and the installed
  launcher pair/sender/revoke cycle. Needs `node` plus
  `website/node_modules`; skips honestly otherwise.
- `local-worker/test_pairing_security.py` — 15 controlled security/storage
  regressions: redirect refusal, private ACLs, failed/interrupted publication,
  concurrent manifest snapshots, safe legacy reads, truthful status and retries.
- `local-worker/test_pairing_windows_storage.py` — 11 Windows tests for exclusive
  mkdir/mkstemp provenance, empty-temp ACL rejection, existing foreign owners,
  concurrent mkdir collisions, read-only verification and refused replacement.
  With 14 installation tests, 10 lifecycle tests and 7 E2Es the matrix has 95 tests (91 runnable
  and 4 skips on Windows). Fixtures provision only their own new paths;
  no test relaxes existing-path ownership policy.
- `local-worker/test_pairing_lifecycle.py` — 10 regressions covering whole/partial
  unpair failure, missing-file idempotence, enumeration failure, actual Windows
  locked-file deletion, fresh-generation status, old in-flight success/failure,
  and safe legacy status/key rotation.
- Protocol: `docs/pairing.md` (claim) + `docs/heartbeat-intake.md`
  (sender). Claim request/response shapes are fixed by
  `website/tests/pairing.test.mjs`; do not invent a second endpoint.

## Installer-side wiring (LANDED on the worker-connect lane, 2026-10-31)

The tray/packaging side below is implemented in this tree; the item notes
name the landing spots. The handoff contract above (loader, publication,
retention, redirect refusal) still governs both sides.

Credential-reader contract: use `pairing.load_pairing(data_dir)`, not a hardcoded
key filename. The loader reads one atomic `pairing.json` snapshot, validates its
`key_file` basename, checks directory/manifest/key ownership and permissions, then
reads that immutable key generation. Legacy private stores without `key_file`
still read `heartbeat-key.txt`. New manifests also contain a SHA-256 key
fingerprint, checked with constant-time comparison before sending. Older
manifests without a fingerprint retain private-store compatibility; fingerprints
are an additional consistency check, not an alternative to atomic publication.
Pairing writes/protects the new key first and only
then atomically publishes the manifest. Interrupted writes retain an old or a
complete new origin/resource/key tuple. Earlier/private orphan generations are
retained for in-flight readers and removed only by explicit `unpair`; no automatic
garbage collection may remove them. Before claiming again, all retained managed
legacy/generation keys are made private too; a hardening failure stops the claim
and leaves the existing origin/resource/key selection intact. No secret is stored in the manifest. HTTP
redirects are refused, including same-origin redirects and TLS downgrades.

1. Freeze `pairing.py` and its imported `private_storage_win32.py` with the bundle
   (LANDED: `launcher.py pair/sender` import `pairing.main` in-process and
   `state.pairing_overlay` imports it lazily; the spec needed no change
   because its pathex already covers `local-worker/`. Still to verify with
   the frozen smoke test at rebuild time — see BUILD-REPORT.md 2026-10-31.)
2. Launcher/tray UX (LANDED):
   - Pair action: the tray menu Pair item opens `aipster-worker pair` in
     its own console (the windowed tray has no prompt surface); the
     launcher prints the consent line, `pairing.cmd_pair` prompts
     without echo and claims in-process, reporting resource id / key
     prefix only. The code never passes through the tray or any log.
   - Sender: the controller supervises `SenderChild` (`aipster-worker
     sender`, foreground `heartbeat-loop`) while serving when paired,
     including while the daemon's port is busy (outbound HTTPS needs no
     local port). On exit-4-equivalent the tray shows "pair again"; no
     auto-mint, auto-claim, or stored-code retry (none exist). Other
     sender exits report and wait for Start (the sender already backs
     off bounded network retries internally).
   - Status text shows the pairing overlay (resource id, sender line,
     last-beat time); never the code or key. `tray status` carries the
     overlay key from `state.json`.
3. `default.toml` copy (LANDED): points at the dashboard Connect card
   and the tray/`aipster-worker pair` entries.
4. `qualify.py` + e2e (LANDED): T13 drives the FROZEN launcher
   (`pair --code` with a synthetic fixture code, `sender --once`, revoke,
   exit-4, re-pair, supervised tray run to a `reachable` overlay) against
   the e2e bridge in both profiles, and `test_pairing_e2e.py` covers the
   same cycle through the source launcher. Credential-file ACLs after the
   pair, no-code-in-output, and a static uninstall-preserves-data check
   are asserted; sender 429 backoff stays in the unit suites (fake API).
   The bridge (`node website/scripts/pairing-e2e-bridge.mjs`) is the
   supported fake backend: disposable, loopback-only, no Cloudflare.
   Bridge tests SKIP honestly when node or `website/node_modules` is
   unavailable.
5. Do not change: daemon Host/Origin guards, loopback default bind,
   installed paths, token file handling, or autostart defaults. Do not
   pair a developer machine against production for qualification.

## Dashboard side (LANDED on the worker-connect lane, 2026-10-31)

The Connect card mints typed one-time codes (idempotent Pair clicks,
op-fenced replacement, Done/tab-switch/logout clears), derives its
progress stage from the tab's inventory snapshot (setup / pairing /
reachable — reachability only, never readiness), retries failed inventory
reads manually (no auto-loop), and documents the packaged tray/`pair`
entries in Advanced. Pins moved to `3fa309c` (first origin/main HEAD with
the edge-compat sender fix); the superseded packaged build is reported as
rebuild-pending, never as pending-publication. `INSTALLERS` flags and the
stepper flip only when a verified rebuilt build + SHA-256 is published.

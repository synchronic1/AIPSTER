# Worker pairing: packaging/launcher integration handoff

Owner: pairing session (this branch). Consumer: the separate
worker-installer/tray session, which owns `packaging/` exclusively.
This document is the coordination interface — pairing-side changes here
never edit `packaging/` files; installer-side wiring is described so it
can land without a pairing-session edit.

## What the pairing slice provides (this branch)

- `local-worker/pairing.py` — stdlib-only (`argparse, getpass, json, ssl`
  via urllib, `secrets, subprocess, time`). No new third-party
  dependency, so no `requirements.lock` / `installer-build.lock` change.
  - `pair`: exchanges a dashboard code for `{resource_id, heartbeat key}`,
    stored user-private (`pairing.json` manifest + the private
    `heartbeat-key.<generation>.txt` it names). File permissions are 0600,
    directories 0700, and Windows uses a protected current-user DACL.
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
- `local-worker/test_pairing.py` — 17 stdlib-only unit tests (fake
  in-thread API). Run: `python test_pairing.py` with any Python ≥ 3.11.
- `local-worker/test_pairing_e2e.py` + `website/scripts/pairing-e2e-bridge.mjs`
  — 6 cross-language scenarios (real CLI against real `worker.js` over
  loopback): two-user isolation, repeat startup + quota, lost-response
  reclaim + rotation, expired/replayed/foreign codes, revocation, delete,
  disabled owner, stale strip, secret-free output. Needs `node` plus
  `website/node_modules`; skips honestly otherwise.
- `local-worker/test_pairing_security.py` — 15 controlled security/storage
  regressions: redirect refusal, private ACLs, failed/interrupted publication,
  concurrent manifest snapshots, safe legacy reads, truthful status and retries.
- Protocol: `docs/pairing.md` (claim) + `docs/heartbeat-intake.md`
  (sender). Claim request/response shapes are fixed by
  `website/tests/pairing.test.mjs`; do not invent a second endpoint.

## Requested installer-side wiring (installer session owns the edit)

Credential-reader contract: use `pairing.load_pairing(data_dir)`, not a hardcoded
key filename. The loader reads one atomic `pairing.json` snapshot, validates its
`key_file` basename, checks directory/manifest/key ownership and permissions, then
reads that immutable key generation. Legacy private stores without `key_file`
still read `heartbeat-key.txt`. Pairing writes/protects the new key first and only
then atomically publishes the manifest. Interrupted writes retain an old or a
complete new origin/resource/key tuple. Earlier/private orphan generations are
retained for in-flight readers and removed only by explicit `unpair`; no automatic
garbage collection may remove them. Before claiming again, all retained managed
legacy/generation keys are made private too; a hardening failure stops the claim
and leaves the existing origin/resource/key selection intact. No secret is stored in the manifest. HTTP
redirects are refused, including same-origin redirects and TLS downgrades.

1. Freeze `pairing.py` with the bundle (a launcher import picks it up;
   no hidden-import or data-file changes expected — verify with the
   frozen smoke test).
2. Launcher/tray UX (exact surface is the installer session's call):
   - a Pair action that prompts for the code (no echo), calls
     `pairing.cmd_pair`-equivalent in-process or shells the frozen
     module, and reports paired resource id / key prefix only;
   - a sender equivalent to `heartbeat-loop` running while serving
     when paired; on exit-4-equivalent, show "pair again" (do not
     auto-mint, auto-claim, or retry with stored codes — none exist);
   - status text may show resource id, key prefix, last-beat time;
     never the code or key.
3. `default.toml` copy: replace "Pairing is not implemented" with a
   pointer to the dashboard Connect card (installer session edits its
   own file).
4. `qualify.py`: suggested additions — pair prompt presence without
   secret echo, credential file ACLs after a scripted pair against the
   e2e bridge, sender backoff on injected 429, uninstall preserves
   `pairing.json` and its private key generations with the rest of the data dir.
   The bridge (`node website/scripts/pairing-e2e-bridge.mjs`) is the
   supported fake backend: disposable, loopback-only, no Cloudflare.
5. Do not change: daemon Host/Origin guards, loopback default bind,
   installed paths, token file handling, or autostart defaults. Do not
   pair a developer machine against production for qualification.

## Dashboard side (pairing session, separate PR)

The Connect card gains code mint + pairing-state copy; `INSTALLERS`
flags and the stepper flip when the installer session publishes a
verified build + SHA-256. Until then the UI keeps saying "no verified
installer" — the honest state.

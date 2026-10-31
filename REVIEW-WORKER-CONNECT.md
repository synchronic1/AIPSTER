# Worker one-click connect — Stage 3 review (scoped revalidation)

Lane: `muse/worker-one-click-connect` @ `aipster-worker-connect/`.
Reviewed SHA: `c5ce7f051b5aa56f50fc2347025d995eb1fe84d8` vs `origin/main`
(`3fa309cb08461ea046ee23e801404911c1f3bcc2`): 22 files, +1641/-187.
Verdict: **0 fixes-required, 3 advisory**. No second implementation round needed.

## Scope and limit

- Reviewed the exact diff file-by-file: every new/changed implementation and
  test body was opened (pairing.py, aipster_tray/{state,child,controller,
  backend_*}, launcher.py, build.py, qualify.py incl. T13, test_packaging.py,
  test_pairing.py incl. EdgeDiagnosticsTests, test_pairing_e2e.py launcher
  test, app.js, both UI test files, all six doc/packaging text diffs).
- Server pairing contract (`website/src/worker.js`, `migrations/`,
  `website/scripts/`) has **zero diff lines**: binding, single-use, expiry,
  reclaim, and revocation semantics are inherited unchanged (verified via
  `git diff --name-only` plus route/migration reads at HEAD).
- LIMIT: this revalidation ran in the same session chain as Stages 1–2 and
  reuses their inspected evidence where it names exact lines; it is a scoped
  diff review plus independently re-run gates, not a from-scratch audit of
  server history.
- No implementation file was edited in this stage. This document is written
  uncommitted in the worktree by design.

## Checklist (all covered against bodies)

- Pairing binding: unchanged server-side (mint requires session `me()`,
  demo/disabled owners rejected, `expires_at`/`used_at`/`attempts` enforced,
  reclaim re-binds same node with a FRESH key). Client honors it: no
  auto-mint/auto-claim anywhere (`controller.start_sender` only starts when
  `pairing.json` exists; e2e asserts "no duplicate row", "lost key rotated").
- Credential hygiene: codes/secrets never in URLs/logs/analytics/copied
  commands. `launch_pair` logs only `(exe, ["pair"])`; `pair_target` never
  yields `--code`; tray overlay/state.json carry ids only; sender prints
  `heartbeat ok: usable=… at=…` only; UI test proves the minted bearer is
  "typed, never clipboarded" and agent packets match no credential shape.
- Local-endpoint guards: `check_api_base` unchanged (https, or http loopback
  for tests); `check.mjs` privacy gate passes (no loopback in public JS);
  launcher refuses a busy port with exit 2; tray maps busy to `port_busy`.
- Storage + revocation reuse: overlay reads via `load_pairing` /
  `pairing_files` / `pairing_status_binding` (generation-bound, 5-min stale);
  unpair semantics untouched; uninstall still preserves pairing by default
  (`worker.nsi` diff is label text only); server revocation routes untouched.
- Port-8090 behavior: no kill/steal/duplicate path exists. Busy port means
  no daemon spawn + `port_busy` notify + port-independent sender start
  (unit-tested); single-instance reuse unchanged (T2). PID 2367672 verified
  alive on 127.0.0.1:8090 before and after all gates; nothing signaled.
- Pin-correction: zero `f3e115e` at HEAD (`git grep` empty).
  `WORKER_COMMIT`/`DOCS_COMMIT`/README/UI pins all `3fa309c`, which contains
  `adfe357` (`merge-base --is-ancestor` true for HEAD, false for `f3e115e`);
  `USER_AGENT` verified in-tree (pairing.py:59,403). The `cee3390` packaged
  entry is `available:false` with no URL rendered (`installerUsable` gate)
  and will-not-publish copy; BUILD-REPORT.md records the supersession.
- Diagnostics redaction: `edge_block_marker` builds a fixed template from
  status + content class only; tests assert no response bytes echoed
  (`1010`, `<html>`, body text absent). JSON API errors and empty bodies
  keep legacy shapes (explicitly tested).
- Idempotency: mint dup-click guard + op-fenced replacement; copy op-fence;
  Done/tab-switch/logout clear; server idempotency keys untouched; node-id
  racers converge (mutex-tested); re-pair rotates, never duplicates.
- State honesty: tray `check_honest` forbids connected/inference-ready/
  online/live and gates all new templates at import; overlay keys are
  unpaired/registered/reachable/stale/repair-required/actionable-error with
  `usable=` shown; card stepper derives from the inventory snapshot only;
  the `Connected` step label pre-exists the diff and is now gated on a
  fresh heartbeat with "Reachability only" body text.
- No silent enrollment / persistence / firewall: pairing needs a typed code
  (empty input cancels); `--code` is fixture-only with an in-help warning
  and is used only with synthetic codes (T13, e2e); no autostart/service/
  firewall/registry behavior changed; sender deaths wait for Start.
- No new paid infra/creds; no live-inference/model-download paths: no new
  bindings/env; `default.toml` stays mock-only; `decide_usable` untouched;
  new code never calls inference endpoints.
- Enrollment `r_9c27cd5f`: paired with a fresh live beat at check time;
  this stage ran only the read-only `status` path against live data and
  started no sender/pair against it. Untouched.
- Other lanes/DGM/S-drive: diff touches none; no contact made.

## Gates re-run by this reviewer (transcript summary)

- `npm run check`: pass (27 files, revision 2026-10-29.2).
- `npm test`: **944/944 pass**, 0 fail.
- `npm run build`: ok (28 assets). `npm run bundle`: dry-run ok.
- Worker suites (`.venv` Python 3.12.14): test_pairing 38 OK (3 POSIX
  skips), test_pairing_e2e 7 OK, lifecycle 10 OK (1 skip), security 15 OK,
  windows_storage 11 OK, installation 14 OK, test_packaging 52 OK =
  **147/147**, matching the counts `PAIRING-INTEGRATION.md` claims
  (95-matrix + packaging split verified arithmetically).
- (PowerShell reported exit 1 on unittest invocations only because dots go
  to stderr; every suite printed `OK`.)
- No server left running: no lingering bridge/node processes after the
  suites; port 8090 still owned by PID 2367672.

## Findings

No fixes-required defects. Advisory only:

1. (advisory) `launcher.py sender/pair --code` passes the code via argv
   (process-list visible). Mitigated: `--help` warns fixture-only, tray
   never passes it, all in-tree uses are synthetic. Keep the warning if
   the flag survives; never thread `--code` through the tray path.
2. (advisory) `pairing.py post_json`: a 4xx with an *empty* body returns
   `{}` without the `EDGE_BLOCKED` marker (explicitly tested as legacy).
   Real edge refusals carry HTML bodies, so the marker fires in practice;
   consider marking empty 403s in a future hardening pass.
3. (advisory) `app.js INSTALLERS.windows` still displays the superseded
   build's SHA-256 "for reference". No download path exists (no URL,
   `available:false`), so this cannot recreate the 403; remove the hash
   line when the rebuilt installer flips the entry to avoid confusion.

## Unresolved

None. Owner follow-ups from Stage 2 stand unchanged (full-profile qualify
on CI/owner VM; release rebuild-from-merge + publish + `INSTALLERS` flip).

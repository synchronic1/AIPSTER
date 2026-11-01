# Worker tray review: Connect/Settings/copy-address (scoped revalidation)

- Reviewed SHA: `5c8a163af1a2b3e430267118a18216ac9ec676b1`
  ("Worker tray: Connect/Settings/copy-address actions with headless tests")
  vs parent `c5ce7f0`, branch `muse/worker-one-click-connect`.
- Scope: the 8 files under `local-worker/packaging/` in that commit ONLY
  (tray Connect/Settings/copy-address actions, clipboard bindings, headless
  backend, tests, README). Nothing else on the branch was revalidated.
- LIMIT: this is a same-session scoped revalidation by a delegated reviewer,
  not an independent second-party review. It re-read every changed
  implementation and test body cited below and re-ran the suite, but it shares
  the session's context and assumptions.
- `packaging/` is byte-identical between the reviewed SHA and HEAD `47cce55`
  (later commits added only `REVIEW-WORKER-CONNECT.md` and
  `docs/worker-connect-release-f5.md`), so working-tree reads reflect the
  reviewed code.

## Verdict: PASS — 0 fixes-required, 4 advisory

No menu-honesty violation, no secret path to the clipboard, no auto-mint, no
autostart/contribution/persistence/firewall/enrollment/port-8090 interference.
Advisories A1–A4 are hardening/naming notes; none blocks.

## Per-file findings

1. `local-worker/packaging/aipster_tray/controller.py` — PASS (advisories A1, A2)
   - `connect()` (L246–268): idempotent no-op when paired + serving +
     sender-running; otherwise `start_worker()` then interactive `launch_pair()`
     only when unpaired. Pairing stays a typed-code console prompt; nothing is
     auto-minted (`start_sender` requires `pairing.json`, L211). Port-busy
     returns `False` (worker not serving) while the pair console still opens —
     honest. New `menu_action` dispatch for `connect`/`settings`/`copy_endpoint`
     (L429–434) is menu-only; `ipc()` untouched, so no remote/auto Connect path.
   - `open_settings()` (L270–276): opens `self.config`, which `prepare()` sets
     from `ensure_setup(data)` = `<data>/config.toml` (`firstrun.py` L123–134);
     missing config logs and returns `""`. Path correct.
   - `copy_endpoint()` (L278–286): payload is `endpoint_label()` =
     `http_origin(host, port)` only — host:port, no token field exists on that
     path. Refuses (`False`, no clipboard call) when unloaded. See A2 for the
     stopped-state caveat.
2. `local-worker/packaging/aipster_tray/state.py` — PASS, no findings
   - New items (L181–188): `connect` "Connect this computer…" (always enabled),
     `copy_endpoint` "Copy endpoint address" (enabled iff endpoint text AND
     state in STARTING/RUNNING — disabled while stopped), `settings` "Settings".
   - No forbidden status word (`FORBIDDEN_STATUS_WORDS`, L57) in any new label:
     verb "Connect …" does not contain substring "connected"; no
     inference-ready/connected/online/live claim anywhere in the addition. New
     labels are gated through `check_honest` by test (see file 7).
3. `local-worker/packaging/aipster_tray/backend_base.py` — PASS, no findings
   - `open_config`/`copy_text` interface additions mirror existing opener
     conventions (return path / bool). No behavior.
4. `local-worker/packaging/aipster_tray/backend_headless.py` — PASS, no findings
   - Stubs record `open_config`/`copy_text` events and suppress shell calls,
     matching the file's no-desktop contract. `copy_text` logs no payload.
5. `local-worker/packaging/aipster_tray/backend_win32.py` — PASS (advisory A3)
   - `open_config` (L166–171): same guarded `ShellExecuteW "open"` pattern as
     `open_logs`. `copy_text` (L173–199): CF_UNICODETEXT via
     Open/Empty/Set/CloseClipboard; handle freed ONLY on `SetClipboardData`
     failure (correct ownership — system owns it on success); clipboard-busy
     degrades to `False` + log line, which the controller reports as "endpoint
     copy failed" (honest). See A3 for the `GlobalLock` NULL note.
6. `local-worker/packaging/aipster_tray/win32.py` — PASS, no findings
   - Clipboard/global-memory bindings (L52–59, L132–139) have correct
     argtypes/restype (handles as HANDLE/HWND, no 32-bit truncation); purely
     additive, no other binding touched.
7. `local-worker/packaging/windows/test_packaging.py` — PASS (advisory A4)
   - New `TrayConnectActionsTests` (12 tests, L658–778) honestly covers the new
     behavior headless: action presence + enabled-matrix in all 5 states;
     exact-label + `check_honest` gate; copy disabled without endpoint text;
     menu dispatch of all three actions; fresh connect (child started once,
     pair console opened, STARTING); paired connect (no console, sender
     started); idempotent no-op (no child start, no console); port-busy
     (`False`, PORT_BUSY, pair console still opened); settings returns the
     data-dir `config.toml` path; copy payload equals `http://host:port` with a
     sentinel token set and asserted absent; copy refusal when unloaded; sender
     reconnect on Start after death. Fakes (`FakeChild`/`FakeSender`,
     L482–536) record without spawning; ports are loopback-ephemeral
     (`free_loopback_port`, L539–542). `8090` in the new tests (L679) is a
     menu-label string only — nothing binds it.
8. `local-worker/packaging/README.md` — PASS, no findings
   - New paragraph accurately describes Connect idempotency, port-busy
     pairs-but-not-serving, host:port-only/never-tokens copy, disabled-while-
     stopped, `config.toml`-from-data-dir Settings, and the no-contribution /
     autostart-opt-in statements. No forbidden status word.

## Interference sweep (new code only)

Grep over the six implementation files for `autostart|AutoStart|RUN_KEY|
firewall|contrib|enroll|8090|inference.ready|connected|online`: the only hits
are the pre-existing honesty-rule comments and `FORBIDDEN_STATUS_WORDS` in
`state.py` (L4, L22, L57 — not added by this commit). No registry, firewall,
persistence, enrollment, contribution, or port-binding path was added.

## Advisory notes (non-blocking)

- A1 (controller `connect`, L254–268): paired + serving but sender-DEAD falls
  through to `start_worker()`'s early-`True` return (which does not restart the
  sender) and logs "sender runs when serving" without reviving it. Consider a
  `start_sender()` call on that path (safe: it requires `pairing.json`, so no
  auto-mint) or softening the log line.
- A2 (controller `copy_endpoint`, L278–286): stopped-state honesty relies solely
  on the menu guard; the method copies the *configured* endpoint whenever
  loaded, even if STOPPED. Consider a serving-state gate, or "configured
  endpoint" wording in the docstring, so the method is honest independent of
  the view.
- A3 (win32 `copy_text`, L188–189): `GlobalLock` return is not NULL-checked
  before `memmove`. Practically unreachable on a fresh alloc, but a defensive
  check (free + fail `False`) would match the file's never-crash contract.
- A4 (test name, L736): `test_connect_is_idempotent_when_connected` uses
  "connected" loosely for paired+serving+sender-up. Test-only, not
  user-visible; consider `..._when_paired_and_serving` for vocabulary
  consistency.

## Test transcript (re-run by reviewer)

Command (from `aipster-worker-connect/local-worker`):

    .\.venv\Scripts\python.exe packaging/windows/test_packaging.py

Result: Python 3.12.14, `Ran 64 tests … OK`, exit 0. All 12
`TrayConnectActionsTests` pass (plus the 52 pre-existing tests — no
regressions). Full per-test list captured during review; failures: none.

## Fixes-required vs advisory

- Fixes-required: none.
- Advisory: A1 (sender-dead edge in `connect`), A2 (menu-only stopped guard on
  copy), A3 (`GlobalLock` NULL check), A4 (test name vocabulary).

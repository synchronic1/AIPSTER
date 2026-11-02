# Mac real-inference client (REQUEST-ORIGIN lane)

PRD: AIPSTER Real Fabric Inference Qualification on JJP, v1.0 (2026-11-01).
Lane: `muse/mac-inference-client-20261102`, based on reviewed PR63 head
`5bf623c11647c7a5340c37575f56d84ff6f04b4c`. Mac is the request origin only;
it never executes the model. This document and its two code artifacts are
Gate A (discovery/source lock) and Gate B (offline) preparation. **Live
inference is HOLD** — see “Exact live HOLD” below. Nothing here authorizes
live execution, activation, migration, credentials, restarts, or deployment.

Owned files (this lane only; no backend/worker/dispatch edits):

- `website/scripts/mac-inference-client-preflight.mjs` — read-only preflight.
- `website/tests/mac-inference-client.test.mjs` — offline synthetic harness.
- This doc plus the external evidence bundle (preflight JSON + test log).

## 1. Source-known facts (verified at the pinned head)

All claims below were re-verified against the lane checkout, not copied from
the PRD inputs file. Preflight check ids in parentheses.

| # | Fact | Source |
|---|---|---|
| 1 | Lease placement is CPU-only on both sides: worker rejects `placement["device"] != "cpu"`; store rejects `task.placement.device !== 'cpu'`; protocol is `aipster-bound-cpu-internal/1` on worker, store, and coordinator. (`src-cpu-only`) | `local-worker/inference_worker.py:368`, `website/src/inference/dispatch-store.mjs:988`, `website/src/inference/dispatch-coordinator.mjs:38` |
| 2 | No GPU/device selection exists: `serve-jobs` offers only `--interval`, `--ganglion-base/--upstream-url`, `--allow-non-loopback-ganglion`, `--runtime-id`, `--models-cache-ttl`, `--once`. No `--gpu`, `--device`, or token-file flag. Upstream auth is env `AIPSTER_GANGLION_TOKEN`, read privately. (`src-no-gpu-cli`) | `local-worker/pairing.py:1060-1075` + executed `--help`; `local-worker/inference_worker.py:85` |
| 3 | `runtime_instance = runtime_id` and `model_fingerprint = model_id` are echoed aliases bound at admission, not runtime attestation or weights digests. (`src-alias`) | `website/src/inference/dispatch-store.mjs:13-14,371-378` |
| 4 | Routes exist only when `INFERENCE_ENABLED === '1'`. Default `POST /api/jobs` returns the exact 501 `INFERENCE_DISABLED` (“Inference dispatch is disabled. No job was created and no compute ran.”); new routes 404 when off. (`src-flag-routes`) | `website/src/worker.js:108-112,2893,2970-2974,3014` |
| 5 | Submit contract is `v1.0.0` with exactly `{contract_version, admission_ref, idempotency_key, model_id, prompt, max_tokens, deadline_at}`; `placement`/`node_id`/`runtime_id` and friends are `FORGED_CLIENT_AUTHORITY`; `temperature` et al are `UNSUPPORTED_PARAMETER`; `stream/cancel/tools` are `UNSUPPORTED_CAPABILITY`. (`src-contract`) | `website/src/inference/dispatch-coordinator.mjs:37-53,84-100` |
| 6 | Bounds: `deadline_at` within 180 s (`INVALID_DEADLINE`); `max_tokens` 1..4096 (`INVALID_MAX_TOKENS`); runtimes `ganglion` or `llama-server` only (`BAD_RUNTIME`); missing owner daily ceiling fails closed to 0 and submit fails `BUDGET_EXHAUSTED` (429). (`src-contract`) | `dispatch-coordinator.mjs:39,105-107,217`; `dispatch-store.mjs:90-95,129-133,318-319`; coordinator `:283-287` |
| 7 | Cancel before start fences and releases; after start it returns `cancel: UNSUPPORTED_CAPABILITY` with `remote_stopped: false` and holds retained. No execution-cancel frame exists; timeout must never claim remote execution stopped. (`src-contract`) | `dispatch-coordinator.mjs:452-465` |
| 8 | Replay is safe by contract: same key + same body reconciles to the same op/job (single `dispatch_jobs` row); changed body is `IDEMPOTENCY_CONFLICT` (409); duplicate result is `RESULT_REJECTED` (409); second lease pull is 204; content releases once. | `dispatch-coordinator.mjs:262-267`; `worker.js:3052-3058`; harness tests below |
| 9 | Auth: anonymous 401 `AUTH_REQUIRED`; wrong scope 403 `KEY_SCOPE`; worker endpoints demand a heartbeat-scoped key (403 `KEY_REQUIRED`); cancel requires session CSRF (403 `CSRF_REQUIRED`). Op keys are principal-scoped: foreign/unknown polls are 404 `OPERATION_NOT_FOUND`. | `worker.js` auth; `dispatch-coordinator.mjs:374-384` |
| 10 | Migrations `0024_inference_dispatch.sql` / `0025_inference_dispatch_claim_ledger.sql` exist in source. `website/scripts/e2e-python-worker.mjs` self-labels a fake upstream with no live inference: synthetic, never fabric/GPU proof. (`src-migrations-docs`) | migrations dir; e2e header lines 1-6 |

Stale-doc warning (from PRD inputs, respected here): `docs/dispatch-coordinator.md`
and `docs/inference-dispatch-routes.md` may carry pre-integration claims; the
source above takes precedence in every conflict.

## 2. Verified macOS command manifest

Every entry ran or was read from this Mac; nothing is guessed. Mutating
commands: none — this lane performs zero mutations outside its own new files.

| Purpose | Command (from lane root `/private/tmp/aipster-mac-inference-client-20261102`) | Evidence |
|---|---|---|
| Full read-only preflight | `/private/tmp/aipster-pr63-repair-20261101/tools/node-v24.22.2-darwin-arm64/bin/node website/scripts/mac-inference-client-preflight.mjs --out <evidence>/preflight.json` | preflight JSON; exit 0 = READY_FOR_OFFLINE |
| Offline harness (focused, serial-safe) | `NODE_PATH=/private/tmp/aipster-pr63-repair-20261101/node_modules <node24> --test website/tests/mac-inference-client.test.mjs` | 8/8 pass; in-memory D1 shim only |
| CLI shape (help only, no worker run) | `python3 local-worker/pairing.py serve-jobs --help` | option list in §1 row 2 |
| Source pin | `git rev-parse HEAD; git merge-base --is-ancestor 5bf623c… HEAD` | lane base proof |
| OS/tool facts | `sw_vers; uname -m; <node24> --version; python3 --version` | origin + toolchain record |

Pinned deps are used read-only via `NODE_PATH`; nothing is installed into
the lane. No full suite is run from this lane (no duplicate suites; the PR63
1,428-test gate belongs to the integration owner). JJP/GMH are not
contacted: task access is FALSE.

## 3. Offline evidence summary (Gate B, this lane)

Harness: `website/tests/mac-inference-client.test.mjs` — real `worker.js` +
real L1 D1 dispatch store + real L2 routes, no store injection, worker
played by the test with exact wire shapes (pattern of
`inference-e2e-real-store.test.mjs`).

| Test | What it proves | Status |
|---|---|---|
| admit → submit → lease → result → settle joins one chain and charges once | stable `admission_ref`/op/job/lease binding; `placement.device=cpu`; content once; `used_tokens=128` exactly; zero outstanding holds | PASS (offline) |
| stable idempotency key replays without redispatch; changed body conflicts | same op/job, one `dispatch_jobs` row; `IDEMPOTENCY_CONFLICT`; duplicate result `RESULT_REJECTED`, first completion wins | PASS (offline) |
| anonymous and wrong-scope callers refused | 401/403 matrix incl. `KEY_SCOPE` on heartbeat-key submit | PASS (offline) |
| cross-owner reads, leases, results denied | 404 `OPERATION_NOT_FOUND`; 204 lease; 409 `wrong_resource` | PASS (offline) |
| device/gpu selection refused; lease stays cpu | `FORGED_CLIENT_AUTHORITY` / `UNSUPPORTED_FIELD`; envelope `device=cpu` | PASS (offline; = contract-level HOLD proof) |
| deadlines bound submit; post-start cancel unsupported | `INVALID_DEADLINE` both directions; `UNSUPPORTED_CAPABILITY` + `remote_stopped:false`; holds retained; cancel CSRF | PASS (offline) |
| unknown-lease result rejected without settlement | 409 `wrong_lease`; op unsettled; genuine lease still completes same key (reconcile, never resubmit) | PASS (offline) |
| exhausted budget rejects with no charge and no job | 429 `BUDGET_EXHAUSTED`; `used_tokens=0`; zero job rows | PASS (offline) |

Fixture-success disclaimer: every PASS above exercises the contract with a
synthetic worker and fixture model id. It proves client/harness correctness
and contract behavior — never JJP execution, GPU use, or weights identity.
In particular, `outcome.provenance.simulated=false` in test 1 is a required
contract stamp (`dispatch-coordinator.mjs:441-442`), not hardware proof, and
must never be cited as such.

## 4. Source-known vs deployed-unknown

| Source-known (this lane) | Deployed-unknown (no probe; must not be assumed) |
|---|---|
| PR63 head `5bf623c`, contract `v1.0.0`, CPU-only, flag default off | Deployed commit, deployed routes, applied migrations (0024/0025?), flag value, D1 binding |
| Route shapes, codes, bounds, cancel limits | Owner identity/grant/budget receipts on the live environment |
| CLI shape, token env (not its value), runtime allowlist | JJP identity, OS, driver, VRAM, runtime build, resident model + digest, headroom |
| Offline harness 8/8 | Any live admission/job/lease/result/settlement |

## 5. Exact future live gate (all required; none satisfied)

A bounded live qualification batch may proceed only when every item below is
separately authorized and evidenced. Planning data is not permission.

1. **Target**: JJP host identity verified by the prerequisite owner; resource id + worker id; selected device **RTX 3090** with inventoried driver/VRAM/headroom; execution OS recorded. (RTX 5060: NOT RUN until a separately authorized verified runtime exists.)
2. **Runtime/model**: authorized resident runtime (`ganglion` or `llama-server`, exact build) already loaded; model id + verified weights digest with method/timestamp; loaded-artifact binding to the invocation. Aliases (`runtime_instance`/`model_fingerprint`) do not satisfy this.
3. **Route**: a reviewed, GPU-capable dispatch route deployed from a named SHA. The current `aipster-bound-cpu-internal/1` CPU-only contract cannot carry this gate; the required change is an explicit backend-owner decision (new reviewed placement authority/capability selection + worker fence update), reported here, not implemented here.
4. **Deployed source**: deployed commit = reviewed SHA; migrations 0024/0025 applied; `INFERENCE_ENABLED=1` activated under its own authority; D1 binding named; owner daily token ceiling configured.
5. **Caller authority**: named owner identity; inference-scoped caller credential scope confirmed; worker heartbeat key bound to the JJP resource; no token values in evidence.
6. **Bounds**: synthetic prompt ≤512 tokens in / ≤64 out (or approved revision); job deadline ≤60 s if the contract supports it; cost/quota ceiling in platform units; poll interval, queue cap, settlement deadline, VRAM/memory guardrails — unknown values block.
7. **Rollout approval**: one bounded-batch approval covering the serialized Windows + macOS requests (or one origin), with run sheet, live order, slot discipline (one job at a time; next only after terminal + settled + healthy JJP), reviewer sign-off, and zero blocking review issues.
8. **Expected evidence**: joined `admission_ref` → op/job → lease → runtime invocation → result receipt → settlement per origin; actual output; GPU-execution correlation to the exact job; before/after hold/charge closure; durations as observations; redacted bundles; PASS/FAIL/BLOCKED per origin.

## 6. Exact live HOLD

**HOLD — GPU path unselectable in the current contract.** `POST /api/jobs`
(v1.0.0) treats client `placement` as `FORGED_CLIENT_AUTHORITY`, admits no
device field (`UNSUPPORTED_FIELD`), offers no `--gpu` CLI, and both worker
(`inference_worker.py:368`) and store (`dispatch-store.mjs:988`) fence
`placement.device` to `cpu`. There is therefore no supported request this
Mac client can make that selects the RTX 3090; any 3090 claim on this
contract would require silent substitution outside the reviewed path, which
is prohibited. Additionally live is independently blocked on: PR63 draft /
inference off by default; deployed state unknown; JJP inventory absent;
weights provenance absent; no live authorization.

Required contract/rollout change (backend owner, not this lane): a reviewed
GPU placement authority — admission-time device allowlist/capability check,
coordinator binding of the selected device, worker-side fence/verification
update, and a protocol revision replacing `aipster-bound-cpu-internal/1` —
plus the Gate 5 items above. This lane implements no dispatcher and stages
no competing change.

## 7. Privacy and handling

Synthetic prompt only (`Reply with exactly: hello`); no customer data. No
secrets generated, stored, or printed: the upstream token env name is
referenced, never valued. Evidence bundles are redacted (no Bearer [REDACTED]
cookies, keys, or credential-bearing URLs). Test-created state lives in
in-memory shims and temp dirs; no shared deployment is touched and no
orphans can escape this lane.

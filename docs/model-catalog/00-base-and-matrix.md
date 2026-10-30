# Model catalog — Phase 0 base record and capability matrix

<!-- Built with Meta Muse. -->

- PRD: `AIPSTER_Model_Adapter_Catalog_PRD.md` v1.0 (2026-10-30, Peter Medina).
- Prompt: `AIPSTER_Muse_Implementation_Prompt.md` (full build launched by user 2026-10-30).
- Base: `origin/main @ 47444a5` ("Merge PR #47"), verified to contain the
  merged chain (#29/#31/#35/#36, incl. `8b954ef` settle and `3e01607`).
  Chain PRs all MERGED 2026-10-30; #45 CLOSED.
- Branch: `muse/model-catalog`. Worktree: `aipster-catalog`.
- Note: the prompt asks to read `AGENTS.md`; no such file exists in the repo
  at base. Conventions below are derived from the actual tree.

## Capability matrix (at base)

| Need (PRD) | State | Evidence / gap |
|---|---|---|
| Authenticated dashboard shell + tabs | IMPLEMENTED | `website/public/app/{index.html,app.js,styles.css}`; tabs overview/compute/shared/sharing/federation/keys/usage/settings; `loadX()` per-tab pattern |
| Session + API-key auth, tenant isolation | IMPLEMENTED | Better Auth 1.7.14 + D1; `owner_id` on every row; demo sandbox guards; CSRF on session mutations |
| Resource inventory + sharing/grants | IMPLEMENTED | `resources`, `grants`, `key_verifiers` (+`resource_id` 0013); `/api/inventory`, `/api/grants`, `/api/shared-with-me` |
| Pairing + heartbeat liveness | IMPLEMENTED | `/api/pairing/*`, per-resource heartbeat keys, atomic intake; body strictly `{"usable": boolean}` |
| Structured node telemetry (VRAM/RAM/disk/runtime) | MISSING | `resources` has free-text cpu/gpu + JSON blobs only; heartbeat carries no telemetry |
| Model download/load/unload worker APIs | MISSING | Worker = pairing + heartbeat only; `/api/jobs` POST → `INFERENCE_DISABLED`; see `local-worker/EXECUTION-GAPS.md` |
| Job ledger primitives | PARTIAL | `jobs`, `usage`, `audit`, `idempotency_keys` tables exist; no execution path writes them |
| Object storage for upload bytes | MISSING | `wrangler.jsonc` binds D1 only — no R2/KV. D1 cannot hold weight bytes |
| HF metadata integration | MISSING | No Hub client anywhere; Workers outbound fetch available but unused for this |
| User-supplied HF token custody | MISSING | No secret store beyond Better Auth session/OAuth; no per-user encrypted token facility |
| Upload/validation pipeline | MISSING | No upload session, quarantine, validator, manifest, or asset tables |
| Compatibility estimator | MISSING | No memory model, no runtime capability matrix |
| Runtime support (llama.cpp/vLLM/…) | MISSING | No runtime integration, qualified or otherwise |
| Migration chain head | IMPLEMENTED | `0001`–`0016` applied; next free number `0017` |
| Test/check gates | IMPLEMENTED | `npm run check/test/build/bundle`; 74 website test files; `check.mjs` public-site gates |

## Initial support matrix (Phase 1–3)

Because no runtime or telemetry exists at base, the only qualified entries are
fixtures. Everything real starts UNKNOWN — never green.

- Runtimes: `fixture-llama` (declared fixture capability: GGUF Q4_K_M,
  CPU+single-GPU, context ≤ 8192) — fixture only. Real runtimes: unqualified.
- Artifact formats: fixture GGUF + fixture safetensors-LoRA. Real Hub/private
  artifacts: discoverable, assessable only after capability reports exist.
- Nodes: fixture nodes with synthetic snapshots. Real nodes: unknown until
  they post capability reports (new endpoint, Phase 1).
- First real-runtime candidate (PROPOSED, unqualified): llama.cpp GGUF on one
  node. Qualification is Phase 4+ follow-on, not this workstream.

## Decisions recorded (Phase 0)

1. **Base = main @ 47444a5.** Chain merged; no need to base on a moving head.
2. **No weight bytes in D1.** Phase 2 builds manifests, sessions, quarantine
   state machine, validation logic, and authorization against D1 + fixtures;
   byte persistence waits on R2 provisioning by the rollout owner (exact
   request in `01-plan.md`). Uploads API returns `STORAGE_UNPROVISIONED`
   until then — never silently drops bytes.
3. **Telemetry via a new versioned endpoint, not a widened heartbeat.**
   The heartbeat intake is security-critical with a strict body; widening it
   risks the atomic admission guarantees. New `POST /api/resources/:id/capabilities`
   (same heartbeat-key auth, versioned capability schema) + `node_capabilities`
   table in migration 0017. Heartbeat stays untouched.
4. **New catalog tables; don't overload inference `jobs`.**
   `catalog_assets`, `catalog_asset_files`, `catalog_uploads`,
   `catalog_compat_cache`, `catalog_deployments`, `catalog_deployment_events`
   in 0017. Inference `jobs` keeps its disabled semantics.
5. **Demo accounts: browse fixtures only.** No uploads, no plans, no jobs —
   consistent with existing demo guards (`demo` flag checks).
6. **HF tokens session-only in Phase 1.** No persistence until a reviewed
   secret facility exists; per-user tokens never shared, never logged.

## Open items needing owner input (not blocking Phases 1–3)

- R2 bucket provisioning + binding name (blocks real upload bytes only).
- First real runtime to qualify (blocks Phase 4 real-node plan only).
- Telemetry freshness thresholds + memory safety-reserve policy (defaults
  proposed in plan; owner confirms before any real qualification).

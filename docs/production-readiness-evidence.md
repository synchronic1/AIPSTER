# Production-readiness evidence (schema + effective config)

Offline validator: `website/scripts/verify-production-readiness.mjs`
Focused test: `website/tests/verify-production-readiness.test.mjs`

Fixture tests prove only how the validator behaves. They are **not** evidence
that production is ready. A READY verdict needs real operator-observed
production evidence for the exact candidate SHA.

## Why this exists (gap reproduced at `0e6b60890c736207664d122c62e39d8c4affd2fa`)

- `.github/workflows/public-site-production-deploy.yml` step *"Hold automatic
  release on unknown or migrated schema"* runs only when `mode == 'auto'`. On
  manual `workflow_dispatch` the step is skipped and `steps.migration.outputs.hold`
  is empty, so the release gate and `wrangler deploy` run without any
  check of the production D1 schema.
- No workflow or script applies D1 migrations or reads `d1_migrations`.
  `migrationHoldDecision` (`website/scripts/release-preflight.mjs`) only diffs git
  paths; it never observes the database.
- `website/migrations/0029_fabric_dispatch_spend.sql` adds
  `fabric_grants.used_tokens` / `used_jobs`. These columns are read and written by
  `website/src/inference/dispatch-store.mjs` (fabric hold/charge/release) and
  `website/src/worker.js` (`dispatchGrantFor`) on the inference admission paths.
  Those paths exist only when `INFERENCE_ENABLED === '1'`. With inference
  disabled, the missing columns stay hidden until the flag is turned on, so
  the schema must be proven before deploy regardless of the flag.
- Flags as the runtime parses them:
  - `DGM_MUSE_LIVE`: on only when exactly `'1'` (live calls also need the
    `DGM_MUSE_API_KEY` secret).
  - `DGM_MUSE_SPEND_CAP_USD`: a finite number ≥ 0, otherwise 0.
  - `DGM_PREVIEW_ENABLED`: on only when `'1'`.
  - `INFERENCE_ENABLED`: on only when `'1'`.

  `website/wrangler.jsonc` declares only `BETTER_AUTH_URL` in `vars` and does
  not set `keep_vars`. The config file therefore says nothing about the
  effective values, and they must never be inferred from it or from a workflow.

## Required evidence and policy (fail closed)

| Evidence | Requirement |
|---|---|
| `candidate_sha` | equals `--candidate` (exact release SHA) |
| `live.deployment_git_commit` | 40-hex `git_commit` from `https://aipster.net/deployment.json` (the live baseline) |
| `target.*` | `aipster-public-site` / `aipster-app` / `b91be793-704a-4eae-8b8f-7f4c8b78e4fc` (read from `wrangler.jsonc`) |
| `d1.migrations_applied` | every `website/migrations/*.sql` at the candidate, each once, and no unknown entries |
| `d1.fabric_grants_columns` | includes `used_tokens`, `used_jobs`; columns without a 0029 journal entry are ambiguous |
| `flags.<4 names>` | each explicitly `unset` or `plain_text` with its observed value. A `secret` binding is ambiguous because its value can't be read without reading the secret. Any other key is rejected. |
| policy | DGM live **off**, spend cap **exactly 0** (unset or literal `0`). Preview and inference are reported, not forced. |

Manual vs automatic mode:

- **Automatic mode.** The workflow already holds any release with a
  migration diff since the live baseline. A release that contains 0029 cannot
  auto-deploy and must go through reviewed manual dispatch.
- **Manual mode.** The workflow performs no schema check, so this
  evidence is the schema gate. The migrations must already be applied by the
  release owner, under separate approval, before the code is deployed.

This validator never applies migrations and never authorizes a bypass.

## Operator read-only steps (run only with the operator's own authorized identity)

The agent preparing this did **not** run any of these. An earlier D1 metadata
read was denied (`7403 not authorized`). Do not retry with a different identity
or credential. These steps need an operator who is already authorized for the
`aipster-app` account. All commands are reads. Do not run `migrations apply`,
`secret put`, `deploy`, or any write SQL.

From `website/` at the candidate checkout:

```sh
# 1. Journal (read-only SELECT)
npx wrangler d1 execute aipster-app --remote --json \
  --command "SELECT name FROM d1_migrations ORDER BY id"
# Cross-check, also read-only: lists unapplied migrations
npx wrangler d1 migrations list aipster-app --remote

# 2. fabric_grants columns (read-only)
npx wrangler d1 execute aipster-app --remote --json \
  --command "SELECT name FROM pragma_table_info('fabric_grants')"

# 3. Secret NAMES only (values are never shown)
npx wrangler secret list --config wrangler.jsonc
```

4. Plain-text vars: Cloudflare dashboard → Workers → `aipster-public-site` →
   Settings → Variables and Secrets. Record each of the four flags as
   `unset`, `plain_text` + value, or `secret` (name present in step 3).
5. Live baseline: `git_commit` from the public `deployment.json`, read by an
   authorized operator through the normal route. Do not use alternate routes if
   it returns 403.

Copy only the names and values into the evidence file. Leave out tokens,
account IDs other than the D1 id, and secret values:

```json
{
  "schema": "aipster.production-readiness-evidence/v1",
  "evidence_kind": "operator-observed-production",
  "observed_at": "2026-11-04T09:00:00Z",
  "observer": "<operator name>",
  "candidate_sha": "<40-hex release sha>",
  "release_mode": "manual",
  "live": { "deployment_git_commit": "<40-hex from deployment.json>" },
  "target": { "worker_name": "aipster-public-site", "d1_database_name": "aipster-app",
              "d1_database_id": "b91be793-704a-4eae-8b8f-7f4c8b78e4fc" },
  "d1": { "migrations_applied": ["0001_....sql", "...", "0029_fabric_dispatch_spend.sql"],
          "fabric_grants_columns": ["id", "...", "used_tokens", "used_jobs"] },
  "flags": {
    "DGM_MUSE_LIVE": { "binding": "unset" },
    "DGM_MUSE_SPEND_CAP_USD": { "binding": "plain_text", "value": "0" },
    "DGM_PREVIEW_ENABLED": { "binding": "unset" },
    "INFERENCE_ENABLED": { "binding": "unset" }
  }
}
```

Validate offline. It makes no network calls:

```sh
cd website
node scripts/verify-production-readiness.mjs --evidence evidence.json --candidate <40-hex sha>
```

Expected sanitized output when ready (exit 0). A HOLD exits 1 with
`failures`; a usage or read error exits 2:

```json
{
  "verdict": "READY",
  "candidate_sha": "<sha>",
  "live_sha": "<sha>",
  "release_mode": "manual",
  "observed_at": "2026-11-04T09:00:00Z",
  "expected_migrations": 27,
  "effective_flags": { "dgm_muse_live": false, "dgm_muse_spend_cap_usd": 0,
                       "dgm_preview_enabled": false, "inference_enabled": false },
  "failures": [],
  "warnings": ["...manual dispatch skips the workflow migration-hold step..."]
}
```

A warning that a flag is a plain-text dashboard var missing from
`wrangler.jsonc` means `wrangler deploy` (no `keep_vars`) is expected to drop
it. Observe the flags again after any deploy. Do not treat the projected
post-deploy value as observed.

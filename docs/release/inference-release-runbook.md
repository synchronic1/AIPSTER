# Inference dispatch release runbook (migration 0024)

Release-owner runbook for shipping the admitted-dispatch surface
(`docs/inference-dispatch-routes.md`, `docs/dispatch-coordinator.md`) after
PR #63 merges. Modelled on `docs/release/chain-release-runbook.md`; only the
release owner executes it.

Two separate releases live here:

1. **Schema + code, dark.** Apply additive migration
   `0024_inference_dispatch.sql` and deploy the merged public site. With
   `INFERENCE_ENABLED` unset, every inference route stays absent and
   `POST /api/jobs` keeps `501 INFERENCE_DISABLED`. This part needs no
   activation decision beyond the merge review.
2. **Activation.** Set the owner daily token ceiling and the dispatch caps,
   set `INFERENCE_ENABLED=1`, and run one owner-only live job. This part is
   **separate** and requires Peter's explicit approval. Do not fold it into
   the deploy.

Run every `wrangler` command from a `website` directory (it holds
`wrangler.jsonc`); `git` and `gh` commands from the repository root unless a
block says otherwise.

Database identity (from `website/wrangler.jsonc`): binding `DB`, database
`aipster-app` (`b91be793-704a-4eae-8b8f-7f4c8b78e4fc`), `migrations_dir`
`migrations`.

Facts at the time of writing (re-confirm in step 1, never assume):

- live site `974a345`, deployed with no inference routes (they answer `404`);
- production journal `0001`-`0018` and `0021`-`0023` (0019/0020 are retired
  gaps and must never appear);
- production secrets are `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID` and
  `GITHUB_CLIENT_SECRET` only. No inference variable is set.

## 0. Ownership and identity

- One operator merges, migrates and deploys. If another operator is mid-release,
  stop and hand over instead of doubling up.
- The reviewed SHA is a full 40-character commit. Every step below records it.
- Never edit an applied migration and never reorder the journal. A schema change
  that is not in the reviewed SHA stops the release.

## 1. Preconditions (all must hold)

1. PR #63 is merged with a merge commit at the recorded SHA and the merge is on
   `main`: `git merge-base --is-ancestor <reviewed_sha> origin/main` exits 0.
2. "Public site asset and build checks" is green on that exact SHA, and an
   independent Codex review is recorded on PR #63 with no unresolved finding.
   Branch protection is off, so the release owner records the review; never
   self-approve your own work.
3. The reviewed SHA contains the reviewed bytes of the PR #63 files and nothing
   later changed them. Prepare the clean checkout once, here, and use it for
   every later `wrangler` command (Node 24: `node -v` must print `v24.x`):

   ```powershell
   $repo = '<absolute path to your AIPSTER clone>'
   $reviewed = '<40-character merged main SHA>'
   git -C $repo fetch origin main
   git -C $repo rev-parse origin/main          # must equal $reviewed
   git -C $repo merge-base --is-ancestor $reviewed origin/main   # must exit 0
   git -C $repo diff <pr63-head-sha> $reviewed -- `
     website/migrations/0024_inference_dispatch.sql `
     website/src/inference/dispatch-store.mjs
   # must print nothing: the released files are the reviewed bytes
   git -C $repo worktree add --detach "C:\Users\NM2\Documents\aipster-release-$reviewed" $reviewed
   $release = "C:\Users\NM2\Documents\aipster-release-$reviewed"
   git -C $release rev-parse HEAD              # must equal $reviewed
   cd $release\website
   npm ci --ignore-scripts --no-audit --no-fund
   npx wrangler --version                      # must print 4.153.0 (package-lock pin)
   ```

4. No other release is in flight and main is quiet.
5. Peter has approved this release in writing (merge + dark deploy). Activation
   in step 8 needs a second, explicit approval.

Record the PR #63 head SHA, the merge commit SHA, and the CI run ids before
touching production.

## 2. Back up production D1 and record a Time Travel bookmark

The backup may contain user and session rows: keep it outside every repository,
never commit it, never paste it into a ticket.

```powershell
New-Item -ItemType Directory -Force C:\Users\NM2\Documents\d1-backups | Out-Null
cd $release\website
npx wrangler d1 export aipster-app --remote --output C:\Users\NM2\Documents\d1-backups\aipster-app-<yyyymmdd>-pre-w5.sql
(Get-FileHash C:\Users\NM2\Documents\d1-backups\aipster-app-<yyyymmdd>-pre-w5.sql -Algorithm SHA256).Hash
```

Record the path, byte count and SHA-256. Then record the Time Travel bookmark
and keep it with the release note:

```powershell
npx wrangler d1 time-travel info aipster-app --json
```

Also capture the pre-change live state:

```powershell
(Invoke-RestMethod https://aipster.net/deployment.json).git_commit
Invoke-RestMethod https://aipster.net/api/health | ConvertTo-Json -Depth 4
```

## 3. Confirm the production journal

```powershell
cd $release\website
npx wrangler d1 execute aipster-app --remote --command `
  "SELECT id, name, applied_at FROM d1_migrations ORDER BY id;"
```

Expected: 21 rows, `0001_better_auth.sql` through `0018_advisor_ops.sql`, then
`0021_routing_ops.sql`, `0022_model_catalog.sql`,
`0023_model_catalog_reservations.sql`. `0019` and `0020` must not appear.

Stop if the journal differs. Applied migrations are never edited or reordered.

Confirm the pending set is exactly one file:

```powershell
npx wrangler d1 migrations list aipster-app --remote
# pending: 0024_inference_dispatch.sql (only)
```

## 4. Apply 0024 from the clean detached checkout

`$release` is the detached checkout of the reviewed SHA from step 1. It must
still report `$reviewed`; do not run this from a stale or dirty tree.

```powershell
cd $release\website
git -C $release rev-parse HEAD              # must equal $reviewed
git -C $release status --porcelain          # must print nothing
Get-ChildItem migrations\0024_inference_dispatch.sql   # must exist
npx wrangler d1 migrations list aipster-app --remote
npx wrangler d1 migrations apply aipster-app --remote
```

Confirm the prompt names only `0024_inference_dispatch.sql`. Wrangler then asks
`Your database may not be available to serve requests during the migration,
continue?` — answer yes only when the pending list above showed that one file.
It reports `25 commands executed successfully`: the file's 24 statements plus
the `d1_migrations` row. Check the header says `Resource location: remote`; a
`local` header means `--remote` was dropped, so stop and re-run.

Wrangler journals the file in `d1_migrations` and takes a backup marker;
re-running the apply is a no-op because the journal already records it.

## 5. Verify 0024

Journal:

```powershell
npx wrangler d1 execute aipster-app --remote --command `
  "SELECT id, name, applied_at FROM d1_migrations ORDER BY id;"
# expect 22 rows, the last one 0024_inference_dispatch.sql, ids 0001-0018, 0021-0024
```

Tables (eight, all new):

```powershell
npx wrangler d1 execute aipster-app --remote --command `
  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dispatch_%' ORDER BY name;"
# dispatch_admissions, dispatch_fences, dispatch_holds, dispatch_jobs,
# dispatch_operations, dispatch_pool_usage, dispatch_settlements,
# dispatch_start_redemptions
```

Additive only: the migration must contain no `DROP` or `ALTER` statement.

```powershell
Select-String -Path migrations\0024_inference_dispatch.sql -Pattern '^\s*(DROP|ALTER)\b'
# must print nothing
```

Idempotency: every statement in 0024 is `CREATE TABLE`/`CREATE INDEX` with
`IF NOT EXISTS`, and the journal makes a second apply a no-op. This is the
repo's expectation (see `website/tests/migrations.test.mjs`); do not invent a
down migration.

Readiness:

```powershell
Invoke-RestMethod https://aipster.net/api/health | ConvertTo-Json -Depth 4
# ready: true, detail.schema: true
```

**Health is necessary but not evidence that 0024 applied.** `/api/health`
probes the app/federation/DGM schema contract in `website/src/lib/schema.js`;
that contract intentionally does not include the `dispatch_*` tables, because
the inference routes are dark until the flag is on. Use the journal and table
queries above to prove the migration; use health to prove the site is serving.

Anything missing or out of order: stop, do not deploy; decide roll-forward vs
restore with Peter.

## 6. Deploy the reviewed SHA (flag still off)

Main CI must be green on `$reviewed` and the preflight requires
`reviewed == built == main`.

```powershell
gh workflow run public-site-production-deploy.yml `
  --repo synchronic1/AIPSTER --ref main -f reviewed_sha=$reviewed
$runId = gh run list --repo synchronic1/AIPSTER `
  --workflow public-site-production-deploy.yml --limit 1 `
  --json databaseId --jq '.[0].databaseId'
$runId
gh run watch $runId --repo synchronic1/AIPSTER --exit-status
```

After the run succeeds:

```powershell
(Invoke-RestMethod https://aipster.net/deployment.json).git_commit   # $reviewed
Invoke-RestMethod https://aipster.net/api/health | ConvertTo-Json -Depth 4
```

Known flake: `verify:live` sometimes reads stale edge bytes immediately after
upload ("Live bytes differ"). Wait two minutes and re-run the identical check by
hand before calling it failed.

## 7. Verify the inference routes are still dark

With `INFERENCE_ENABLED` unset, the new surface must not exist. Anonymous
requests prove it without a credential.

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" https://aipster.net/api/inference/admissions
# 404 (route absent)
curl.exe -s -o NUL -w "%{http_code}`n" https://aipster.net/api/worker/jobs/next
# 404 (route absent)
curl.exe -s -o NUL -w "%{http_code}`n" -X POST https://aipster.net/api/jobs
# 401 (anonymous auth check runs before the disabled body; a signed-in
#      caller still gets 501 INFERENCE_DISABLED)
```

Also confirm the pre-existing anonymous protections are unchanged:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" https://aipster.net/api/inventory
# 401
```

Stop here. The release is complete when the journal shows 0024, the deploy
reports `$reviewed`, health is `ready: true`, and all three inference probes are
`404`/`404`/`401`.

## 8. Activation (SEPARATE, Peter-approved)

Do not start this section during the deploy. It needs Peter's explicit approval
of: the token ceiling value, the caps, enabling the flag, and the one live job.
Record the approval and the values in the release note.

Run these from `$release\website` (the reviewed checkout). `wrangler secret put`
publishes a new Worker version carrying the same reviewed code and assets plus
the new binding. Confirm after each group that `deployment.json` still reports
`$reviewed` and health is `ready: true`.

### 8.1 Budget and caps

Values are non-secret configuration, stored as Worker secrets because that is
the only deploy-surviving mechanism this repo uses besides `wrangler.jsonc`
(which would need a code change and a new reviewed SHA).

```powershell
'20000' | npx wrangler secret put INFERENCE_OWNER_DAILY_TOKENS
'2'     | npx wrangler secret put INFERENCE_DISPATCH_MAX_ADMISSIONS
'2'     | npx wrangler secret put INFERENCE_DISPATCH_MAX_OPERATIONS
```

Why these values:

- `INFERENCE_OWNER_DAILY_TOKENS=20000` is the owner self-use ceiling per UTC day
  (`owner:<user_id>:<yyyy-mm-dd>`). A missing or invalid value is `0` and every
  owner admission fails closed with no budget. Each operation reserves its full
  `max_tokens` for the day, so 20000 covers at least four maximum-size (4096)
  jobs while bounding the worst-case daily charge. Start small; raise it only
  after the pilot settles cleanly.
- `INFERENCE_DISPATCH_MAX_ADMISSIONS=2` and
  `INFERENCE_DISPATCH_MAX_OPERATIONS=2` are per-principal retained-state caps
  (live admissions and non-terminal operations). The defaults are 20 each when
  unset or invalid. Two of each is enough for one operator test and makes the
  pilot's state easy to reason about. Values must be integers >= 1.

The owner pool's ceiling is fixed the first time that principal's UTC day is
used; changing `INFERENCE_OWNER_DAILY_TOKENS` later the same day does not raise
an already-open pool. Make the value final before the first live job, or wait
for the next UTC day. The two caps are read per request and change immediately.

The routes are still dark after this step; nothing changes for users yet:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" https://aipster.net/api/inference/admissions
# 404
```

### 8.2 Enable the flag

```powershell
'1' | npx wrangler secret put INFERENCE_ENABLED
```

Verify the surface exists and fails closed for anonymous callers:

```powershell
npx wrangler secret list
# names only: the four INFERENCE_* entries above, plus the three existing
# BETTER_AUTH_SECRET and GITHUB_CLIENT_ID/SECRET
curl.exe -s -o NUL -w "%{http_code}`n" https://aipster.net/api/inference/admissions
# 401 AUTH_REQUIRED (route now exists; no admission issued)
(Invoke-RestMethod https://aipster.net/deployment.json).git_commit   # still $reviewed
Invoke-RestMethod https://aipster.net/api/health | ConvertTo-Json -Depth 4   # ready: true
```

### 8.3 Run one owner-only live job

Worker side, on the machine that is already paired to the resource and has a
fresh heartbeat. Ganglion must be listening on loopback and `serve-jobs` must
claim the same runtime identity the admission pins (`ganglion` by default).

```powershell
# Terminal 1: local upstream (already running in the normal setup)
Invoke-RestMethod http://127.0.0.1:8471/v1/models | ConvertTo-Json -Depth 4
# copy one model id from .data[].id

# Terminal 2: the paired worker
cd <worker checkout>\local-worker
.\.venv\Scripts\python.exe pairing.py status
.\.venv\Scripts\python.exe pairing.py serve-jobs
```

Site side. The dashboard dispatch panel is a separate lane and is not part of
this build, so use the API path below. Mint an **inference-scoped** key in the
dashboard (Keys panel, Scope `inference`) and keep it in memory only; it is
shown once and is never written to a file or a command line. `Read-Host`
echoes what you type, so use a private terminal.

```powershell
$key = Read-Host 'Paste the inference-scoped key'
$headers = @{ Authorization = "Bearer $key" }
$inventory = Invoke-RestMethod https://aipster.net/api/inventory -Headers $headers
$resourceId = ($inventory.items | Where-Object { $_.name -eq '<paired resource name>' }).id
$modelId = '<model id copied from /v1/models>'
$resourceId; $modelId
```

The resource must be `online` with a heartbeat inside the five-minute window or
the admission is refused `409 RESOURCE_STALE`.

Mint the server-side admission and dispatch one job (deadline is Unix
milliseconds, in the future, at most 180 seconds ahead; `max_tokens` is 1-4096):

```powershell
$admission = Invoke-RestMethod -Method Post https://aipster.net/api/inference/admissions `
  -Headers $headers -ContentType 'application/json' `
  -Body (@{ resource_id = $resourceId; model_id = $modelId; max_tokens = 256 } | ConvertTo-Json -Compress)
$admission | ConvertTo-Json -Depth 4

$idem = 'w5-live-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$deadline = [DateTimeOffset]::UtcNow.AddSeconds(120).ToUnixTimeMilliseconds()
$job = @{
  contract_version = 'v1.0.0'
  admission_ref    = $admission.admission_ref
  idempotency_key  = $idem
  model_id         = $admission.model_id
  prompt           = 'Reply with exactly: AIPSTER W5 OK'
  max_tokens       = 256
  deadline_at      = $deadline
} | ConvertTo-Json -Compress
$sent = Invoke-RestMethod -Method Post https://aipster.net/api/jobs `
  -Headers $headers -ContentType 'application/json' -Body $job
$sent | ConvertTo-Json -Depth 6      # status dispatched, http 202
```

Wait for the worker to lease, run, and post the result, then reconcile by the
same idempotency key:

```powershell
1..30 | ForEach-Object {
  $r = Invoke-RestMethod "https://aipster.net/api/jobs/$idem" -Headers $headers
  "{0} {1}" -f $_, $r.status
  if ($r.status -eq 'settled') { $r | ConvertTo-Json -Depth 8; break }
  Start-Sleep -Seconds 2
}
```

### 8.4 Verify settlement and content

In the reconcile output expect: `status: settled`, `outcome.finish: succeeded`,
`outcome.released: true`, `outcome.provenance.simulated: false`, and
`outcome.content` equal to the model's reply. A withheld release
(`outcome.withheld_reason`) is still charged and is a failed pilot.

Confirm the durable accounting (read-only; substitute the `op_id` from the
reconcile output):

```powershell
cd $release\website
npx wrangler d1 execute aipster-app --remote --command `
  "SELECT s.op_id, s.outcome, s.settled_at, o.phase, p.used_tokens, p.ceiling_tokens FROM dispatch_settlements s JOIN dispatch_operations o ON o.op_id = s.op_id JOIN dispatch_pool_usage p ON p.principal_id = o.principal_id WHERE o.op_id = '<op_id>';"
# one row; phase settled; used_tokens = 256; ceiling_tokens = 20000
```

Then clear the key from the shell:

```powershell
Remove-Variable key -ErrorAction SilentlyContinue
Remove-Item Env:AIPSTER_INFERENCE_KEY -ErrorAction SilentlyContinue
```

Stop `serve-jobs` with Ctrl+C.

## 9. Rollback

Disable first; the database work is additive and can stay.

1. **Turn the flag off** (also a new Worker version with the same code):

   ```powershell
   cd $release\website
   npx wrangler secret delete INFERENCE_ENABLED
   curl.exe -s -o NUL -w "%{http_code}`n" https://aipster.net/api/inference/admissions
   # 404 again
   ```

   Stop `serve-jobs` before disabling so no worker is mid-lease; an in-flight
   operation whose result is never posted stays uncertain and its hold stays
   reserved rather than being guessed.

2. Optionally remove the pilot configuration (unset values behave as "owner
   ceiling 0" and "cap default 20", so leaving them is safe but less obvious):

   ```powershell
   npx wrangler secret delete INFERENCE_DISPATCH_MAX_ADMISSIONS
   npx wrangler secret delete INFERENCE_DISPATCH_MAX_OPERATIONS
   npx wrangler secret delete INFERENCE_OWNER_DAILY_TOKENS
   ```

3. **Site.** The preflight pins `reviewed == main`, so rollback is a forward
   release: revert the PR #63 merge (or merge a fix), wait for green CI, and
   dispatch the deploy workflow with the new reviewed SHA. Code older than
   PR #63 ignores the `dispatch_*` tables; `/api/health` does not probe them, so
   the site reports ready.

4. **Database.** Do not drop the tables on rollback. The migration rows stay
   (`0024_inference_dispatch.sql` in the journal) and the tables are unused while
   the flag is off. A Time Travel restore is a **last resort and Peter's call**,
   because it rewinds the whole database to the bookmark, including writes made
   after it:

   ```powershell
   npx wrangler d1 time-travel restore aipster-app --bookmark <bookmark from step 2>
   ```

   After any restore, re-run the journal and health probes and record what was
   lost.

## 10. After release

- Keep the D1 backup for the retention window, then destroy it.
- Record the exact values set in step 8 and who approved them.
- Do not raise the token ceiling or enable grants for other principals without a
  new review and a new release note.
- Inference execution still depends on the operator-run `serve-jobs`; a web
  deploy does not start, update, or qualify any worker.

## Appendix A. Local rehearsal (never `--remote`)

Rehearse the journal shape before touching production. This mirrors the
production journal first (0001-0018 and 0021-0023, with 0019/0020 absent), then
applies 0024 through the same `wrangler d1 migrations apply` path.

```powershell
# From the repository root. Never add --remote to anything in this appendix.
$tmp = '<throwaway directory outside the repository, e.g. $env:TEMP\aipster-w5>'
New-Item -ItemType Directory -Force "$tmp\persist", "$tmp\migrations-phase1" | Out-Null
Get-ChildItem website\migrations\*.sql |
  Where-Object { $_.Name -notlike '0024_*' } |
  Copy-Item -Destination "$tmp\migrations-phase1"
(Get-ChildItem "$tmp\migrations-phase1").Count      # 21, matching production
```

Stage a temporary config with the same database identity:

```powershell
@'
{
  "name": "aipster-local-rehearsal",
  "compatibility_date": "2026-10-26",
  "send_metrics": false,
  "d1_databases": [{
    "binding": "DB",
    "database_name": "aipster-app",
    "database_id": "b91be793-704a-4eae-8b8f-7f4c8b78e4fc",
    "migrations_dir": "migrations-phase1"
  }]
}
'@ | Set-Content "$tmp\wrangler-phase1.jsonc" -Encoding utf8
```

Phase 1, then 0024 exactly as production would:

```powershell
cd $repo\website
npx wrangler d1 migrations apply aipster-app --local --persist-to "$tmp\persist" `
  --config "$tmp\wrangler-phase1.jsonc"
npx wrangler d1 migrations apply aipster-app --local --persist-to "$tmp\persist"
```

Verify and prove idempotency:

```powershell
npx wrangler d1 execute aipster-app --local --persist-to "$tmp\persist" `
  --command "SELECT id, name FROM d1_migrations ORDER BY id;"
# 22 rows: ids 1-21 are 0001-0018 then 0021-0023 (0021 takes id 19 because
# 0019/0020 were never inserted), and id 22 is 0024_inference_dispatch.sql
npx wrangler d1 execute aipster-app --local --persist-to "$tmp\persist" `
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dispatch_%' ORDER BY name;"
# the same eight tables as step 5
npx wrangler d1 migrations apply aipster-app --local --persist-to "$tmp\persist"
# "No migrations to apply"
npx wrangler d1 execute aipster-app --local --persist-to "$tmp\persist" `
  --file migrations\0024_inference_dispatch.sql
# succeeds again: every statement is CREATE ... IF NOT EXISTS
```

Delete `$tmp` afterwards; nothing there belongs in the repository.

## Record

The release note must name: the PR #63 head and merge commit SHAs, the reviewed
SHA, CI run ids, the review record, the backup path/bytes/SHA-256, the Time
Travel bookmark, the journal before/after, the deploy run id and Cloudflare
version, the dark-route probes, and — only if activation ran — the approval, the
three configuration values, the admission/job ids, the reconcile outcome and
content, and the settlement row.

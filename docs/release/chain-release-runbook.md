# Chain release runbook (codex/sprint-* integration chain)

Release owner runbook for merging the integration chain and releasing it
to production. Expanded from the takeover report's "Migrations and
rollback" and "Release handover" sections.

## 0. Lanes and staleness

- The chain moves: Claude owns `codex/sprint-*`, a worker session owns
  `local-worker/**` and `website/public/app/**` on #35/#36. Never merge
  from stale SHAs: re-confirm every tip and CI state immediately before
  acting (step 1). Do not rebase chain branches without their owners.
- Last verified candidate (takeover, STALE until re-confirmed):
  #29 `4bd1282`, #31 `c82a028`, #35 `535c35b`, #36 `08d45da`.
- One operator merges and releases. If another operator is mid-release,
  stop and hand over instead of doubling up.

## 1. Preconditions (all must hold)

1. Each PR in `#29 -> #31 -> #35 -> #36` shows `MERGEABLE` and fully
   green checks at its current tip.
2. Independent review is recorded on each PR. The owner's merge review
   is the final gate; never self-approve your own work.
3. Peter Medina has signed off migration `0013` (heartbeat reservation;
   see its header and `docs/heartbeat-intake.md`).
4. Main is quiet: `git fetch origin main` shows no unexpected new merge.

Record tips and CI:

```powershell
foreach ($n in 29,31,35,36) {
  (gh pr view $n --repo synchronic1/AIPSTER --json headRefOid,mergeable,mergeStateStatus |
    ConvertFrom-Json) | ForEach-Object {
      "PR$n $($_.headRefOid) mergeable=$($_.mergeable) state=$($_.mergeStateStatus)" } }
```

## 2. Back up production D1 (read-only, never commit)

```powershell
npx wrangler d1 export aipster-app --remote --output <private-dir>\aipster-app-<yyyymmdd>-prechain.sql
(Get-FileHash <private-dir>\aipster-app-<yyyymmdd>-prechain.sql -Algorithm SHA256).Hash
```

Keep the backup outside every repository. Record path, bytes, and sha256
in the release notes. Reference backup: `d1-backups\`
`aipster-app-20261029-prechain.sql`, 8020 bytes,
`E3B487BC50DE07BD6125BE86FA08A0C39A56209FC3DB8F2498BB2F4C0CD55A41`.

## 3. Confirm the production journal

```powershell
npx wrangler d1 execute aipster-app --remote --command `
  "SELECT id, name, applied_at FROM d1_migrations ORDER BY id;"
```

Expected: exactly `0001_better_auth.sql` through
`0005_write_budget.sql`, in order, no fabric/pairing objects. Confirm the
five files are byte-identical between main and the chain tip:

```powershell
git diff origin/main <chain-tip> --stat -- `
  website/migrations/0001_better_auth.sql website/migrations/0002_app.sql `
  website/migrations/0003_demo_auth.sql website/migrations/0004_disable_flag.sql `
  website/migrations/0005_write_budget.sql
# must print nothing
```

Stop if the journal differs: applied migrations are never edited or
reordered. Apply nothing in this step.

## 4. Merge the chain in order

```powershell
gh pr merge 29 --repo synchronic1/AIPSTER --merge
gh pr edit 31 --repo synchronic1/AIPSTER --base main
gh pr merge 31 --repo synchronic1/AIPSTER --merge
gh pr edit 35 --repo synchronic1/AIPSTER --base main
gh pr merge 35 --repo synchronic1/AIPSTER --merge
gh pr edit 36 --repo synchronic1/AIPSTER --base main
gh pr merge 36 --repo synchronic1/AIPSTER --merge
git fetch origin main; git rev-parse origin/main  # = reviewed_sha
```

Use merge commits (repository process). If any PR shows a conflict, stop:
resolve only with that branch owner's agreement, re-verify, then resume.
Never merge overlapping superseded PRs to "complete" the chain.

## 5. Confirm main CI, then apply migrations

Confirm "Public site asset and build checks" success on the merged main
SHA. Then apply `0006`–`0015` (additive only, zero DROP statements;
ALTERs are not re-runnable):

```powershell
npx wrangler d1 migrations apply aipster-app --remote
```

## 6. Readiness probe

```powershell
npx wrangler d1 execute aipster-app --remote --command `
  "SELECT name FROM d1_migrations ORDER BY id;"
# expect 0001..0015, fifteen rows
npx wrangler d1 execute aipster-app --remote --command `
  "PRAGMA table_info(key_verifiers);"
# must include: resource_id (added by 0013)
npx wrangler d1 execute aipster-app --remote --command `
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN
   ('pairing_codes','idempotency_keys','approvals','idempotency_records');"
# expect all four rows (0015 + fabric lineage)
```

Anything missing or out of order: stop, do not deploy; decide
roll-forward vs rollback with Peter.

## 7. Deploy the merged SHA

```powershell
gh workflow run public-site-production-deploy.yml `
  --repo synchronic1/AIPSTER --ref main -f reviewed_sha=<merged-main-sha>
```

Preflight enforces reviewed==built==main plus CI success. `verify:live`
then checks live bytes, release revision, cache policy, and anonymous
protections. It does not cover authenticated flows or inference.

## 8. Confirm and smoke-test

- `https://aipster.net/deployment.json` shows the merged SHA and the new
  site revision.
- Smoke (test account only, never a real user):
  1. Login via dashboard sign-in; logout ends the session.
  2. Mint a pairing code: `POST /api/pairing/codes` (session + CSRF).
  3. Claim on an isolated test worker: `pairing.py pair`, type the code.
  4. Heartbeat: `pairing.py heartbeat-loop --config configs/mock.toml`
     reports `usable=false` (reachability only).
  5. Unpair: `pairing.py unpair` exits 0 and removes local state.
  6. Delete: `DELETE /api/inventory/:id` (session + CSRF) removes the
     test resource; audit records the deletion.
- `POST /api/jobs` must stay `501 INFERENCE_DISABLED`. Do not activate
  live inference or F1P as part of release validation.

## 9. Rollback

- Database: D1 has no down-migrations. Restore via the Cloudflare
  dashboard (D1 -> aipster-app -> Backups -> point-in-time restore),
  which creates a restored database; rebind with a reviewed
  `wrangler.jsonc` change and redeploy; confirm the journal reads
  `0005` and the readiness probe fails closed as expected pre-chain.
- Site: re-dispatch `public-site-production-deploy` with the previous
  good `reviewed_sha`, or `git revert` the chain merges and release the
  revert through the same process.
- Roll-forward vs restore is Peter's call; record the decision.

## 10. After release

- Rebuild the Windows installer from the merge commit, re-qualify, and
  wire that exact verified artifact by hand. Installer download stays
  disabled until then.
- Close superseded PRs only after preserving branches and unique work.
- Keep the D1 backup for the retention window, then destroy it.

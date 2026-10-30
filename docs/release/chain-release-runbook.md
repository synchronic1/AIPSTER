# Chain release runbook (codex/sprint-* integration chain)

Release owner runbook for merging the integration chain and releasing it
to production. Merged from two drafts (71f2f32 plus verified specifics);
either author may extend it, but only the release owner executes it.

Executed 2026-10-30: chain merged to main `2ed8fdf`, production journal
`0001`..`0015`, deploy run 40981033161 succeeded, `/api/health` reports
`ready: true` and `detail.schema: true`. Keep this runbook as the
procedure for later chain-style releases.

Run every `wrangler` command from the `website` directory (it holds
`wrangler.jsonc`); `git` commands run from the repository root.

Database identity (from `website/wrangler.jsonc`): binding `DB`,
database `aipster-app` (`b91be793-704a-4eae-8b8f-7f4c8b78e4fc`),
`migrations_dir` `migrations`.

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

Keep the backup outside every repository. Record path, bytes, and
sha256 in the release notes. Reference backup: `d1-backups\`
`aipster-app-20261029-prechain.sql`, 8020 bytes.

CAUTION (merge note): the previously quoted reference hash for that
file was the SHA-256 of the empty string, which cannot be the hash
of an 8020-byte dump. Whoever holds that file must re-hash and
re-verify it before anyone relies on it.

Also record pre-change `GET https://aipster.net/api/health`
(`ready`, `detail.schema`) and `deployment.json` (`git_commit`).

## 3. Confirm the production journal

```powershell
npx wrangler d1 execute aipster-app --remote --command `
  "SELECT id, name, applied_at FROM d1_migrations ORDER BY id;"
```

Expected: exactly `0001_better_auth.sql` through
`0005_write_budget.sql`, in order, no fabric/pairing objects. Confirm the
five files are byte-identical between main and the chain tip (the
journal stores names, not content hashes, so compare tree blobs):

```powershell
git diff origin/main <chain-tip> --stat -- `
  website/migrations/0001_better_auth.sql website/migrations/0002_app.sql `
  website/migrations/0003_demo_auth.sql website/migrations/0004_disable_flag.sql `
  website/migrations/0005_write_budget.sql
# must print nothing
```

Stop if the journal differs: applied migrations are never edited or
reordered. Apply nothing in this step. A fix needing a schema change
not listed here stops the release.

## 4. Merge the chain in order

```powershell
# <sha29>..<sha36>: the full headRefOid values recorded in step 1.
gh pr merge 29 --repo synchronic1/AIPSTER --merge --match-head-commit <sha29>
gh pr edit 31 --repo synchronic1/AIPSTER --base main
gh pr merge 31 --repo synchronic1/AIPSTER --merge --match-head-commit <sha31>
gh pr edit 35 --repo synchronic1/AIPSTER --base main
gh pr merge 35 --repo synchronic1/AIPSTER --merge --match-head-commit <sha35>
gh pr edit 36 --repo synchronic1/AIPSTER --base main
gh pr merge 36 --repo synchronic1/AIPSTER --merge --match-head-commit <sha36>
git fetch origin main; git rev-parse origin/main  # = reviewed_sha
```

`gh pr merge` merges on GitHub only; the local tree still holds the old
migration files. Before step 5, check out the recorded merged SHA so
`wrangler` sees `0006`..`0015`:

```powershell
git checkout --detach <reviewed_sha>
git rev-parse HEAD                     # must equal reviewed_sha
Get-ChildItem website\migrations\0015_pairing.sql   # must exist
```

Each merge is bound to the head SHA that was reviewed: if a branch moved
after step 1, `--match-head-commit` refuses the merge. Stop there and get
the new head re-reviewed; never drop the flag or substitute the new SHA
without that review. Merge only when checks have finished (no pending
checks), so `gh` merges immediately instead of enabling auto-merge.

Use merge commits (repository process). If any PR shows a conflict, stop:
resolve only with that branch owner's agreement, re-verify, then resume.
Never merge overlapping superseded PRs to "complete" the chain.

## 5. Confirm main CI, then apply migrations

Confirm "Public site asset and build checks" success on the merged main
SHA. Then apply exactly these ten, in filename order (additive only,
zero DROP statements; ALTERs are not re-runnable):

- `0006_fabric.sql`, `0007_consent.sql`, `0008_repair2.sql`,
  `0009_state_layer.sql`, `0010_revision_receipts.sql`,
  `0011_fabric_admission.sql`,
  `0012_fabric_restriction_admission.sql`,
  `0013_heartbeat_binding.sql`,
  `0014_fabric_restriction_receipts.sql`, `0015_pairing.sql`.

```powershell
cd website
npx wrangler d1 migrations list aipster-app --remote   # lists 0006..0015 as pending
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

Application-level contract (independent of the SQL above):
`/api/health` probes `SELECT resource_id FROM key_verifiers LIMIT 0`,
so a database at 0005-shape reports `ready: false` and the deploy
workflow's `verify:live` rejects it. After deploy + migration,
expect `ready: true` and `detail.schema: true`.

## 7. Deploy the merged SHA

```powershell
gh workflow run public-site-production-deploy.yml `
  --repo synchronic1/AIPSTER --ref main -f reviewed_sha=<merged-main-sha>
```

Preflight enforces reviewed==built==main plus CI success. `verify:live`
then checks live bytes, release revision, cache policy, and anonymous
protections. It does not cover authenticated flows or inference.

Known flake: the inline verify sometimes reads stale edge bytes
immediately after upload ("Live bytes differ"). Wait 2 minutes and
re-run the identical check by hand before calling it failed.

## 8. Confirm and smoke-test

- `https://aipster.net/deployment.json` shows the merged SHA and the new
  site revision.
- Smoke (test account only, never a real user):
  1. Login via dashboard sign-in; logout ends the session.
  2. Mint a pairing code: `POST /api/pairing/codes` (session + CSRF).
  3. Claim on an isolated test worker: `pairing.py pair`, type the code.
     A second claim of the same code fails honestly.
  4. Heartbeat: `pairing.py heartbeat-loop` (equivalently
     `POST /api/resources/:id/heartbeat` with the heartbeat-scoped
     key) → 200 with fresh `heartbeat_at`; proves reachability
     only. A wrong-resource key is rejected.
  5. Unpair: `pairing.py unpair` exits 0 and removes local state on
     the happy path; any incomplete cleanup exits nonzero with keys
     preserved (never exit 0 with a live key on disk).
  6. Delete: `DELETE /api/inventory/:id` (session + CSRF) removes the
     test resource; bound keys read `KEY_REVOKED`; audit records
     `resource.delete`. A second delete is 404.
- Liveness is not inference readiness: heartbeats and pairing prove
  reachability only.
- `POST /api/jobs` must stay `501 INFERENCE_DISABLED` for a signed-in
  test session (anonymous callers get `401` first, from the sign-in
  check). Do not activate live inference or F1P as part of release
  validation.

Any smoke failure: roll back the deploy (step 9). Do not roll back
migrations without asking Peter.

## 9. Rollback

- Database: D1 has no down-migrations. Restore via the Cloudflare
  dashboard (D1 -> aipster-app -> Backups -> point-in-time restore),
  which creates a restored database; rebind with a reviewed
  `wrangler.jsonc` change and redeploy; confirm the journal reads
  `0005` and the readiness probe fails closed as expected pre-chain.
  Prove any dump-restore procedure on a throwaway database first.
- Site: preflight pins reviewed==main, so a rollback is always a
  forward release: `git revert` the chain merges (or merge a fix),
  wait for green CI, and dispatch the deploy workflow with the NEW
  reviewed SHA. Re-dispatching an old SHA against a moved main is
  rejected by design.
- Roll-forward vs restore is Peter's call; record the decision.

## 10. After release

- Rebuild the Windows installer from the merge commit, re-qualify, and
  wire that exact verified artifact by hand. Installer download stays
  disabled until then.
- Close superseded PRs only after preserving branches and unique work.
- Keep the D1 backup for the retention window, then destroy it.
- Federation stays default-off. Installer downloads stay disabled
  until a qualified signed artifact is uploaded. Don't change
  product claims.

## Record

The release note for this run must name: the four merge SHAs and
final main SHA, backup path + SHA-256, journal before/after,
deploy run ID, smoke results per step above, and anything left
open.

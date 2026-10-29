# Chain release runbook: migrations 0006–0015 + production deploy

Step-by-step production procedure for landing the integration chain
(#29 → #31 → #35 → #36) once Claude has merged it to main. The chain
executor (Claude) runs the merge steps; the release owner runs the
database and deploy steps below. Muse authored this file only; it has
not executed any step in it.

Preconditions:

- Chain merged to main in order with merge commits; record the four
  merge SHAs and the final main SHA before starting.
- Working tree clean; `main` CI green on the final SHA.
- Federation stays default-off. Installer downloads stay disabled until
  a qualified signed artifact is uploaded. No inference activation.
- A Cloudflare-authenticated shell (the `CLOUDFLARE_API_TOKEN` or login
  this runbook needs is provisioned by the owner through the approved
  channel, never pasted into chat or committed).

Database identity (from `website/wrangler.jsonc`):

- binding `DB`, database `aipster-app`
  (`b91be793-704a-4eae-8b8f-7f4c8b78e4fc`), `migrations_dir`
  `migrations`.

## 1. Back up production D1 (before anything else)

```sh
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
wrangler d1 export aipster-app --remote --output="/private/backups/aipster-app-$STAMP.sql"
sha256sum "/private/backups/aipster-app-$STAMP.sql" | tee "/private/backups/aipster-app-$STAMP.sha256"
```

- Store outside the repo. Never commit the dump.
- Sanity: dump is non-trivially sized and contains the
  `d1_migrations` table rows.
- Record the backup path + SHA-256 in the release notes.
- Also record pre-change `GET https://aipster.net/api/health`
  (`ready`, `detail.schema`) and
  `GET https://aipster.net/deployment.json` (`git_commit`).

## 2. Check the applied journal (read-only)

```sh
wrangler d1 execute aipster-app --remote \
  --command "SELECT id, name FROM d1_migrations ORDER BY id;"
```

Expected: exactly `0001_better_auth` through `0005_write_budget`
(the numeric prefixes; full filenames end in `.sql`).

Byte-identity of already-applied files: the journal stores names,
not content hashes, so compare the reviewed tree blobs:

```sh
git rev-parse HEAD:website/migrations/0001_better_auth.sql
# ... repeat 0002..0005, and confirm the chain branch copies match:
git rev-parse origin/codex/sprint-onboarding-integration-20261029:website/migrations/<same>
```

All five pairs must be identical. (Verified during release prep:
main and the chain branch agree on 0001–0005.)

STOP and report instead of proceeding if:

- any applied migration filename is missing or unexpected;
- any file to be applied would alter an already-applied migration;
- a fix needs a schema change not listed in this runbook.

## 3. Apply pending migrations in order

```sh
wrangler d1 migrations apply aipster-app --remote
```

Expected: exactly ten journals added, in filename order:

- `0006_fabric.sql`, `0007_consent.sql`, `0008_repair2.sql`,
  `0009_state_layer.sql`, `0010_revision_receipts.sql`,
  `0011_fabric_admission.sql`,
  `0012_fabric_restriction_admission.sql`,
  `0013_heartbeat_binding.sql`,
  `0014_fabric_restriction_receipts.sql`, `0015_pairing.sql`.

Re-run the journal query: 15 rows, no gaps. Do NOT apply any
migration.

## 4. Health and readiness

```sh
curl -s https://aipster.net/api/health
```

- After the deploy in step 5, expect `ready: true` and
  `detail.schema: true`.
- The readiness probe includes the 0013 contract:
  `SELECT resource_id FROM key_verifiers LIMIT 0` must succeed;
  a database at 0005-shape reports `ready: false`, and the
  deploy workflow's `verify:live` rejects such a state.
- If `ready` is false after deploy + migration, treat it as a
  failed release and go to rollback (step 7), not to retries.

## 5. Deploy the reviewed main SHA

Dispatch the `Public site production deploy` workflow on `main`
with `reviewed_sha` set to the exact final main SHA. Then:

- Confirm `deployment.json` shows that `git_commit` and the new
  `site_revision`.
- Known flake: the workflow's inline `verify:live` sometimes reads
  stale edge bytes immediately after upload ("Live bytes differ").
  Wait 2 minutes and re-run the identical check by hand before
  calling it failed. (Edge-cache fix is tracked separately.)

## 6. Production smoke tests (test account only)

Use an isolated test account and synthetic fixtures. Never use the
owner's private inventory, provider credentials, or real compute.

1. Login: GitHub sign-in reaches the app; logout ends the session.
2. Pairing mint: `POST /api/pairing/codes` (session + CSRF) → code.
3. Pairing claim: `POST /api/pairing/claim` from the test worker →
   paired; second claim of the same code fails honestly.
4. Heartbeat: `POST /api/resources/:id/heartbeat` with the
   heartbeat-scoped key → 200 and a fresh `heartbeat_at` on the
   owner's dashboard; wrong-resource key is rejected.
5. Unpair (local worker): unpair exits 0 with keys removed on the
   happy path; any incomplete cleanup exits nonzero with keys
   preserved (never exit 0 with a live key on disk).
6. Delete: `DELETE /api/inventory/:id` (session + CSRF,
   owner-only) → resource gone, bound keys read `KEY_REVOKED`,
   `resource.delete` audited; a second delete is 404.
7. Liveness is not inference readiness: heartbeats and pairing
   prove reachability only. No model calls in this release.

Any smoke failure: roll back the deploy (step 7). Do not roll
back migrations without asking Peter.

## 7. Rollback

- Code rollback (preferred, always safe): merge a revert or fix
  PR to main, wait for green CI, dispatch the deploy workflow
  with the new reviewed SHA, re-run steps 4–6.
- Data rollback (destructive, owner-only): restore the step-1
  backup by re-importing the dump. Prove the procedure first on
  a throwaway database (create scratch D1, import dump, confirm
  journal + spot data), then execute against production only on
  Peter's explicit instruction. Never invent a partial
  down-migration.

## Record

The release note for this run must name: the four merge SHAs and
final main SHA, backup path + SHA-256, journal before/after,
deploy run ID, smoke results per step above, and anything left
open.

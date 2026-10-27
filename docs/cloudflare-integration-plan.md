<!-- Built with Meta Muse. -->
# AIPSTER control panel — Cloudflare integration plan

Goal: connect the existing control panel to real sign-in on the current public
site (`https://aipster.net/`) without replacing the landing page or building a
competing dashboard. Status: local integration implemented and tested; production
wiring awaits the account actions in “Exact next actions”.

## 1. Current state (verified this session)

- Repo `synchronic1/AIPSTER`, default branch `main` at `1b91dc1` (“Keep production
  Worker preview URLs disabled (#2)”, 2026-10-27). PR #1 merged as `ee1a1a0`.
  Draft PR #3 (`muse/control-panel-cloudflare-auth`, from `origin/main`
  `1b91dc1`) carries this work; Codex `codex/pr3-independent-review-20261027`
  exists only in the isolated local review worktree (tooling commit `fc677ba`
  cherry-picked into PR #3 as `e6a4557`).
- Live site serves public release `2026-10-26.8`, `auth_deployed: false`; the
  landing Sign in links to `/app/` (404 until this branch deploys) and the
  progress section states login is not yet enabled. Independent fresh checks
  (Codex, 2026-10-27): apex + workers.dev serve `deployment.json` at `1b91dc1`,
  landing 200, `/app` 404, `/api/health` 404 — login/panel/inference not live.
- Rollout ownership: Muse implements on the PR branch; Goose is the sole
  merge/provision/deploy owner (acknowledgment still pending per Codex handoff
  manifest `a4d5dc1`, `docs/pr3-rollout-review.json` in the review worktree —
  secret NAMES only, no values). Observed rollback target: Worker version
  `650bb690-8eb2-43e0-8ddb-09509848b887` (re-verify availability before use).
- Static deploy recovered: `CLOUDFLARE_API_TOKEN` secret exists and a
  `production` environment exists. `main` has NO branch protection; no
  required checks/reviewers are enforced. Copilot review gate is blocked
  (quota insufficient) — do not claim it ran.
- Control panel checkout: `Aipster/aipster-local/` (unversioned local directory,
  NOT in git). Node 24, zero dependencies, JSON-file DB, scrypt passwords,
  in-memory sessions, deterministic fake adapter + EIF 501 stub. Screens:
  Overview, My Compute, Shared With Me, Sharing, API Keys, Usage, Settings.
- Provisioning evidence (Codex, read-only): Cloudflare dashboard lists 4 D1
  databases, none named `aipster-app`; existing token gets 401 on D1 listing
  (Workers reads succeed). Personal GitHub OAuth Apps lists only HeurChain —
  no AIPSTER app. No OAuth app, no D1 database, no approved identity names
  exist yet. The private `resource-dashboard` remains an operator inventory
  and is not used as the customer backend.

## 2. Target architecture

One apex Worker (`aipster-public-site`) keeps serving the static landing page
byte-for-byte (including progress/changelog/journal sections). Worker code runs
first and routes:

- `/api/auth/*` → Better Auth handler (GitHub OAuth for invited testers +
  seeded demo username/password via the maintained `username` plugin, D1
  sessions, database-backed throttling).
- `/api/*` (other) → control-panel JSON API, always JSON (errors never fall
  through to the static 404 page).
- `/app`, `/app/*` → control-panel UI from static assets (login view when
  signed out, 7 tabs when signed in).
- everything else → `ASSETS` (landing, diagrams, release.json).

No separate Worker (no second origin to secure), no R2/KV/Durable Objects/
Queues/Tunnel: D1 alone covers identity, sessions, resources, grants, keys,
usage and audit at this scale. D1 read replication stays OFF so revocation and
session checks read strongly-consistent state.

## 3. Resource / binding / secret table

| # | Resource | Proposed name | Binding / route | Env | Free-tier note (re-verify at provisioning) | Rollback |
|---|----------|---------------|-----------------|-----|---------------------------------------------|----------|
| R1 | Apex Worker (EXISTS — reuse, do not recreate) | `aipster-public-site` | `aipster.net/*` (existing custom domain) | production | Workers free: 100k req/day | Redeploy previous `dist` via `wrangler rollback` or re-run deploy on prior `main` |
| R2 | D1 database (NEW) | `aipster-app` | `DB` in `wrangler.jsonc` + `migrations_dir: migrations` | production + local (`--local`) | D1 free: 5M reads / 100k writes per day, 5 GB | Migrations are additive; down path is documented manual drop of the added tables; data export via `wrangler d1 export` before any destructive step |
| R3 | GitHub OAuth app (NEW, user creates) | `AIPSTER` | callback `https://aipster.net/api/auth/callback/github`, scopes `read:user`, `user:email` | production | GitHub OAuth free | Delete/disable the app; sessions fail closed |
| R4 | App secret (NEW, user enters) | `BETTER_AUTH_SECRET` | Worker secret + local `.dev.vars` (gitignored) | production, preview-off, local | n/a | Rotate via `BETTER_AUTH_SECRETS` rollover; old sessions re-login |
| R5 | OAuth credentials (NEW, user enters) | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Worker secrets (+ mirror as GitHub secrets only if CI needs them; it does not) | production, local | n/a | Rotate in GitHub app settings, update secrets |
| R6 | Deploy credential (EXISTS — reuse) | `CLOUDFLARE_API_TOKEN` | GitHub repo secret | CI `production` env | n/a | Rotate in Cloudflare dashboard, update secret |
| R7 | Deploy gate (EXISTS, unconfigured) | `production` environment | GitHub environment | CI | n/a | Add required reviewers; no code change |

Variable NAMES only are listed here. Values never appear in source, logs,
bundles, or this document.

## 4. Migrations (reviewed, versioned, additive)

- `0001_better_auth.sql`: Better Auth core tables (`user`, `session`,
  `account`, `verification` + indexes), DDL verified by running real Better
  Auth 1.7.14 session flows against it in tests.
- `0002_app.sql`: `resources`, `grants`, `key_verifiers`, `jobs`, `usage`,
  `audit`, `allowlist` (adapted from the local `schema.sql`; no password
  columns in app tables — Better Auth owns identity; `owner_id` references
  `user.id`).
- `0003_demo_auth.sql`: `username`/`displayUsername` plugin columns, `demo`
  workspace flag, `rateLimit` table for database-backed throttling.
- `0004_disable_flag.sql`: `disabled` account flag for membership revocation.

Apply in order: `wrangler d1 migrations apply aipster-app --remote`
(production), `--local` for development. 0001/0002 are re-runnable
(`IF NOT EXISTS`); 0003/0004 apply once via the D1 migration journal
(SQLite has no `ADD COLUMN IF NOT EXISTS`). Existing databases: per §1,
none named `aipster-app` exists; do not reuse or mutate unrelated ones.

## 5. Policy decisions (confirm where marked)

- **Invited test users (ASSUMED — needs confirmation):** signup beyond the
  `allowlist` is rejected in `databaseHooks.user.create.before`, which now
  also requires a provider-verified email (`emailVerified === true` from the
  GitHub verified-emails adapter). Public signup policy is NOT established;
  do not treat the allowlist as a general production owner policy. Seed
  invited emails per environment with `wrangler d1 execute` (documented
  command, never committed data). Two approved identity names are still
  pending from Peter — do not invent or seed them.
- **Demo username/password (APPROVED scope change):** one seeded `demo`
  identity signs in via the maintained Better Auth `username` plugin +
  credential account (scrypt via the library, never plaintext, never a
  parallel session system). `user.demo = 1` marks the isolated demo
  workspace: synthetic fixtures only, grants/invitations refused server-side
  (`403 DEMO_RESTRICTED`), minted API keys forced to the `aip_demo_` prefix
  with sandbox metadata, dispatch disabled like everyone else. Public
  registration stays closed (`disableSignUp`, verified by test). Provision
  with `D1_PASSWORD='<generated-20+>' node scripts/setup-demo.mjs --db
  aipster-app [--remote]` (idempotent; hashes before touching SQL; password
  travels a private channel only, never source/logs). When D1_PASSWORD is
  unset the script prompts with hidden input (TTY only); a masked prompt is
  unit-tested, env delivery stays supported. Rotate by re-running with a new
  password; disable ONLY via `scripts/disable-user.mjs --user demo
  --delete-password` (demo classification immutable, sessions/keys revoked).
  Throttled: 10 username/email
  sign-in attempts per rolling 60 s (plus Better Auth's 3/10 s sign-in
  default), generic failures, no account-existence oracle (tested).
- **Membership revocation (explicit disable path):** removing an email from
  the allowlist blocks future signups only. To revoke a live user the
  rollout owner runs `scripts/disable-user.mjs --db aipster-app --user
  <id-or-email> [--delete-password] [--remote]`, which executes the
  canonical statements in `scripts/lib/operator-sql.mjs` (also executed
  verbatim by the regression suite): `disabled = 1`, session rows deleted,
  API keys revoked, allowlist entry removed, optional password-credential
  deletion. The demo flag is never modified. `disabled = 1` blocks new
  sessions (session-create hook, `403 ACCOUNT_DISABLED`), deadens existing
  sessions + API keys for app APIs, and fences the maintained auth
  endpoints (only sign-out/revoke allowed; `get-session`/mutations 401).
  Demo users are additionally barred from self-service auth mutations
  (`update-user`, `change-password`, etc., `403 DEMO_RESTRICTED`); demo
  credentials stay owner-managed (tested through the actual handler).
- **Grant sandbox boundary:** grants never cross real↔demo in either
  direction. Creation to a demo grantee is refused (`403 DEMO_RESTRICTED`,
  alongside the existing demo-creator refusal); reads treat legacy/stale
  cross-boundary rows as absent (resource detail, both grant lists,
  quota preflight). Grant deletion stays owner-only so legacy rows can be
  cleaned up (tested both directions, sessions and keys).
- **Canonical host:** with an https `BETTER_AUTH_URL`, `/api/*` and `/app*`
  answer only on that origin (`403 WRONG_HOST` elsewhere); public assets
  are unaffected and local http dev is unpinned (tested).
- **Readiness contract:** `/api/health` `ready` requires all app tables AND
  the 0003/0004 columns (`username`, `displayUsername`, `demo`, `disabled`,
  `rateLimit` fields); the deployment verifier asserts `ready === true`
  (tested, incl. failure fixtures).
- **Provider tokens:** OAuth access/refresh/ID tokens are stripped by
  account create/update hooks before persistence — identity + sessions
  only (tested).
- **Inference dispatch DISABLED:** `POST /api/jobs` returns `501
  INFERENCE_DISABLED`. No paid inference, training, model swaps, billing, or
  Stripe in this task. No fake adapter runs in production; no fixtures are
  presented as live resources.
- **EIF ownership split:** Codex owns EIF restoration/operation (review,
  upstream fixes, runtime qualification); AIPSTER must not repair, redeploy,
  restart, or change EIF, its runtimes, credentials, or contracts (read-only
  inspection only). AIPSTER integrates solely against Codex's verified
  contract + authorized endpoint, with only the agreed bounded end-to-end
  check after that handoff. EIF breakage/ambiguity is reported back as a
  Codex blocker while independent AIPSTER work continues.
- **Session/cookies:** Better Auth database sessions, HttpOnly cookies,
  `Secure` + `SameSite=Lax` in production, 12h expiry, server logout deletes
  the session row. Telemetry explicitly disabled.
- **Our API CSRF:** same-origin `Origin`/`Referer` check plus required
  `X-Aipster-CSRF: 1` header on session mutations (Better Auth routes keep
  their own CSRF/state/PKCE handling).
- **Tenant isolation:** every resource/grant/key/job/usage/audit row carries
  `owner_id = user.id`; all reads/writes filter by the session user or an
  active grant. API keys (`aip_live_…`, `aip_demo_…` for the demo tenant) are
  read/inference-scoped, salted SHA-256 verifiers, one-time reveal,
  revocable; never upstream keys.
- **Static checker evolution (Codex-owned tooling, cherry-picked):** parsed
  HTML/URL checks with exact approved destinations, shipped-JS privacy scan,
  form-handler scan; landing + 404 stay script-free. Landing Sign in targets
  `/app/`.
- **Request limits:** app JSON bodies stream with a 64 KiB wire-byte cap
  (tested with multibyte payloads); declared over-cap `/api/auth/*` bodies
  are rejected before the auth library. `/api/health` is schema-aware:
  `ready` requires the full table set, booleans only, no secret metrics.

## 6. CI/CD and gate status

`Public site checks` runs check/test/build/bundle. The production deploy
workflow is now explicit-`workflow_dispatch` on a reviewed merged SHA with a
release preflight + wired anonymous live verifier (Codex tooling, `e6a4557`).
Prior gaps: deployment credentials — EXISTS (R6/R7, reuse); review gates —
STILL UNPROTECTED (`main` and `production` have no protection rules; Copilot
blocked by quota — do not claim it ran); post-deploy verification — WIRED
(anonymous verifier runs after deploy; live-auth validation stays a separate
manual checklist, §8 step 7). Do not merge/deploy until branch protection +
required checks + `production` reviewers are on and the final head is
re-reviewed.

## 7. Test plan (all committed under `website/`)

`npm test` (133 green on the final head): migrations incl. 0003/0004; real
session round-trips; unauthenticated 401s; cross-user 404s; grants/quotas
incl. real↔demo boundary both directions; key lifecycle incl. `aip_demo_`
sandbox prefix; allowlist + verified-email gate (unit + stubbed-GitHub
OAuth callback matrix, Codex-adopted probes); byte-cap streaming incl.
multibyte + chunked/flood auth bodies; token stripping; operator disable
(canonical statements, immutable demo, sessions/keys/sign-ins revoked);
demo/disabled auth-endpoint fencing through the actual handler; canonical
host guard; column-aware health + verifier `ready` requirement; exact-client
DOM-fixture UI session tests (logout clearing, stale fencing, failed logout);
EIF truthfulness guards (`501 INFERENCE_DISABLED`, no outbound inference
calls); 44 checker + verifier/preflight suites.
`wrangler dev --local` smoke incl. `/app` UI desktop/mobile. Live GitHub
handshake with two approved identities stays PENDING (needs R3–R5 + names);
stubbed flows are not presented as OAuth evidence.

## 8. Exact next actions (Goose-owned rollout; cf. Codex manifest `a4d5dc1`)

1. Goose acknowledges sole rollout ownership on PR #3.
2. Re-review the exact final head (demo boundaries, migrations 0001–0004,
   tooling `e6a4557`); require CI green; turn on branch protection
   (required checks + review) and `production` environment reviewers.
3. `wrangler d1 create aipster-app` → replace the zero `database_id` in
   `wrangler.jsonc` (reviewed config commit); `wrangler d1 migrations apply
   aipster-app --remote`. Needs Cloudflare account D1 Edit (existing token
   401s on D1 listing).
4. Create GitHub OAuth app `AIPSTER` (callback + scopes from R3);
   `openssl rand -base64 32` for the app secret; set `BETTER_AUTH_SECRET`,
   `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` via `wrangler secret put`
   (production) and local `.dev.vars` (gitignored). `BETTER_AUTH_URL` is
   already `https://aipster.net` in committed `vars` (non-secret).
5. Seed ONLY approved identities: invited emails via `wrangler d1 execute`;
   demo account via `scripts/setup-demo.mjs --remote` with a privately
   delivered generated password (never committed/logged).
6. Merge the reviewed head; dispatch the production workflow with
   `reviewed_sha` = full merged SHA; run the wired anonymous verifier and
   correlate `deployment.json`, CI run, merged commit, Cloudflare version.
7. Live verify with the two approved identities: GitHub sign-in → `/app`
   panel → permitted API call → logout → denied; demo username sign-in →
   isolated workspace → restrictions hold; cross-tenant checks; record
   release id.
8. Rollback at any point: `npx wrangler rollback 650bb690-8eb2-43e0-8ddb-
   09509848b887 --name aipster-public-site` (re-verify target first).
   Preserve D1 data/migrations/identities/secrets — never drop tables or
   restore over newer user data for a code rollback. Rotate secrets if
   exposure is suspected.

## 9. Open confirmations

- Invited-email policy vs another signup rule.
- D1 database name `aipster-app` acceptable.
- Custom domain stays apex-only (no `app.` subdomain, no DNS change).
- Two approved identity names (pending from Peter).
- Hermes incident summary: sanitized log references unavailable — treated as
  reported evidence only; no incident reproduction claimed.

## 10. Bounded EIF end-to-end check (PLANNED — blocked, no live endpoint)

Preconditions (all outstanding): Codex supplies a verified, authorized live
endpoint + agent token custody design; Peter authorizes the check. Until
then `/api/jobs` stays `501 INFERENCE_DISABLED` (guarded by tests).

Contract source (read-only): EIF restoration worktree at `67a3ce0` (docs) /
`7395b50` (code), `docs/restoration/HANDOFF.md`. Stable interface: agent
`Bearer` token; `GET /v1/resources` eligible capacity; `GET /v1/models`
roster; `POST /v1/tasks` → 202 (`capability`, exactly one of
`prompt`/`messages`, `max_tokens` 1..4096, `allow_simulated=false` for real
inference, optional `idempotency_key` 8..128 ASCII); `GET /v1/tasks/{id}`
poll (`running` → `succeeded`/`failed`/`expired`; inspect `status`, not just
HTTP 200); result envelope ≤1 MiB with correlated IDs, `simulated` flag,
`usage`; gateway deadline 180 s; no queue (409 when no idle runtime).

Planned check (single bounded run): authenticated submit with a fresh
idempotency key → ownership isolation (second identity cannot read the task)
→ poll to a terminal state → error/truncation handling → record provenance
(request/node/runtime/model IDs, `simulated:false`, elapsed, usage) →
re-submit same key returns the same task (no duplicate work). Abort on any
non-`false` `simulated` flag or missing correlation. No fallback, download,
restart, or shared-token-across-users design.

## 11. Independent-review disposition (PR #3)

| # | Finding | Disposition |
|---|---------|-------------|
| 1 | Invitation gate admits `emailVerified:false` | FIXED: `checkInvitation` requires allowlist + verified email; unit + stubbed-callback matrix green |
| 2 | Provider tokens persisted in plaintext | FIXED: account create/update hooks strip OAuth tokens; credential passwords untouched; hook-level tests |
| 3 | Verifier unwired + expects `/app` 404 | FIXED by Codex tooling `e6a4557` (wired anonymous verifier + preflight + explicit-dispatch workflow) |
| 4 | Static-checker bypasses | FIXED by Codex tooling `e6a4557` (44 parse5 checker tests); this branch's checker edits reverted in favor of it |
| 5 | Char-count instead of byte cap | FIXED: streaming byte reads + cancel; multibyte + oversized probes green; auth precheck added |
| 6 | No disable/membership-revocation path | FIXED: migration 0004 `disabled` flag; new sessions refused, existing sessions + keys deadened; tests |
| 7 | `/api/health` ignores schema; `secretLen` leak | FIXED: schema-aware `ready`, booleans only |
| 8 | Failed sign-out presented as completed | FIXED: client transitions only on success, banners failures |
| — | Demo username/password scope change | IMPLEMENTED per §5 (username plugin, sandbox, throttling, closed signup); fresh review required |
| F77-1 | Real→demo grants creatable and readable | FIXED: creation refused both directions; reads treat cross-boundary rows as absent; both-direction session+key tests |
| F77-2 | Documented demo disable promotes | FIXED: `disable-user.mjs` + canonical statements (demo immutable, sessions deleted, keys revoked, sign-ins blocked); unsafe recipe removed from script header and docs; suite executes the exact statements |
| F77-3 | Demo can change credentials/username | FIXED: demo barred from self-service auth mutations (`DEMO_RESTRICTED`); rotation owner-operated; real users unaffected (tested) |
| F77-4 | Disabled sessions mutate auth endpoints | FIXED: disabled fenced off all `/api/auth/*` except sign-out/revoke (401 incl. `get-session`); tested through the actual handler |
| F77-5/6 | Owner key/data leaks across logout; late responses repopulate demo UI | FIXED: `resetState()` on logout/sign-in + identity-generation fencing of async work and renders; exact-client DOM-fixture tests (success, late-error, failed-logout cases) |
| F77-7 | Missing 0004 reported ready | FIXED: health requires 0003/0004 columns via portable probes, not just tables |
| F77-8 | Verifier accepts unready schema | FIXED (minimal ownership-exception edit + fixture update, flagged for re-review): verifier asserts `ready === true`; failure fixtures added |
| F77-9 | Auth cap depends on declared length | FIXED: auth bodies streamed through the byte cap and forwarded; absent/chunked/flood/lying-length cases tested |
| F77-10 | Alternate-host auth accepted | FIXED: https canonical-origin guard on `/api/*` + `/app*` (`WRONG_HOST`); public assets unchanged; local http unpinned (tested) |

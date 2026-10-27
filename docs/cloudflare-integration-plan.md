<!-- Built with Meta Muse. -->
# AIPSTER control panel — Cloudflare integration plan

Goal: connect the existing control panel to real sign-in on the current public
site (`https://aipster.net/`) without replacing the landing page or building a
competing dashboard. Status: local integration implemented and tested; production
wiring awaits the account actions in “Exact next actions”.

## 1. Current state (verified this session)

- Repo `synchronic1/AIPSTER`, default branch `main` at `1b91dc1` (“Keep production
  Worker preview URLs disabled (#2)”, 2026-10-27). PR #1 merged as `ee1a1a0`.
  Branches: `main`, `codex/production-disable-preview-urls`,
  `codex/public-site-source-checks`. No open PRs (before this work).
- Live site serves public release `2026-10-26.7`, `auth_deployed: false`; the
  Sign in link points at `#progress` and the page states login is not enabled.
- Static deploy recovered: `CLOUDFLARE_API_TOKEN` secret exists (set 2026-10-27)
  and a `production` environment exists. `main` has NO branch protection; no
  required checks/reviewers are enforced. Copilot review gate is blocked
  (quota insufficient) — do not claim it ran.
- Control panel checkout: `Aipster/aipster-local/` (unversioned local directory,
  NOT in git). Node 24, zero dependencies, JSON-file DB, scrypt passwords,
  in-memory sessions, deterministic fake adapter + EIF 501 stub. Screens:
  Overview, My Compute, Shared With Me, Sharing, API Keys, Usage, Settings.
- No Better Auth / Workers / D1 auth slice exists anywhere found (workspace-wide
  search plus likely checkouts; zero matches). No OAuth app, no D1 database, no
  owner policy exists or is approved. The private `resource-dashboard` remains an
  operator inventory and is not used as the customer backend.
- Integration branch: `muse/control-panel-cloudflare-auth` (from `origin/main`
  `1b91dc1`). Working tree carries only this task's files.

## 2. Target architecture

One apex Worker (`aipster-public-site`) keeps serving the static landing page
byte-for-byte (including progress/changelog/journal sections). Worker code runs
first and routes:

- `/api/auth/*` → Better Auth handler (GitHub OAuth, D1 sessions).
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

`website/migrations/0001_better_auth.sql`: Better Auth core tables
(`user`, `session`, `account`, `verification` + indexes), DDL verified by
running real Better Auth 1.7.14 session flows against it in tests.
`website/migrations/0002_app.sql`: `resources`, `grants`, `key_verifiers`,
`jobs`, `usage`, `audit`, `allowlist` (adapted from the local `schema.sql`;
password columns dropped — Better Auth owns identity; `owner_id` references
`user.id`).

Apply: `wrangler d1 migrations apply aipster-app --remote` (production),
`--local` for development. Existing databases: none exist; nothing to preserve.

## 5. Policy decisions (confirm where marked)

- **Invited test users (ASSUMED — needs confirmation):** signup beyond
  `allowlist.verified_email` is rejected in `databaseHooks.user.create.before`.
  Public signup policy is NOT established; do not treat the allowlist as a
  general production owner policy. Seed invited emails per environment with
  `wrangler d1 execute` (documented command, never committed data).
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
  active grant. API keys (`aip_live_…`) are read/inference-scoped, salted
  SHA-256 verifiers, one-time reveal, revocable; never upstream keys.
- **Static checker evolution:** allowlist grows 14 → 18 (`app/*` UI files);
  same-origin `/app/app.js` is permitted ONLY in `app/*.html`; the landing
  page and 404 stay script-free (covered by a negative test). Landing Sign in
  now targets `/app/` (explicitly permitted in the checker).

## 6. CI/CD and gate status

Existing `Public site checks` workflow still runs check/test/build/bundle; `npm
test` now also runs the integration suite. Prior gaps: deployment credentials —
FIXED (R6/R7 exist); review gates — UNFIXED (no branch protection, Copilot
blocked); post-deploy verification — UNFIXED (`verify:live` exists but is not
wired into any gate). Do not enable automatic production deployment until at
minimum: branch protection with required checks is on, and a post-deploy
`/health` + `/release.json` verification step runs after deploy.

## 7. Test plan (all committed under `website/tests/`)

Migrations apply cleanly; login callback shape (redirect + state, no network);
session get/logout round-trip; unauthenticated 401s; cross-user 404s on
resources/grants/keys/usage; grant create/revoke + quota boundaries; key
mint/one-time reveal/verify/scope/expiry/revoke; allowlist accept/reject;
missing secrets fail closed (500 `CONFIG`, no leak); API errors stay JSON
(asset fallback never swallows them); static gates green; `wrangler dev`
local-D1 smoke incl. `/app` UI and desktop/mobile viewports. Live GitHub
handshake with two identities stays PENDING (needs R3–R5); mocked flows are
not presented as OAuth evidence.

## 8. Exact next actions (smallest concrete order)

1. `wrangler d1 create aipster-app` → put `database_id` in `wrangler.jsonc`;
   `wrangler d1 migrations apply aipster-app --remote`.
2. Create GitHub OAuth app (callback + scopes from R3); `openssl rand -base64 32`
   for the app secret; set `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID`,
   `GITHUB_CLIENT_SECRET` via `wrangler secret put` (production) and local
   `.dev.vars` (gitignored).
3. Seed invited emails: `wrangler d1 execute aipster-app --remote --command
   "INSERT INTO allowlist (email, added_at) VALUES ('…', …)"`.
4. Turn on branch protection (required checks + 1 review) and `production`
   environment reviewers; merge this branch; re-run the deploy workflow.
5. Live verify: Sign in → GitHub authorization → `/app` panel → permitted API
   call → logout → denied; repeat with a second identity; record release id.
6. Rollback at any point: `wrangler rollback` (Worker + assets), D1 additive
   migrations need no down action for a code rollback; rotate secrets if
   exposure is suspected.

## 9. Open confirmations

- Invited-email policy vs another signup rule.
- D1 database name `aipster-app` acceptable.
- Custom domain stays apex-only (no `app.` subdomain, no DNS change).

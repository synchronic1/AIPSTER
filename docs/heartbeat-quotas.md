# Heartbeat intake budgets (per-owner + deployment-wide)

Fixes handoff finding 3 (P2 security) on `muse/heartbeat-intake`: heartbeats
used to skip every aggregate ceiling — the only limit was one accepted write
per resource per 25s — so total D1 write volume grew with the number of
accounts. This slice adds a per-owner hourly budget and a deployment-wide
hourly ceiling, both enforced atomically.

> **PLACEHOLDERS — not production numbers.** Every default below is explicitly
> a placeholder. Peter and release review choose the final values for the
> plan tier; this change only proposes the mechanism and the cost model.

## Proposed limits

| Budget | Env override | Placeholder default | Window |
|---|---|---|---|
| Per owner | `HEARTBEAT_OWNER_PER_HOUR` | `500`/hour (**PLACEHOLDER**) | UTC hour bucket |
| Deployment-wide | `HEARTBEAT_GLOBAL_PER_HOUR` | `1000`/hour (**PLACEHOLDER**) | UTC hour bucket |

- Both limits count **accepted heartbeats only**. Rejected requests are
  read-only except for the narrow cases listed under "Write cost".
- Constants live in `website/src/lib/quotas.js` with a `PLACEHOLDER` suffix;
  env vars (positive integers, anything else falls back to the constant) let
  the rollout owner tune without a code change.
- Counters reuse the existing `write_budget` table under an `hb/<UTC hour>`
  window namespace, with the reserved user id `heartbeat:global` for the
  deployment bucket. This mirrors the established `s:` session namespace in
  `website/src/lib/auth.js`: **no migration is needed** (0013 stays as-is —
  see below), and neither budget draws from the 120/hour mutation rows or the
  session rows, which use different window keys.

## Enforcement

Order inside `POST /api/resources/:id/heartbeat` (`website/src/worker.js`):

1. Existing auth/binding/body checks first (unchanged, zero budget impact).
2. Fast path: a closed 25s window returns `429 HEARTBEAT_TOO_SOON` before any
   budget write. Optimization only — the conditional `UPDATE` still enforces
   the window atomically.
3. Claim the per-owner budget (one conditional `UPDATE`, exactly like
   `checkWriteBudget`). On failure: `429 HEARTBEAT_OWNER_QUOTA` with
   `Retry-After` (seconds until the next UTC hour) and a matching
   `retryAfterSec` body field. The resource row is untouched.
4. Claim the global budget the same way. On failure the owner claim is
   refunded and the response is `429 HEARTBEAT_GLOBAL_QUOTA` with
   `Retry-After`.
5. Run the existing single conditional resource `UPDATE`. On success: `200`.
   On a lost race both claims are refunded (each refund pairs with its own
   prior claim, so counts never go negative and accepted heartbeats never
   exceed the caps), then the existing read-only reason mapping applies.

Concurrent racers serialize in SQLite/D1: at cap−1, ten concurrent
heartbeats produce exactly one accepted heartbeat (covered on real local D1
in `website/tests/heartbeat-quotas.test.mjs`).

## Write cost (D1 rows written)

Counting rules come from the Cloudflare D1 pricing source below: write ops
are `INSERT`/`UPDATE`/`DELETE`; one touched row is one written row
regardless of size; a write touching an indexed column adds one further
written row; `SELECT` writes zero rows.

### Per accepted heartbeat (steady state): 3 rows

| # | Statement | Rows | Why |
|---|---|---|---|
| 1 | `UPDATE write_budget` (owner claim) | 1 | `count` is not indexed; the PK lookup does not move the row |
| 2 | `UPDATE write_budget` (global claim) | 1 | same |
| 3 | `UPDATE resources SET heartbeat_at, online, usable` | 1 | none of the three columns is indexed (`0002` indexes `owner_id` only) |

Hourly overhead outside the steady state (each at most once per owner per
hour, plus once per hour globally): one bucket `INSERT OR IGNORE`, one
old-bucket cleanup `DELETE`, and the coarse `key_verifiers.last_used_at`
refresh (at most one per key per hour, shared with all API-key use). A
handful of rows per active owner per hour — negligible next to beat volume
and included as ~1k rows/day upper bound in the worst cases below.

### Per rejected heartbeat

| Path | Rows written |
|---|---|
| Auth / binding / body reject (before claims) | 0 from intake; at most the coarse `last_used_at` refresh (≤1/key/hour) |
| 25s window closed, sequential (pre-probe `429`) | 0 from intake (same `last_used_at` caveat) |
| Per-owner cap spent (`HEARTBEAT_OWNER_QUOTA`) | 0 — the failed conditional `UPDATE` matches zero rows (see assumption A) |
| Global ceiling spent (`HEARTBEAT_GLOBAL_QUOTA`) | 2 — owner claim + its refund |
| Concurrent resource-race loser (refunded, then 404/401/`HEARTBEAT_TOO_SOON`) | 4 — two claims + two refunds |

Counting assumptions (no explicit official sentence found for either;
checked pricing, limits, billing, return-object, metrics-analytics, FAQ,
release-note, query and index docs):

- **A.** A conditional `UPDATE` matching zero rows writes zero rows —
  inferred from "rows written measure how many rows were written".
- **B.** Bucket `INSERT`s are counted as one row plus the documented
  indexed-column entries; amortized to ~0 per heartbeat either way.

### Per owner per day at the placeholder defaults

500/hour × 24 h = 12,000 accepted heartbeats/day max per owner → × 3 rows =
**≈36,000 rows/day per maxed-out owner** (+ ~300 rows hourly overhead).
The per-resource 25s window binds small fleets further: one resource can
accept at most 144/hour (3,456/day) however high the budgets are.

### Worst case across N accounts

The global ceiling binds before any per-owner sum can: 1,000/hour × 24 h =
24,000 accepted heartbeats/day deployment-wide → × 3 rows =
**≈72,000 rows/day (+ ~1k overhead), independent of N**.
(Before this change the total was unbounded in N: only the 25s/resource
window and the 100-resources/owner cap applied.)

| Tier | Allowance (source) | Worst case ≈73k rows/day |
|---|---|---|
| Workers Free | 100,000 rows written/day, reset 00:00 UTC daily; over-limit queries fail | Fits with ~27% headroom at placeholder defaults — headroom that must also cover non-heartbeat writes (registrations, keys, grants, sessions) |
| Workers Paid | first 50M rows/month included, then $1.00 per million rows | ≈2.2M rows/month « 50M included → $0 heartbeat overage |

Related allowances (same sources): rows read 5M/day Free / 25B/month Paid;
queries per Worker invocation 50 Free / 1000 Paid (heartbeat intake issues
~10 statements, all counted as one batch-equivalent at most); storage and
database-count limits are unaffected by this change.

Sources (fetched as Markdown 2026-10-29):

- D1 pricing, allowances, resets, counting rules:
  <https://developers.cloudflare.com/d1/platform/pricing/> ("Last updated
  Apr 21, 2026")
- D1 limits (queries/invocation, sizes):
  <https://developers.cloudflare.com/d1/platform/limits/> ("Last updated
  Oct 24, 2026")
- `SELECT` writes zero rows + billing uses rowsRead/rowsWritten only:
  <https://developers.cloudflare.com/d1/worker-api/return-object/> and
  <https://developers.cloudflare.com/d1/observability/metrics-analytics/>
  (both "Last updated Apr 21, 2026")
- Intake write shape: inspected `website/src/worker.js` heartbeat route,
  `website/src/lib/quotas.js` claims, `website/migrations/0002_app.sql`
  (index list) and `0005_write_budget.sql` (counter table) on this branch.

## Migration 0013: compatibility evidence only

`website/migrations/0013_heartbeat_binding.sql` is kept **byte-identical**:
no counter table was added (budgets reuse `write_budget`), no ordering
change was made, and no remote migration-journal read was performed. The
local suite applies 0001–0005 + 0013 in filename order
(`MIGRATION_FILES` in `website/tests/d1-shim.mjs`, pinned by
`website/tests/migrations.test.mjs`). The production merge/apply order and
the read-only check of the remote D1 migration journal belong to release
review and Peter — deliberately untouched here.

## Follow-ups (not in this slice)

- The `grant-resource` selector, the Compute list, and the Overview
  ready-count still render a single 50-item page — the same pre-existing
  main-branch limit the review noted. Only the `key-resource` selector was
  moved to `allInventory()` here.
- Production quota tuning for real sender fleets (cadence guidance: senders
  should stay at or above the 25s/resource window; tighter budgets trade
  fleet size against Free-tier headroom per the table above).
- `GET /api/shared-with-me` returns grant rows, not resource cards, so it
  carries no liveness display fields — pinned by
  `website/tests/heartbeat-freshness.test.mjs`.

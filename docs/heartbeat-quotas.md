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

- Both limits count **accepted heartbeats only**, and a rejected heartbeat
  writes **zero rows**. Admission is one D1 batch (a transaction) that
  moves the resource row and both counters together or not at all, so
  there is nothing to claim early and nothing to refund.
- History: `3d93c31` claimed owner then global and refunded on rejection,
  which let a spent global bucket loop writes (Codex r4407568064).
  `1112493` dropped the refunds, but separate owner and global claims still
  let requests that lost the global race at cap−1 write their owner counter
  (Codex PRRT_kwDOVYKI0c6xZvYv: owner=10, global=1). The single batch
  removes both.
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
2. Read-only fast paths, no writes: a closed 25s window returns
   `429 HEARTBEAT_TOO_SOON`; a spent global bucket returns
   `429 HEARTBEAT_GLOBAL_QUOTA`; a spent owner bucket returns
   `429 HEARTBEAT_OWNER_QUOTA`. Each 429 carries `Retry-After` and a matching
   `retryAfterSec` body field. These are optimizations only; step 4 decides.
3. While the current hour's global bucket does not exist yet, past `hb/`
   buckets are pruned (deletes rows only once per hour boundary; zero rows
   on every later call).
4. One batch, in order:
   1. `UPDATE resources SET heartbeat_at, online, usable WHERE …` with every
      intake check (ownership, owner not disabled, key bound/live, 25s
      window) **and** both caps (`COALESCE(owner count, 0) < owner cap AND
      COALESCE(global count, 0) < global cap`).
   2. Owner counter upsert `… SELECT ?, ?, 1 WHERE changes() = 1 ON CONFLICT
      DO UPDATE SET count = count + 1`.
   3. Global counter upsert, same shape, chained on the owner upsert.
5. If the resource UPDATE changed one row: `200` (the worker also asserts
   both counters changed). Otherwise nothing was written; read-only probes
   name the reason (global cap, owner cap, then the existing
   key/resource/owner/window mapping).

D1 runs a batch as one transaction, so racers serialize. Real local D1
tests (`website/tests/heartbeat-admission-d1.test.mjs`) hold every racer at
the batch until all have passed the read-only probes, then assert both
counter deltas, resource writes and D1-reported `rows_written`:

- Codex's repro (global cap 1, owner cap 500, ten same-owner resources):
  owner = global = accepted = 1. On `1112493` the same test records owner 10.
- Two owners × six resources at global cap−1: one accepted, owner deltas
  sum to 1, exactly one batch wrote rows (on `1112493`: owner deltas 12).
- Eight same-owner resources at owner cap−1: one accepted, the global bucket
  moved by exactly one.
- Revoked key, expired key, disabled owner, resource moved to another owner:
  zero rows written over 20 attempts each, no counter moved.

## Write cost (D1 rows written)

Counting rules come from the Cloudflare D1 pricing source below: write ops
are `INSERT`/`UPDATE`/`DELETE`; one touched row is one written row
regardless of size; a write touching an indexed column adds one further
written row; `SELECT` writes zero rows.

### Per accepted heartbeat (steady state): 3 rows

| # | Statement | Rows | Why |
|---|---|---|---|
| 1 | `UPDATE resources SET heartbeat_at, online, usable` | 1 | none of the three columns is indexed (`0002` indexes `owner_id` only) |
| 2 | owner counter upsert (existing bucket) | 1 | `count` is not indexed |
| 3 | global counter upsert (existing bucket) | 1 | same |

The first accepted heartbeat of the hour per bucket inserts it instead:
real local D1 reports a new bucket as **3** rows (row, primary-key index
entry, `idx_write_budget_window` entry), i.e. 2 extra rows per owner per
hour plus 2 for the global bucket. Pruning past buckets deletes each old
bucket once. The coarse `key_verifiers.last_used_at` refresh is at most one
row per key per hour and is shared with all API-key use (it is not a
heartbeat cost and is not bounded by the heartbeat budgets).

### Per rejected heartbeat

| Path | Rows written |
|---|---|
| Auth / binding / body reject | 0 from intake; at most the coarse `last_used_at` refresh (≤1/key/hour) |
| Read-only fast paths (window, global cap, owner cap) | 0 |
| Lost admission batch (cap, window, key, owner or resource race) | 0 — measured on real local D1 |

Sustained rejection is measured, not assumed: after the global cap is
spent, 100 further heartbeats across eight keys add zero `rows_written`,
and the whole run stays within
`3 × accepted + 2 × buckets + keys` rows (assertion A below is therefore
verified for these statements on local D1).

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
**≈72,000 rows/day, plus 2 rows per active owner per hour for bucket
creation**. Rejected heartbeats add nothing. Bucket creation is bounded by
accepted heartbeats too (a bucket only appears with an accepted one): the
degenerate case is every accepted heartbeat being some owner's first of the
hour, i.e. 5 rows each, so the hard bound is
**5 × HEARTBEAT_GLOBAL_PER_HOUR × 24 + 2 × 24 rows/day ≈ 120,000 rows/day at
the 1,000 placeholder**. A realistic fleet (owners beating every 25–60 s)
sits near the 3-row figure, ≈72,000.
(Before this change the total was unbounded in N: only the 25s/resource
window and the 100-resources/owner cap applied.)

| Tier | Allowance (source) | Hard bound at placeholder 1,000/h (≈120k/day) |
|---|---|---|
| Workers Free | 100,000 rows written/day, reset 00:00 UTC daily; over-limit queries fail | **Does not fit** in the degenerate case. Recommendation: set `HEARTBEAT_GLOBAL_PER_HOUR=500` on Free (hard bound 5 × 500 × 24 ≈ 60,000/day, leaving ~40% for registrations, keys, grants and sessions) |
| Workers Paid | first 50M rows/month included, then $1.00 per million rows | ≈3.6M rows/month « 50M included → $0 heartbeat overage at 1,000/h |

Choosing the cap is an operator decision about tier and fleet size, not a
correctness question: the bound above holds for any configured value.

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

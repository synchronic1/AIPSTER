# Catalog / GGUF picker verification: candidate 0e6b608

Lane: isolated current-release catalog/picker verification. This is not an
integration or release decision. The hosted Claude owner (session_015f63kCK9CcaJyvQhkXY9aK, CLOUD222) selects the combined release candidate; Astra stood down 22:14 UTC.

- Baseline verified: `0e6b60890c736207664d122c62e39d8c4affd2fa` (main, merge of #104). Checkout was clean with no drift.
- Historical PR83 head: `01fce781f6926db9023964acddfb2ddc1b570293` (ancestor of baseline).
- Verdict for this lane: **no current catalog/picker defect reproduced, so no source change.** Status: **READY (lane-scoped)**. The release verdict stays with the Claude integration owner.
- Historical PR83 is **not** relabeled PASS. Its head genuinely had the defects listed below (reproduced).
- Blocking review `5755949055` (synchronic1, CHANGES_REQUESTED on `01fce78`) still stands as a review record and was not dismissed. Its single blocking ask is addressed in current source by `28c2a77` (see section 3). Resolving or dismissing the review is a reviewer action and was not taken.

## 1. Repair mapping (historical head → current source)

| # | Defect at/after PR83 head | Repair commit (in baseline) | Current source | Linked tests (current) |
|---|---|---|---|---|
| A | Compat cache key collision: fingerprint used `variant ? variant.file : null`, so no-`file` and unresolved-`file` shared a key | `c8b539a` | `website/src/lib/catalog/estimate.mjs:153,273` (`requestedFile` in fingerprint). The worker hashes `decision.fingerprint` into `cache_key` (`website/src/worker.js` compat route) | `catalog-compat.test.mjs` "regression: an unresolved file selector cannot reuse or poison…"; `catalog-gguf-variants.test.mjs` "an unresolved selector is part of the fingerprint" |
| B | `model-fp16.gguf` parsed `unknown`, which skipped the quant restriction (fail-open) | `c8b539a` | `website/src/lib/catalog/hub.mjs:100` (`FP16` in `GGUF_QUANT_TOKEN`) | "the fp16 spelling is recognized"; "an FP16 file is blocked by a node that only reports Q4_K_M" |
| C | Standalone + split set with same base name merged → size 0 → WEIGHTS_SIZE_UNKNOWN even for an explicit standalone pick | `c8b539a` | `hub.mjs` `ggufVariants` `split:`/`single:` keying | "a standalone file and a split set with one base name stay distinct" |
| D | Duplicate selectors introduced by C's first-shard rename: a nested `-00001-of-NNNNN` set's base name equals another set's renamed first shard, so `.find` became ambiguous | `d494f11` (via PR97) | `hub.mjs` `ggufVariants` claimant disambiguation | "a nested split set keeps a unique exactly-selectable file"; "nested grouping is independent of manifest order"; "an incomplete nested set fails closed…" |
| E | No-spare nested loser still emitted a duplicate | `f39736b` (via PR99) | `hub.mjs` `dropped` set | "a no-spare nested collision emits no duplicate selector"; "exact-duplicate manifest entries fail closed" |
| F | Review 5755949055 blocker: no dashboard sender for `file`, so multi-quant repos were a UI dead end at VARIANT_UNSELECTED | `28c2a77` (picker072), merged via PR104 `0e6b608` | `website/public/app/app.js` `showAssetDetail`/`runCompat`/`runPlan`/`runExecute`; `compatPickerFor` binding | `ui-models.test.mjs` tests 76–83 (single-variant unchanged, picker escaped, unselected refuses, exact bind through compat+plan, VARIANT_NOT_FOUND, nested path, hostile name inert, stale selection cleared) |

Correction (verified by first-parent ancestry): `55e5675` is only PR104's tip
commit, a test-only deadline deflake in `website/tests/inference-demo-ui.test.mjs`.
PR104 as a merge (`0e6b608`) is what brings the picker `28c2a77` into main.
`28c2a77` is not an ancestor of `0e6b608^1`. `c8b539a` and `d494f11` came in via
PR97, and `f39736b` via PR99. So at PR granularity the repairs are PR97, PR99
and PR104, and calling PR104 a catalog repair is correct for that merge.

## 2. Bounded reproduction (pure functions, no network, no downloads)

Script (scratch, not committed): the script imports `ggufVariants`/`ggufQuant`
and `selectVariant`/`evaluateCompatibility` from a given source tree. It then
evaluates the cases below plus 4000 randomized nested-shard manifests, checking
that selectors are unique.

| Probe | 01fce78 (PR83 head) | c8b539a | d494f11 | 0e6b608 (current) |
|---|---|---|---|---|
| `ggufQuant('model-fp16.gguf')` | `unknown` (defect B) | FP16 | FP16 | `FP16` |
| standalone `m.gguf`(10) + split `m-0000{1,2}-of-00002`(5+5) | `m.gguf:0` merged (defect C) | distinct | distinct | `m.gguf:10, m-00001-of-00002.gguf:10` |
| + nested set `m-00001-of-00002-0000{1,2}-of-00002`(7+7) | merged | **duplicate `m-00001-of-00002.gguf`** (defect D) | unique | unique, each sized |
| fingerprint.file, no file vs `nope.gguf` | `null` / `null` (defect A) | n/a | n/a | `null` / `nope.gguf` |
| multi-variant, no file | VARIANT_UNSELECTED | | | VARIANT_UNSELECTED (unknown, never a silent pick) |
| unknown file | VARIANT_NOT_FOUND | | | VARIANT_NOT_FOUND (block) |
| unsized file bytes | 0 | | | 0 (fail-closed, WEIGHTS_SIZE_UNKNOWN) |

The randomized generator found 0/4000 duplicate selectors on every tree,
including c8b539a. So it is too weak to catch defect D by itself. The
deterministic nested case is what demonstrates D and its repair.

## 3. Measured focused tests at exact head 0e6b608

Command (from `website/`, after `npm ci --ignore-scripts` from the committed lockfile, no tree change):

```
node --test tests/catalog-gguf-variants.test.mjs tests/catalog-compat.test.mjs \
  tests/catalog-capabilities.test.mjs tests/catalog-search.test.mjs tests/ui-models.test.mjs
```

Result: **85 tests, 85 pass, 0 fail, 0 skipped** (~4.5 s, Node v22.23.4).
Every test from section 1 is included. The capability tests also pass,
including "strict body: unknown fields, bad shapes, and oversize fail closed",
so malformed capability reports are still rejected.

Not run (out of lane / by instruction): full website suite, `npm run check`,
real-D1, installer, model download, live inference, Hub network calls.

## 4. Unresolved limits (documented, not changed)

1. **F16 vs FP16 labels are not normalized.** `ggufQuant` returns `F16` for
   `-f16` and `FP16` for `-fp16`, and tests pin both labels (the c8b539a
   commit message's "both spellings yield FP16" overstates it). A node that
   reports `F16` evaluating a `-fp16` file gets `QUANT_NOT_REPORTED`. That is a
   fail-closed false block, never a false admit. Normalizing would change
   public `variant.quant` / fingerprint values and cached keys, so it is left
   for a reviewed follow-up.
2. Review 5755949055's non-blocking follow-ups are not addressed: the KV-cache
   estimate still assumes a 7B shape, and the search-page compat `format` is
   `unknown` without a detail lookup.
3. Variants dropped for having no spare shard (PR99) are unreachable by
   design. The shared selector resolves to the owning entry.
4. The picker appears only when `variants.length > 1`. A single-variant asset
   is auto-selected server-side (`selectVariant`), which matches the test
   "single-variant asset keeps the unchanged path".
5. The UI was verified through the jsdom-style `ui-models` harness, not a real
   browser session.

## 5. Handoff

- Candidate SHA verified: `0e6b60890c736207664d122c62e39d8c4affd2fa`
- Evidence reused: none (fresh run this session)
- New checks: focused 5-file catalog/picker run 85/85 pass; bounded repro (section 2) on 4 trees
- Files changed: this report only. No catalog source/test, workflow, release script, registry, schema, onboarding or native-worker edits.
- Competing author on the catalog lane: none found. Remote branches `fix/catalog-compat-defects-20261103` (at merged `f39736b`) and `muse/model-catalog` (`a9c65b6`) exist. Neither was modified.
- Blockers: none in lane. Review 5755949055 remains on record (not dismissed).
- Verdict: **READY (catalog/picker lane, no code change)**. Release candidate selection belongs to the Claude integration owner (session_015f63kCK9CcaJyvQhkXY9aK).
- Overlap note: `website/public/app/app.js` is touched by open PRs 108/110. This lane made **no** `app.js` edits, so nothing from this branch needs reconciling with them, or with onboarding/auth/history.

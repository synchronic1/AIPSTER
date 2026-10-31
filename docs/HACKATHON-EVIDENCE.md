# AIPSTER hackathon evidence

Evidence checked on 2026-10-31. This packet separates the public Cloudflare
site, the local worker, and the standalone Python prototype. It does not infer
live model execution from configuration, fixtures, or screenshots.

## Demo and version tuple

| Surface | Source identity | Verification and result | Boundary |
|---|---|---|---|
| Public Cloudflare site | [deployed source](https://github.com/synchronic1/AIPSTER/tree/d1de902eb90067459615714941ea048f719d9edd/website); Worker `VERSION` `0.5.0`; site revision `2026-10-29.2` | [Production deploy run 41206389611](https://github.com/synchronic1/AIPSTER/actions/runs/41206389611) succeeded. Live [`deployment.json`](https://aipster.net/deployment.json) identifies commit `d1de902eb90067459615714941ea048f719d9edd` and source manifest SHA-256 `3e676f47c2df98588ce781954dcf3eacf6491dff9fa7bc5e02ad78b2fa278b30`. | Landing page and sign-in shell load. No authenticated session was available; no signed-in screen or live inference is claimed. |
| Current AIPSTER source | [`main` at `0430104`](https://github.com/synchronic1/AIPSTER/commit/043010469cdaa5d7e532fab93afdeca5d3520a92) | [Public site checks 41224609696](https://github.com/synchronic1/AIPSTER/actions/runs/41224609696) passed `npm run check`, `npm test`, `npm run build`, and the local Wrangler `npm run bundle` dry run. The website tree is unchanged from the deployed `d1de902`; the later main change is in `local-worker/`. | A passing build or bundle dry run is not a production deploy. |
| Standalone local worker | [`local-worker/`](https://github.com/synchronic1/AIPSTER/tree/043010469cdaa5d7e532fab93afdeca5d3520a92/local-worker); mock config [`configs/mock.toml`](https://github.com/synchronic1/AIPSTER/blob/043010469cdaa5d7e532fab93afdeca5d3520a92/local-worker/configs/mock.toml) | [Windows mock-install run 41209814151](https://github.com/synchronic1/AIPSTER/actions/runs/41209814151) passed on `5d91c1f32dbe79a1345cdb5c48d9b10332b6e0a9`, which is included in current main. It installed the worker and passed the installation and pairing test commands in CI. | The fixture uses `kind = "mock"` and model `mock-summary`; output is simulated. The [quickstart](https://github.com/synchronic1/AIPSTER/blob/043010469cdaa5d7e532fab93afdeca5d3520a92/local-worker/README.md) says this is not an AIPSTER execution connection and `/api/jobs` remains disabled. No native model or inference was tested. |
| Cloudflare DGM preview | [`preview.mjs`](https://github.com/synchronic1/AIPSTER/blob/043010469cdaa5d7e532fab93afdeca5d3520a92/website/src/dgm/preview.mjs), [`router.mjs`](https://github.com/synchronic1/AIPSTER/blob/043010469cdaa5d7e532fab93afdeca5d3520a92/website/src/dgm/router.mjs), and [API tests](https://github.com/synchronic1/AIPSTER/blob/043010469cdaa5d7e532fab93afdeca5d3520a92/website/tests/dgm-preview-api.test.mjs) | Covered by the passing public-site test run above. Tests use an in-memory D1 shim and deterministic fixtures. | The route is flag-gated (`DGM_PREVIEW_ENABLED === "1"`); every evaluation is labeled `fixture`. This is not the Python harness, live DGM evaluation, or inference. Production activation was not established. |
| Python DGM prototype | Separate local `stack/` repository, HEAD `be4cd305be29beeac35514baa8aae69ac072ea13`; dirty, no configured remote, not part of public AIPSTER main | The local `stack/README.md` gives `uv run python scripts/demo_mock.py` and `uv run pytest tests/coord -q`. Its `TASK-RESULT-NEXT.md` reports 172 passed, 0 failed, 0 skipped, 0 blocked, but does not pin that result to a clean source SHA. | The local README labels this pre-event prototype and says results use Dendrite mock workers (`simulated: true`) and no real model has run. The local tree is dirty, so the reported test result is not a clean, commit-reproducible release result. |

### CI and unresolved validation

- **Passing:** the main site checks and the Windows mock-worker check linked
  above. Both are successful runs; neither is evidence of live inference.
- **Expected failures:** none reported for these two successful CI runs.
- **Skips:** the summarized GitHub run metadata does not expose test-level skip
  counts; no skip count is asserted here.
- **Historical failure:** site-check run 41213604017 failed on an earlier
  model-catalog PR SHA (`d2f3d16`); a later check on `c271088` succeeded
  (41215470047), and current main checks succeeded. The older failure log was
  not inspected, so no root cause is asserted.
- **Not run:** no heavy local suite, live inference, model download, GPU test,
  or signed-in end-to-end test was performed for this packet.
- **Performance:** no reproducible latency, throughput, or quality benchmark
  was found. Fixture scores and model availability are not performance results.

## Meta ecosystem inventory

| Item | Evidence | What it establishes |
|---|---|---|
| Meta Llama identifiers | The separate local `stack/nodes.example.toml` allowlists `meta-llama-3.1-8b-instruct-q4_k_m` and `meta-llama-3.2-3b-instruct-q4_k_m` for example Dendrite nodes. | Configuration examples only. They do not prove that either model was downloaded, loaded, or used. The stack README explicitly says no real model has run. |
| Meta model/SDK/API in the public build | The public [`website/package.json`](https://github.com/synchronic1/AIPSTER/blob/043010469cdaa5d7e532fab93afdeca5d3520a92/website/package.json) has Better Auth, Wrangler, and `parse5`; no Meta model SDK is listed. Public worker tests and the local-worker mock config provide no execution evidence for a Meta model. | No Meta model, SDK, or API integration is verified in the deployed web build. |
| Meta Muse | Source files include `Built with Meta Muse` comments; the landing page names Meta in its hackathon sponsor strip. | Development-tool attribution and sponsor naming, not a runtime dependency or model integration. |
| Actual model execution | The public local worker fixture is `mock-summary`; the Python prototype documents Dendrite mock workers and `simulated: true`. | No actual Meta model execution is evidenced. |

The local Python prototype's history starts with commits `d2e3c47` and
`9118640` on 2026-10-21, before the 2026-10-26 hackathon kickoff. Its DGM
preview work was added locally on 2026-10-30 (`acfe5a6`, `1ad52e3`, `2ca6c69`,
`00b119f`, `be4cd30`). These local commits are not in the public AIPSTER repo.
The public site's deployed SHA and local-worker source SHA therefore do not
identify or release the separate Python harness.

## Public access and README audit

The public URLs checked were [`https://aipster.net/`](https://aipster.net/),
[`/app/`](https://aipster.net/app/), and
[`deployment.json`](https://aipster.net/deployment.json). The landing page and
sign-in shell load. A no-credential OAuth-start request returned HTTP 200 with
a redirect host of `github.com`; it was not followed and no sign-in was
completed. Unauthenticated `GET /api/inventory` and `GET /api/keys` returned
401; `GET /api/auth/get-session` returned `null`. No authorized test identity
was available, so demo login and signed-in behavior remain unverified.

**Release metadata needs owner reconciliation:** the live `deployment.json`
identifies `d1de902` but says `auth_deployed: false`. Live OAuth initiation
currently redirects to GitHub, and the live `release.json` also says
`auth_deployed: false` while naming older `source_commit` `25bf2ac`. Treat
`deployment.json` as the deployed code identity; clarify what the auth flag
means before claiming public signed-in functionality.

The README draft reviewed is Muse commit
`3fba9fac4e6da6be61b055e3650d2d14a370de2f` on `muse/demo-readme-hackathon`,
now published in [PR #54](https://github.com/synchronic1/AIPSTER/pull/54) and
not yet merged. I did not edit that branch. Its two screenshot assets and
shot-list path exist in the commit, and the screenshots visually match the
public landing and sign-in shell. No recorded video link or video asset was
present; the draft correctly offers a 60–90 second shot list and identifies
the recording/upload as the owner action. PR #54's public-site asset/build
check passed at this head
([run 41225184574](https://github.com/synchronic1/AIPSTER/actions/runs/41225184574)).

The draft keeps the Cloudflare site, local gateway console, and local Python
harness separate; the gateway implementation itself was not independently
audited in this packet. It also correctly labels the model catalog as unmerged
and the DGM preview as fixture-only. The OAuth-start and signed-out API claims
were independently reproduced above. Demo-input validation is covered by
repository tests, but was not tested against a public account.
One broader README assertion needs a public source link or qualification: the
“offline scaffold” is the separate, pre-event local `stack/` repository, which
is absent from public AIPSTER main. Its local tests should not be presented as
a public or live deployment result.

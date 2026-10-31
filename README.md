# AIPSTER

## Live demo (verified 2026-10-31)

**Working build:** [https://aipster.net/](https://aipster.net/) — deployed commit
[`d1de902`](https://github.com/synchronic1/AIPSTER/commit/d1de902eb90067459615714941ea048f719d9edd)
(site revision `2026-10-29.2`, per [deployment.json](https://aipster.net/deployment.json)).
Screenshots below are captured from that build on 2026-10-31. Repository `main`
has since advanced; unmerged work is listed under “Not in this build”.

1. Open the landing page: product direction, research diagrams, the Meta Muse
   Worldwide Hackathon sponsor strip, and a Sign in entry point.

   ![Landing page at aipster.net: wordmark, “Now you’re the ISP” hero, direction
   and research sections (captured 2026-10-31 from the deployed build).](docs/demo/landing-1440.png)

2. Choose Sign in → [`/app`](https://aipster.net/app): GitHub OAuth and a seeded
   demo login. Verified live without completing a sign-in: the OAuth handshake
   redirects to `github.com`, the demo endpoint validates input, and
   unauthenticated API calls return `401`. No authorized test identity was
   available, so signed-in screens are not shown or claimed.

   ![Control-panel sign-in screen: GitHub OAuth and demo login options, signed-out
   state (captured 2026-10-31 from the deployed build).](docs/demo/app-signin-1440.png)

3. No recorded video exists yet: follow the [60–90 second shot list](docs/demo/SHOT-LIST.md).
   Owner action: record with an authorized test identity, upload, and link it here.

**In this build:** landing page, research and LoRA diagrams, `/app` sign-in shell
(GitHub OAuth handshake + demo-login endpoint, handshake shapes verified),
authenticated API boundary (`401` without a session), federation UI shell labeled
fixture-only with no live peers, DGM fixture preview shipped flag-gated and off by
default, local-worker installer docs.
**Not in this build:** model/adapter catalog (open
[PR #50](https://github.com/synchronic1/AIPSTER/pull/50), under review), live inference,
paid compute, billing, real peer federation.

**Three separate surfaces:** this Cloudflare web app; the local gateway console (a
`localhost` preview in the private Ganglion repository, fake-backed); and the
standalone Python DGM harness (separate local work, not deployed here).

**Meta:** no Meta models, SDKs, or APIs are integrated in this build (verified by
code search 2026-10-31). Source files carry a `Built with Meta Muse` authorship
comment; the landing page names Meta among its hackathon sponsors.

## Install the standalone local worker

The [local-worker quickstart](local-worker/README.md) installs the included public
Dendrite source with pinned dependencies and a model-free mock health check.
No private repository access is required. This does not connect or enable AIPSTER
jobs; real execution remains gated. Project-owned code is licensed under
[Apache-2.0](LICENSE); see [NOTICE](NOTICE) for scope and third-party exclusions.

AIPSTER is a planned research system for running bounded, evidence-driven experiments on AI workflows. It combines IRB refinement infrastructure with an external trusted Darwin Gödel Machine (DGM) controller and archive, short Karpathy-style experiment loops, and optional JEV decision advice.

The design keeps experiments within explicit budgets and requires recorded evidence, independent evaluation, and promotion gates before promoting a change. Planned distributed inference routes whole workloads across machines; it does not split a model across them.

The offline scaffold has tested selection, probability, budget, and event controls. Live self-improvement, full JEV integration, runner containment, and production deployment have not been demonstrated. This repository documents the proposed direction; it makes no claim of frontier results.

**Proposed architecture**

![Proposed IRB/DGM architecture: bounded search, independent evaluation, optional JEV advice, and separate promotion gates.](assets/IRB-DGM-JEV-component-flow.png)

[View the editable SVG](assets/IRB-DGM-JEV-component-flow.svg)

## Model and LoRA drill-down

The proposed runtime keeps base weights resident and selects compatible, versioned LoRA adapters through a serial, request-safe switching sequence. This is not a claim of verified concurrent multi-LoRA serving; the Medina example is historical and has not been reverified.

![Proposed model and LoRA runtime: immutable resident base, versioned compatible adapters, serial switching, cache and request isolation, independent evaluation, and rollback.](assets/AIPSTER-model-LoRA-drilldown-v1.png)

[View the editable model/LoRA SVG](assets/AIPSTER-model-LoRA-drilldown.svg)

Conceptual design and offline scaffold work predate this public documentation repository. Publication dates do not establish when that earlier work occurred.
